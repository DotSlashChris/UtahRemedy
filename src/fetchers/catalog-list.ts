/**
 * Full-catalog import from the DABS monthly Product List (owner-approved 2026-10-22).
 *
 * Source: https://abs.utah.gov/shop-products/interactive-product-list/ links ONE XLSX per DABS fiscal period
 * (e.g. wp-content/uploads/Oct-2026-Product-List-FY27-P3.xlsx, ~1 MB). Columns: CSC (SKU), Description, Div/Dept/Class
 * codes + names, Size, Retail Price, Item Status, On Spa, Vendor. NO quantities. abs.utah.gov robots.txt allows all
 * with Crawl-delay: 10 (we use the shared >= 10 s PoliteClient gap).
 *
 * Cost shape: 2 DABS requests per new file (page + XLSX), at most once per month; the parsed list is staged in KV
 * (1 write) and applied to D1 in chunks with a cursor, writing ONLY new or changed catalog rows. Products the live
 * Product Locator has written (data_source NULL) are never touched: the locator is newer and authoritative.
 *
 * Same hard caps as every other fetch: kill switch / FETCHER_ENABLED, single-run lock, daily budget (requests,
 * D1 rows, KV writes, runs), backoff, fetch_log. FAIL CLOSED: any download/shape/validation problem writes nothing
 * to products and marks the period failed.
 *
 * Schedule: cron "30 18 2-8 * *" = 18:30 UTC = 11:30 MST / 12:30 MDT on days 2-8 (16:30 UTC until 2026-11-03, 14:30 UTC until
 * 2026-11-01; moved each time the per-store window was widened, now 11:00-17:55 UTC). It is clear of the sweep (07:30-10:55 UTC)
 * and per-store (11:00-17:55 UTC) windows, so it never competes for the single "dabs" run lock. 18:30 UTC is the same America/Denver
 * day as the UTC cron day in
 * both MST and MDT, so the per-Utah-month period (mtPeriod) and once-per-Utah-day gating (triedToday) behave as before.
 */
import { Budget, BudgetExceeded, Meter, acquireLock, releaseLock, fetcherDisabledReason, kvPut, mtDay } from "./guard";
import { PoliteClient, fetcherConfig, inBackoff, maybeBackoff, KV_PREFIX, type FetcherEnv } from "./dabs-locator";
import { logStart, logFinish, logEvent } from "./store";

export const CATALOG_SOURCE = "dabs-catalog";
export const CATALOG_PAGE_URL = "https://abs.utah.gov/shop-products/interactive-product-list/";
const STAGE_TTL_S = 40 * 24 * 3600;
/**
 * Catalog-only pause for the AUTOMATIC monthly import (owner-approved 2026-11-03, after 403s on Nov 2 and Nov 3).
 * The cron tick runs only when this KV key is exactly "on"; absent or anything else = paused (default paused). A paused
 * cron tick makes no DABS request, takes no lock and charges no run. It does not affect the admin {"catalogImport":true}
 * path, the sweep, per-store, any cap or the global kill switch. Re-enable: KV put catalog:v1:auto = on.
 */
export const CATALOG_AUTO_KEY = "catalog:v1:auto";
export async function catalogAutoState(kv: KVNamespace): Promise<"on" | "paused"> {
  return (await kv.get(CATALOG_AUTO_KEY)) === "on" ? "on" : "paused";
}
const MIN_ROWS = 5_000;                 // Oct 2026 list: 9,994 rows
const MIN_ROWS_VS_LAST = 0.7;           // and >= 70% of the last complete import
const MIN_INSTOCK_OVERLAP = 0.6;        // >= 60% of currently in-stock SKUs must be on the list (Oct 2026: ~86%)
const MAX_XLSX_BYTES = 15 * 1024 * 1024;
const MAX_XML_BYTES = 80 * 1024 * 1024; // zip-bomb guard (Oct 2026 sheet: 12 MB)
const BATCH = 100;                      // statements per D1 batch
const RUN_ROW_LIMIT = 120_000;          // D1 rows written per apply run
const DAY_ROW_CEILING = 200_000;        // stop applying once today's budget passes this (cap 250k), resume next tick/day
const MAX_FAILED_ATTEMPTS = 3;
const STATUS_CODES = new Set(["1", "A", "D", "L", "N", "P", "S", "T", "U", "X"]);
/** Same labels the Product Locator returns for these codes (taken from production data). */
export const STATUS_LABELS: Record<string, string> = {
  "1": "General Distribution", L: "Limited Distribution", S: "Special Order", T: "Trial Distribution",
  D: "Discontinued General Distribution", X: "Discontinued Limited Distribution",
  A: "Limited Dist with Allocated Quantity", U: "Unavailable Limited Distribution",
};
const REQUIRED = { sku: "csc", name: "description", size: "size", price: "retail price", status: "item status", spa: "on spa", cls: "class name" } as const;

export interface CatalogEnv extends FetcherEnv { DABS_CATALOG_URL?: string }
/** Compact staged row: [sku, name, category, status, priceCents, sizeMl, onSpa(0/1)] */
export type CatRow = [string, string, string, string, number | null, number | null, number];
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------- XLSX (zip + sheet XML), pure and unit-testable ----------------
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) { await reader.cancel(); throw new Error(`inflated size exceeds ${limit}`); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/** Minimal ZIP reader (central directory; stored or deflate). Returns the requested entries as text. */
export async function unzipText(buf: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (no end of central directory)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    if (usize > MAX_XML_BYTES) throw new Error(`${name}: declared size ${usize} too large`);
    if (dv.getUint32(off, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = buf.subarray(start, start + csize);
    const bytes = method === 0 ? raw : method === 8 ? await inflateRaw(raw, MAX_XML_BYTES) : null;
    if (!bytes) throw new Error(`${name}: unsupported compression ${method}`);
    out.set(name, dec.decode(bytes));
  }
  return out;
}

const decodeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const l = e.toLowerCase();
  if (l === "amp") return "&"; if (l === "lt") return "<"; if (l === "gt") return ">"; if (l === "quot") return '"'; if (l === "apos") return "'";
  return String.fromCodePoint(l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
});
const textOf = (xml: string) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** Sheet XML -> rows of cell strings (inline strings, shared strings, numbers). */
export function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let pos = 0;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d*)"/);
      const idx = ref ? colIndex(ref[1]) : pos;
      pos = idx + 1;
      const t = attrs.match(/\bt="(\w+)"/)?.[1] ?? "n";
      let v = "";
      if (t === "inlineStr") v = textOf(inner);
      else {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        v = vm ? decodeXml(vm[1]) : "";
        if (t === "s") v = shared[Number(v)] ?? "";
      }
      row[idx] = v;
    }
    rows.push(Array.from(row, (x) => x ?? ""));
  }
  return rows;
}

export async function parseXlsx(buf: Uint8Array): Promise<Parsed<string[][]>> {
  let files: Map<string, string>;
  try { files = await unzipText(buf, (n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === "xl/sharedStrings.xml"); }
  catch (e) { return { ok: false, error: `xlsx: ${e}` }; }
  const sheets = [...files.keys()].filter((n) => n.startsWith("xl/worksheets/"));
  if (sheets.length !== 1) return { ok: false, error: `xlsx: expected exactly 1 worksheet, found ${sheets.length}` };
  const ss = files.get("xl/sharedStrings.xml");
  const shared = ss ? [...ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  return { ok: true, value: sheetRows(files.get(sheets[0])!, shared) };
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Strict validation. Any bad row fails the whole list (fail closed). */
export function validateCatalog(rows: string[][]): Parsed<CatRow[]> {
  const hi = rows.findIndex((r) => clean(r[0] ?? "").toLowerCase() === "csc");
  if (hi < 0) return { ok: false, error: "header row (CSC) not found" };
  const header = rows[hi].map((h) => clean(h).toLowerCase());
  const col: Record<keyof typeof REQUIRED, number> = {} as never;
  for (const [k, name] of Object.entries(REQUIRED) as [keyof typeof REQUIRED, string][]) {
    const i = header.indexOf(name);
    if (i < 0) return { ok: false, error: `missing column "${name}"` };
    col[k] = i;
  }
  const out: CatRow[] = [];
  const seen = new Set<string>();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => !clean(c))) continue; // blank/padding rows
    const at = `row ${i + 1}`;
    const sku = clean(r[col.sku] ?? "");
    if (!/^\d{6}$/.test(sku)) return { ok: false, error: `${at}: bad CSC "${sku.slice(0, 20)}"` };
    if (seen.has(sku)) return { ok: false, error: `${at}: duplicate CSC ${sku}` };
    seen.add(sku);
    const name = clean(r[col.name] ?? "");
    if (!name || name.length > 120) return { ok: false, error: `${at}: bad description` };
    const status = clean(r[col.status] ?? "");
    if (!STATUS_CODES.has(status)) return { ok: false, error: `${at}: unknown status "${status.slice(0, 10)}"` };
    const ps = clean(r[col.price] ?? "");
    const price = ps === "" ? null : Number(ps);
    if (price !== null && !(Number.isFinite(price) && price >= 0 && price <= 100000)) return { ok: false, error: `${at}: bad price "${ps.slice(0, 20)}"` };
    const spa = clean(r[col.spa] ?? "").toLowerCase();
    if (spa !== "yes" && spa !== "no" && spa !== "") return { ok: false, error: `${at}: bad On Spa "${spa.slice(0, 10)}"` };
    const sz = clean(r[col.size] ?? "");
    const sizeMl = /^\d+(\.\d+)?$/.test(sz) ? Math.round(Number(sz)) : null;
    out.push([sku, name, clean(r[col.cls] ?? "").slice(0, 120), status, price === null ? null : Math.round(price * 100), sizeMl, spa === "yes" ? 1 : 0]);
  }
  if (out.length < MIN_ROWS) return { ok: false, error: `only ${out.length} products (< ${MIN_ROWS})` };
  return { ok: true, value: out };
}

/** Exactly one product-list XLSX link on the page; production requires https://abs.utah.gov. */
export function findXlsxUrl(html: string, pageUrl: string, mock: boolean): Parsed<string> {
  const urls = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*Product-List[^"]*\.xlsx)"/gi)) {
    try { urls.add(new URL(decodeXml(m[1]), pageUrl).toString()); } catch { /* ignore */ }
  }
  if (urls.size !== 1) return { ok: false, error: `expected exactly 1 product-list .xlsx link, found ${urls.size}` };
  const u = [...urls][0];
  if (!mock && !u.startsWith("https://abs.utah.gov/wp-content/uploads/")) return { ok: false, error: `unexpected xlsx host/path ${u}` };
  return { ok: true, value: u };
}

// ---------------- job ----------------
interface ImportRow {
  period: string; status: string; attempts: number; file_url: string | null; row_count: number | null; next_index: number;
  inserted: number; updated: number; unchanged: number; skipped_live: number; rows_written: number; updated_at: string;
}
export interface CatalogResult { action: string; period: string; detail?: string; requests?: number; inserted?: number; updated?: number; unchanged?: number; skipped_live?: number; next_index?: number; row_count?: number; rows_written?: number }

const mtPeriod = () => mtDay().slice(0, 7);
const nowIso = () => new Date().toISOString();
const stageKey = (period: string) => `${KV_PREFIX}catalog:staged:${period}`;

/**
 * One catalog tick (cron "30 18 2-8 * *" or admin {"catalogImport":true}). Per America/Denver month:
 *   - no row / waiting (not today) / failed (< 3 attempts, not today): download (page + XLSX), validate, stage, apply;
 *   - applying: continue applying from the KV stage (no DABS request);
 *   - complete: no-op (zero DABS requests).
 * cron=true (scheduled handler only): no-op unless KV catalog:v1:auto = "on" (catalog-only pause, 2026-11-03).
 * force=true (admin only) skips the once-per-day/attempt gating but never the kill switch, lock or budget.
 */
export async function runCatalogTick(env: CatalogEnv, opts: { force?: boolean; cron?: boolean } = {}, fetchImpl?: typeof fetch): Promise<CatalogResult> {
  const period = mtPeriod();
  if (opts.cron && (await catalogAutoState(env.UTAH_REMEDY_CACHE)) !== "on") {
    await logEvent(env.DB, new Meter(), "catalog", "paused", `automatic catalog import paused (KV ${CATALOG_AUTO_KEY} != on)`, CATALOG_SOURCE);
    return { action: "paused", period, detail: `automatic import paused; set KV ${CATALOG_AUTO_KEY}=on to re-enable` };
  }
  const disabled = await fetcherDisabledReason(env);
  if (disabled) return { action: "disabled", period, detail: disabled };
  const db = env.DB;
  const pre = await db.prepare("SELECT * FROM catalog_import WHERE period = ?").bind(period).first<ImportRow>();
  const today = mtDay();
  const triedToday = pre ? mtDay(new Date(pre.updated_at)) === today : false;
  if (pre && !opts.force) {
    if (pre.status === "complete") return { action: "noop", period, detail: "already complete this month" };
    if (pre.status === "waiting" && triedToday) return { action: "noop", period, detail: "waiting for a new list; already checked today" };
    if (pre.status === "failed" && (triedToday || pre.attempts >= MAX_FAILED_ATTEMPTS)) return { action: "noop", period, detail: `failed (${pre.attempts} attempts); not retrying ${triedToday ? "today" : "this month"}` };
  }
  const cfg = fetcherConfig(env);
  const meter = new Meter();
  const holder = `catalog:${crypto.randomUUID()}`;
  if (!(await acquireLock(db, meter, holder, cfg.lockTtlMs))) {
    await logEvent(db, meter, "catalog", "locked", "another run holds the lock", CATALOG_SOURCE);
    return { action: "locked", period };
  }
  const budget = new Budget(db, meter);
  try {
    try { await budget.startRun(); } catch (e) {
      if (e instanceof BudgetExceeded) { if (e.firstTrip) await logEvent(db, meter, "catalog", "budget_exhausted", e.message, CATALOG_SOURCE); return { action: "budget_exhausted", period, detail: e.message }; }
      throw e;
    }
    let st = pre;
    if (!st || st.status !== "applying") {
      if (await inBackoff(env)) return { action: "backoff", period };
      const dl = await download(env, meter, budget, cfg, period, st, fetchImpl);
      if (dl.action !== "staged") return dl;
      st = (await db.prepare("SELECT * FROM catalog_import WHERE period = ?").bind(period).first<ImportRow>())!;
    }
    return await apply(env, meter, budget, st);
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    if (e.firstTrip) await logEvent(db, meter, "catalog", "budget_exhausted", e.message, CATALOG_SOURCE);
    return { action: "budget_exhausted", period, detail: e.message };
  } finally {
    await releaseLock(db, meter, holder);
    const trip = await budget.flush();
    if (trip?.firstTrip) await logEvent(db, meter, "catalog", "budget_exhausted", trip.message, CATALOG_SOURCE);
  }
}

async function setImport(db: D1Database, meter: Meter, period: string, f: Record<string, unknown> & { status: string }) {
  const now = nowIso();
  const keys = Object.keys(f).filter((k) => k !== "status");
  meter.addResult(await db.prepare(
    `INSERT INTO catalog_import (period, status, started_at, updated_at${keys.map((k) => ", " + k).join("")})
     VALUES (?, ?, ?, ?${keys.map(() => ", ?").join("")})
     ON CONFLICT(period) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at${keys.map((k) => `, ${k} = excluded.${k}`).join("")}`,
  ).bind(period, f.status, now, now, ...keys.map((k) => (f[k] ?? null) as string | number | null)).run());
}

async function download(env: CatalogEnv, meter: Meter, budget: Budget, cfg: ReturnType<typeof fetcherConfig>, period: string, st: ImportRow | null, fetchImpl?: typeof fetch): Promise<CatalogResult & { action: string }> {
  const db = env.DB;
  const mock = !cfg.base.startsWith("https://webapps2.abc.utah.gov/");
  const pageUrl = mock && env.DABS_CATALOG_URL ? env.DABS_CATALOG_URL : CATALOG_PAGE_URL;
  const client = new PoliteClient(env, budget, cfg.minGapMs, fetchImpl, 2);
  const attempts = (st?.attempts ?? 0) + 1;
  const fail = async (status: string, error: string, http?: number, id?: number, started?: number) => {
    if (id !== undefined) await logFinish(db, meter, id, started!, { status, httpStatus: http, error });
    await setImport(db, meter, period, { status: "failed", attempts, error: `${status}: ${error}`.slice(0, 1000) });
    await client.persist(meter);
    return { action: "failed", period, detail: `${status}: ${error}`, requests: client.requests };
  };
  // 1) the product-list page -> the current XLSX link
  let { id, started } = await logStart(db, meter, "catalog_page", pageUrl, CATALOG_SOURCE);
  let resp: Response;
  try { resp = await client.request(pageUrl, { headers: { Accept: "text/html" } }); }
  catch (e) { if (e instanceof BudgetExceeded) { await logFinish(db, meter, id, started, { status: "budget_exhausted", error: e.message }); throw e; } return fail("network_error", String(e), undefined, id, started); }
  if (resp.status !== 200) { await maybeBackoff(env, meter, resp.status); return fail("http_error", `page HTTP ${resp.status}`, resp.status, id, started); }
  const link = findXlsxUrl(await resp.text(), pageUrl, mock);
  if (!link.ok) return fail("invalid_shape", link.error, 200, id, started);
  await logFinish(db, meter, id, started, { status: "ok", httpStatus: 200 });
  const fileUrl = link.value;
  // Same file as the last complete import -> DABS hasn't posted this period's list yet. No XLSX request.
  const last = await db.prepare("SELECT period, file_url, row_count FROM catalog_import WHERE status = 'complete' AND period <> ? ORDER BY period DESC LIMIT 1").bind(period).first<{ period: string; file_url: string; row_count: number }>();
  if (last && last.file_url === fileUrl) {
    await setImport(db, meter, period, { status: "waiting", attempts: st?.attempts ?? 0, file_url: fileUrl, error: `page still links ${fileUrl.split("/").pop()} (imported ${last.period})` });
    await client.persist(meter);
    return { action: "waiting", period, detail: `no new list yet (${fileUrl})`, requests: client.requests };
  }
  // 2) the XLSX
  ({ id, started } = await logStart(db, meter, "catalog_xlsx", fileUrl, CATALOG_SOURCE));
  try { resp = await client.request(fileUrl, { headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream;q=0.5" } }); }
  catch (e) { if (e instanceof BudgetExceeded) { await logFinish(db, meter, id, started, { status: "budget_exhausted", error: e.message }); throw e; } return fail("network_error", String(e), undefined, id, started); }
  if (resp.status !== 200) { await maybeBackoff(env, meter, resp.status); return fail("http_error", `xlsx HTTP ${resp.status}`, resp.status, id, started); }
  const ct = resp.headers.get("Content-Type") ?? "";
  if (!/spreadsheetml|octet-stream|zip/i.test(ct)) return fail("invalid_shape", `unexpected content-type ${ct}`, 200, id, started);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength < 100_000 || buf.byteLength > MAX_XLSX_BYTES) return fail("invalid_shape", `implausible size ${buf.byteLength} bytes`, 200, id, started);
  const sheet = await parseXlsx(buf);
  if (!sheet.ok) return fail("invalid_shape", sheet.error, 200, id, started);
  const v = validateCatalog(sheet.value);
  if (!v.ok) return fail("invalid_shape", v.error, 200, id, started);
  const list = v.value;
  if (last?.row_count && list.length < last.row_count * MIN_ROWS_VS_LAST) return fail("suspicious", `row count dropped ${last.row_count} -> ${list.length}`, 200, id, started);
  // Wrong-file guard: most SKUs currently in stock (live locator) must be on the list.
  const inStock = await db.prepare("SELECT sku FROM inventory_latest WHERE store_key = '' AND store_total_qty > 0").all<{ sku: string }>();
  if (inStock.results.length >= 500) {
    const skus = new Set(list.map((r) => r[0]));
    const hit = inStock.results.filter((r) => skus.has(r.sku)).length;
    if (hit < inStock.results.length * MIN_INSTOCK_OVERLAP) return fail("suspicious", `only ${hit}/${inStock.results.length} in-stock SKUs are on the list`, 200, id, started);
  }
  await kvPut(env.UTAH_REMEDY_CACHE, meter, stageKey(period), JSON.stringify(list), { expirationTtl: STAGE_TTL_S });
  await logFinish(db, meter, id, started, { status: "ok", httpStatus: 200, itemCount: list.length });
  await setImport(db, meter, period, {
    status: "applying", attempts, file_url: fileUrl, last_modified: resp.headers.get("Last-Modified"), etag: resp.headers.get("ETag"),
    bytes: buf.byteLength, row_count: list.length, next_index: 0, inserted: 0, updated: 0, unchanged: 0, skipped_live: 0, rows_written: 0, error: null, completed_at: null,
  });
  await client.persist(meter);
  return { action: "staged", period, requests: client.requests, row_count: list.length };
}

const INSERT = `INSERT INTO products (sku, name, category, status, status_label, price_cents, size_ml, on_spa, updated_at, data_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'catalog') ON CONFLICT(sku) DO NOTHING`;
// Only rows the catalog owns; guarded so a no-op never writes.
const UPDATE = `UPDATE products SET name = ?2, category = ?3, status = ?4, status_label = ?5, price_cents = ?6, size_ml = ?7, on_spa = ?8, updated_at = ?9
  WHERE sku = ?1 AND data_source = 'catalog' AND (name IS NOT ?2 OR category IS NOT ?3 OR status IS NOT ?4 OR status_label IS NOT ?5
    OR price_cents IS NOT ?6 OR size_ml IS NOT ?7 OR on_spa IS NOT ?8)`;

interface Existing { sku: string; name: string; category: string | null; status: string | null; status_label: string | null; price_cents: number | null; size_ml: number | null; on_spa: number | null; data_source: string | null }

async function apply(env: CatalogEnv, meter: Meter, budget: Budget, st: ImportRow): Promise<CatalogResult> {
  const db = env.DB;
  const period = st.period;
  const { id, started } = await logStart(db, meter, "catalog_apply", `${period} from=${st.next_index}`, CATALOG_SOURCE);
  const list = await env.UTAH_REMEDY_CACHE.get<CatRow[]>(stageKey(period), "json");
  if (!list || list.length !== st.row_count) {
    await logFinish(db, meter, id, started, { status: "invalid_shape", error: "staged list missing or wrong length" });
    await setImport(db, meter, period, { status: "failed", error: "staged list missing or wrong length (re-download next tick)" });
    return { action: "failed", period, detail: "staged list missing" };
  }
  const usedRow = await db.prepare("SELECT d1_rows_written FROM fetch_budget WHERE day = ?").bind(budget.day).first<{ d1_rows_written: number }>();
  const usedToday = Number(usedRow?.d1_rows_written ?? 0);
  // One read of the products table (~11k rows read) instead of per-chunk lookups.
  const ex = await db.prepare("SELECT sku, name, category, status, status_label, price_cents, size_ml, on_spa, data_source FROM products").all<Existing>();
  const existing = new Map(ex.results.map((r) => [r.sku, r]));
  const c = { inserted: st.inserted, updated: st.updated, unchanged: st.unchanged, skipped_live: st.skipped_live };
  const startRows = meter.d1Rows;
  let i = st.next_index, rowsApplied = 0, stop: string | null = null;
  const now = nowIso();
  while (i < list.length) {
    const stmts: D1PreparedStatement[] = [];
    let j = i;
    for (; j < list.length && stmts.length < BATCH; j++) {
      const [sku, name, cat, status, price, size, spa] = list[j];
      const label = STATUS_LABELS[status] ?? null;
      const e = existing.get(sku);
      if (!e) { stmts.push(db.prepare(INSERT).bind(sku, name, cat, status, label, price, size, spa, now)); c.inserted++; }
      else if (e.data_source !== "catalog") c.skipped_live++;
      else if (e.name !== name || e.category !== cat || e.status !== status || e.status_label !== label || e.price_cents !== price || e.size_ml !== size || e.on_spa !== spa) {
        stmts.push(db.prepare(UPDATE).bind(sku, name, cat, status, label, price, size, spa, now)); c.updated++;
      } else c.unchanged++;
    }
    const before = meter.d1Rows;
    if (stmts.length) meter.addResult(await db.batch(stmts));
    rowsApplied += meter.d1Rows - before;
    i = j;
    // Charge the budget as we go (throws BudgetExceeded at the 250k cap) and leave headroom for other jobs.
    const trip = await budget.flush();
    if (trip) { stop = `budget: ${trip.message}`; break; }
    if (meter.d1Rows - startRows >= RUN_ROW_LIMIT) { stop = `run row limit ${RUN_ROW_LIMIT}`; break; }
    if (usedToday + meter.d1Rows - startRows >= DAY_ROW_CEILING) { stop = `day row ceiling ${DAY_ROW_CEILING}`; break; }
  }
  const done = i >= list.length;
  await setImport(db, meter, period, {
    status: done ? "complete" : "applying", next_index: i, ...c, rows_written: st.rows_written + rowsApplied, error: stop, completed_at: done ? nowIso() : null,
  });
  await logFinish(db, meter, id, started, { status: done ? "ok" : "partial", itemCount: i - st.next_index, error: stop ?? undefined });
  return { action: done ? "complete" : "partial", period, detail: stop ?? undefined, ...c, next_index: i, row_count: list.length, rows_written: st.rows_written + rowsApplied };
}

/** Read-only summary for /health. */
export async function catalogStatus(db: D1Database) {
  return db.prepare(
    "SELECT period, status, file_url, row_count, next_index, inserted, updated, unchanged, skipped_live, rows_written, error, updated_at, completed_at FROM catalog_import ORDER BY period DESC LIMIT 1",
  ).first().catch(() => null);
}
