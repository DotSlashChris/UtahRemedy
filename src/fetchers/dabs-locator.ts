/**
 * DABS Product Locator fetcher (primary data source).
 *
 * Source: https://webapps2.abc.utah.gov/ProdApps/ProductLocatorCore (public, no login). We call the
 * same endpoints its own page calls:
 *   - POST Products/LoadProductTable  (JSON; product, SKU, status, price, warehouse/store/on-order qty)
 *   - GET  Products/GetDetailUrl?sku= (sets a TempData cookie) -> GET ProductDetail/Index (HTML; per-store qty)
 *
 * Politeness: identifying User-Agent, >= 10 s between requests (abs.utah.gov robots.txt Crawl-delay: 10),
 * per-run request cap, backoff on 429/5xx. Hard caps (kill switch, daily budget, single-run lock) live in guard.ts.
 *
 * FAIL CLOSED: any network error, non-2xx, unexpected shape, empty or suspicious result is logged to
 * fetch_log and never written to products/stores/inventory tables; the KV status is marked stale.
 */
import { Budget, BudgetExceeded, Meter, acquireLock, releaseLock, fetcherDisabledReason, kvPut, LOCK_TTL_MS } from "./guard";
import { writeProducts, writeStoreDetail, validateStoreList, looksLikeFalseZero, logStart, logFinish, logEvent } from "./store";

export const SOURCE = "dabs-locator";
export const DEFAULT_BASE = "https://webapps2.abc.utah.gov/ProdApps/ProductLocatorCore";
export const USER_AGENT = "UtahRemedyBot/0.1 (+https://utahremedy.com; independent Utah liquor availability service)";

export const MIN_GAP_MS = 10_000;          // robots.txt Crawl-delay: 10
export const MAX_REQUESTS_PER_RUN = 12;
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_S = 30 * 60;
const BACKOFF_MS = 60 * 60 * 1000;
export const KV_PREFIX = "dabs:v1:";
const STATUS_CODES = new Set(["1", "A", "D", "L", "N", "P", "S", "T", "U", "X"]);

export interface FetcherEnv {
  DB: D1Database;
  UTAH_REMEDY_CACHE: KVNamespace;
  FETCHER_ENABLED?: string;
  /** Local mock testing only. Overrides below are ignored unless this points away from the real DABS host. */
  DABS_BASE_URL?: string;
  DABS_TEST_MIN_GAP_MS?: string;
  DABS_TEST_LOCK_TTL_MS?: string;
  /** Local mock testing only: per-store retry spacing override (ms). */
  DABS_TEST_RETRY_DELAY_MS?: string;
  /** Local mock testing only: "1" treats every per-store tick as the last tick of its window (sweep 00:30-03:55 / per-store 04:00-10:55 America/Denver). */
  DABS_TEST_LAST_TICK?: string;
  /** Local mock testing only: per-request timeout override (ms) so timeout tests don't wait 20 s. */
  DABS_TEST_REQUEST_TIMEOUT_MS?: string;
  /** Local mock testing only: overrides the sweep's 30 min page rest (ms). */
  DABS_TEST_SWEEP_REST_MS?: string;
  /** Local mock testing only: overrides the sweep's 15 min streak pause (ms). */
  DABS_TEST_SWEEP_PAUSE_MS?: string;
  /** Local mock testing only: overrides the per-store 15 min streak pause (ms). */
  DABS_TEST_PERSTORE_PAUSE_MS?: string;
}

/** Effective config. Test overrides apply ONLY when DABS_BASE_URL is set to a non-DABS host (local mock). */
export function fetcherConfig(env: FetcherEnv) {
  const base = (env.DABS_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const isMock = !base.startsWith("https://webapps2.abc.utah.gov/");
  return {
    base,
    minGapMs: isMock && env.DABS_TEST_MIN_GAP_MS ? Number(env.DABS_TEST_MIN_GAP_MS) : MIN_GAP_MS,
    lockTtlMs: isMock && env.DABS_TEST_LOCK_TTL_MS ? Number(env.DABS_TEST_LOCK_TTL_MS) : LOCK_TTL_MS,
    retryDelayMs: isMock && env.DABS_TEST_RETRY_DELAY_MS ? Number(env.DABS_TEST_RETRY_DELAY_MS) : null,
    forceLastTick: isMock && env.DABS_TEST_LAST_TICK === "1",
    requestTimeoutMs: isMock && env.DABS_TEST_REQUEST_TIMEOUT_MS ? Number(env.DABS_TEST_REQUEST_TIMEOUT_MS) : REQUEST_TIMEOUT_MS,
    sweepPauseMs: isMock && env.DABS_TEST_SWEEP_PAUSE_MS ? Number(env.DABS_TEST_SWEEP_PAUSE_MS) : null,
    restMs: isMock && env.DABS_TEST_SWEEP_REST_MS ? Number(env.DABS_TEST_SWEEP_REST_MS) : null,
    perstorePauseMs: isMock && env.DABS_TEST_PERSTORE_PAUSE_MS ? Number(env.DABS_TEST_PERSTORE_PAUSE_MS) : null,
  };
}

// ---------- normalized types ----------
export interface Product {
  sku: string; name: string; sizeMl: number | null; category: string;
  statusCode: string; statusLabel: string; priceCents: number | null;
  warehouseQty: number; storeQty: number; onOrderQty: number; onSpa: boolean;
}
export interface StoreQty {
  id: string; name: string; address: string; city: string; phone: string;
  lat: number | null; lng: number | null; qty: number;
}
export interface StoreDetail {
  sku: string; statusCode: string; warehouseQty: number; onOrderQty: number;
  priceCents: number | null; stores: StoreQty[];
}
export type FetchStatus = "ok" | "cache_hit" | "http_error" | "network_error" | "invalid_shape" | "empty" | "suspicious" | "skipped" | "incomplete";

export interface ProductQuery { itemName?: string; sku?: string; inStockOnly?: boolean; length?: number }
export interface RunOptions { queries: ProductQuery[]; storeDetailSkus?: string[]; force?: boolean }

// ---------- pure validation / parsing (unit-testable) ----------
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function validateProductTable(json: unknown): Parsed<{ total: number; products: Product[] }> {
  if (!json || typeof json !== "object") return { ok: false, error: "not an object" };
  const j = json as Record<string, unknown>;
  if (!isNonNegInt(j.recordsTotal) || !isNonNegInt(j.recordsFiltered)) return { ok: false, error: "missing recordsTotal/recordsFiltered" };
  if (!Array.isArray(j.data)) return { ok: false, error: "data is not an array" };
  const products: Product[] = [];
  for (const [i, r] of (j.data as unknown[]).entries()) {
    if (!r || typeof r !== "object") return { ok: false, error: `row ${i}: not an object` };
    const row = r as Record<string, unknown>;
    if (typeof row.sku !== "string" || !/^\d{6}$/.test(row.sku)) return { ok: false, error: `row ${i}: bad sku` };
    if (typeof row.name !== "string" || !clean(row.name)) return { ok: false, error: `row ${i}: bad name` };
    if (typeof row.status !== "string") return { ok: false, error: `row ${i}: bad status` };
    const code = row.status.trim().split(/\s+/)[0];
    if (!STATUS_CODES.has(code)) return { ok: false, error: `row ${i}: unknown status code ${code}` };
    for (const k of ["warehouseQty", "storeQty", "onOrderQty"]) {
      if (!isNonNegInt(row[k])) return { ok: false, error: `row ${i}: bad ${k}` };
    }
    const price = row.currentPrice;
    if (price !== null && price !== undefined && (typeof price !== "number" || !(price >= 0) || price > 100000)) {
      return { ok: false, error: `row ${i}: bad currentPrice` };
    }
    const name = clean(row.name);
    const size = name.match(/(\d+(?:\.\d+)?)\s*ml$/i);
    products.push({
      sku: row.sku, name, sizeMl: size ? Math.round(Number(size[1])) : null,
      category: typeof row.displayGroup === "string" ? clean(row.displayGroup) : "",
      statusCode: code, statusLabel: clean(row.status.trim().slice(code.length)),
      priceCents: typeof price === "number" ? Math.round(price * 100) : null,
      warehouseQty: row.warehouseQty as number, storeQty: row.storeQty as number, onOrderQty: row.onOrderQty as number,
      onSpa: row.onSpa === true,
    });
  }
  if (products.length > (j.recordsFiltered as number)) return { ok: false, error: "more rows than recordsFiltered" };
  return { ok: true, value: { total: j.recordsFiltered as number, products } };
}

const stripTags = (s: string) => clean(s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " "));

export function parseStoreDetail(html: string, expectedSku: string): Parsed<StoreDetail> {
  const head = html.match(/<span>(\d{6})<\/span>\s*<span>\s*\|\s*<\/span>\s*<span>([^<]+)<\/span>/);
  if (!head) return { ok: false, error: "product header not found" };
  if (head[1] !== expectedSku) return { ok: false, error: `sku mismatch: page shows ${head[1]}, expected ${expectedSku}` };
  const code = head[2].trim().split(/\s+/)[0];
  if (!STATUS_CODES.has(code)) return { ok: false, error: `unknown status code ${code}` };
  const wh = html.match(/>\s*(\d+)\s*<\/span>\s*<span[^>]*>\s*At Warehouse/);
  const oo = html.match(/>\s*(\d+)\s*<\/span>\s*<span[^>]*>\s*On Order/);
  if (!wh || !oo) return { ok: false, error: "warehouse/on-order quantities not found" };
  const price = html.match(/\$([\d,]+\.\d{2})/);

  const tableStart = html.indexOf('id="storeTable"');
  const stores: StoreQty[] = [];
  if (tableStart >= 0) {
    const body = html.slice(tableStart).match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!body) return { ok: false, error: "storeTable has no tbody" };
    for (const tr of body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      if (cells.length !== 7) return { ok: false, error: `store row has ${cells.length} cells` };
      const [id, name, address, city, phone, qtyS] = cells.slice(0, 6).map(stripTags);
      const qty = Number(qtyS);
      if (!/^\d{3,4}$/.test(id)) return { ok: false, error: `bad store id ${id}` };
      if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: `bad store qty ${qtyS}` };
      const ll = cells[6].match(/q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      stores.push({ id, name, address, city, phone, qty, lat: ll ? Number(ll[1]) : null, lng: ll ? Number(ll[2]) : null });
    }
  } else if (!/No\s+stores|not\s+(currently\s+)?(available|in stock)/i.test(html)) {
    // No table and no explanatory text: unknown layout -> fail closed.
    return { ok: false, error: "storeTable not found" };
  }
  return {
    ok: true,
    value: {
      sku: head[1], statusCode: code, warehouseQty: Number(wh[1]), onOrderQty: Number(oo[1]),
      priceCents: price ? Math.round(Number(price[1].replace(/,/g, "")) * 100) : null, stores,
    },
  };
}

/** Build the DataTables-style form body the locator page itself sends. */
export function productTableBody(q: ProductQuery, start = 0): URLSearchParams {
  const p = new URLSearchParams();
  p.set("draw", "1"); p.set("start", String(Math.max(0, start))); p.set("length", String(Math.min(Math.max(q.length ?? 25, 1), 50)));
  p.set("search[value]", ""); p.set("search[regex]", "false");
  p.set("order[0][column]", "0"); p.set("order[0][dir]", "asc");
  ["name", "sku", "displayGroup", "status", "warehouseQty", "storeQty", "onOrderQty", "currentPrice"].forEach((c, i) => {
    p.set(`columns[${i}][data]`, c); p.set(`columns[${i}][name]`, ""); p.set(`columns[${i}][searchable]`, "true");
    p.set(`columns[${i}][orderable]`, "true"); p.set(`columns[${i}][search][value]`, ""); p.set(`columns[${i}][search][regex]`, "false");
  });
  p.set("item_code", q.sku ?? ""); p.set("item_name", q.itemName ?? ""); p.set("category", ""); p.set("sub_category", "");
  p.set("price_min", ""); p.set("price_max", ""); p.set("on_spa", "false"); p.set("new_items", "false");
  p.set("in_stock", q.inStockOnly ? "true" : "false"); p.set("status", "");
  return p;
}

export const queryKey = (q: ProductQuery) =>
  `sku=${q.sku ?? ""}|name=${(q.itemName ?? "").toLowerCase().trim()}|instock=${q.inStockOnly ? 1 : 0}|len=${Math.min(Math.max(q.length ?? 25, 1), 50)}`;

// ---------- polite, budgeted HTTP client ----------
export class PoliteClient {
  private count = 0;
  private lastAt = 0;
  constructor(private env: FetcherEnv, private budget: Budget, private minGapMs: number,
    private fetchImpl: typeof fetch = (i, init) => fetch(i, init), private maxRequests = MAX_REQUESTS_PER_RUN) {}

  get requests() { return this.count; }
  /** Wall time (ms) of the most recent DABS request: send -> response headers, or -> error/timeout. Excludes the politeness gap. */
  lastResponseMs: number | null = null;

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.count >= this.maxRequests) throw new Error("per-run request cap reached");
    // Cross-invocation spacing: read once per run (written once at end of run, not per request).
    if (!this.lastAt) this.lastAt = Number(await this.env.UTAH_REMEDY_CACHE.get(`${KV_PREFIX}last_request_at`)) || 1;
    const wait = this.lastAt + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await this.budget.reserveRequest(); // throws BudgetExceeded -> caller stops
    this.count++;
    this.lastAt = Date.now();
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    if (!headers.has("Accept")) headers.set("Accept", "application/json, text/html;q=0.9");
    const t0 = Date.now();
    this.lastResponseMs = null;
    try {
      return await this.fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(fetcherConfig(this.env).requestTimeoutMs) });
    } finally { this.lastResponseMs = Date.now() - t0; }
  }

  /** Persist last request time once per run. */
  async persist(meter: Meter) {
    if (this.count > 0) await kvPut(this.env.UTAH_REMEDY_CACHE, meter, `${KV_PREFIX}last_request_at`, String(this.lastAt), { expirationTtl: 3600 });
  }
}

// ---------- shared helpers ----------
const nowIso = () => new Date().toISOString();

export async function setStatus(env: FetcherEnv, meter: Meter, ok: boolean, status: string, error?: string) {
  const key = `${KV_PREFIX}status`;
  const prev = (await env.UTAH_REMEDY_CACHE.get<Record<string, unknown>>(key, "json")) ?? {};
  const next = ok
    ? { ...prev, last_ok_at: nowIso(), last_attempt_at: nowIso(), last_status: status, last_error: null, stale: false }
    : { ...prev, last_attempt_at: nowIso(), last_status: status, last_error: error ?? null, stale: true };
  await kvPut(env.UTAH_REMEDY_CACHE, meter, key, JSON.stringify(next));
}
export async function getSourceStatus(kv: KVNamespace) {
  return kv.get<Record<string, unknown>>(`${KV_PREFIX}status`, "json");
}
export async function inBackoff(env: FetcherEnv): Promise<number> {
  const b = Number(await env.UTAH_REMEDY_CACHE.get(`${KV_PREFIX}backoff_until`)) || 0;
  return b > Date.now() ? b : 0;
}
/**
 * Temporary server-side errors (500/502/503/504 and Cloudflare 520-527). The per-store pass retries these later in the
 * same window instead of tripping the 1 h backoff (perstore.ts). 429 and every other status keep the hard backoff.
 */
export const TRANSIENT_5XX = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);
export const isTransient5xx = (status: number | undefined) => status !== undefined && TRANSIENT_5XX.has(status);

/**
 * Start the DABS backoff (KV), 1 h by default (429/5xx hard errors).
 * The nightly sweep and the per-store pass pass a shorter pause for their 3-distinct-in-a-row streak
 * (SWEEP_STREAK_PAUSE_MS / PERSTORE_STREAK_PAUSE_MS, 15 min).
 */
export async function startBackoff(env: FetcherEnv, meter: Meter, ms: number = BACKOFF_MS) {
  await kvPut(env.UTAH_REMEDY_CACHE, meter, `${KV_PREFIX}backoff_until`, String(Date.now() + ms), { expirationTtl: 7200 });
}
/** softTransient (per-store pass only): a transient 5xx does NOT start the global backoff; the caller requeues instead. */
export async function maybeBackoff(env: FetcherEnv, meter: Meter, status: number, softTransient = false) {
  if (softTransient && isTransient5xx(status)) return;
  if (status === 429 || status >= 500) await startBackoff(env, meter);
}

export type TableOutcome =
  | { ok: true; total: number; products: Product[]; httpStatus: number }
  | { ok: false; status: FetchStatus; error: string; httpStatus?: number; itemCount?: number; timeout?: boolean };

/**
 * True only for OUR request timeout: AbortSignal.timeout() rejects fetch with a DOMException named "TimeoutError".
 * Nothing else counts (no other AbortError, no TypeError from connection/DNS/TLS/config problems, no bad data).
 * Used by the sweep (owner-approved 2026-10-25) and the per-store pass (owner-approved 2026-10-30) to retry a timed-out
 * request like a transient 5xx.
 */
export const isRequestTimeout = (e: unknown) => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError";

/** One LoadProductTable request + full validation. Does NOT write anything. */
export async function fetchTablePage(env: FetcherEnv, client: PoliteClient, meter: Meter, base: string, q: ProductQuery, start = 0,
  opts: { softTransient?: boolean } = {}): Promise<TableOutcome> {
  let resp: Response;
  try {
    resp = await client.request(`${base}/Products/LoadProductTable`, {
      method: "POST", body: productTableBody(q, start),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
    });
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    return { ok: false, status: "network_error", error: String(e), ...(isRequestTimeout(e) ? { timeout: true } : {}) };
  }
  if (resp.status !== 200) { await maybeBackoff(env, meter, resp.status, opts.softTransient); return { ok: false, status: "http_error", error: `HTTP ${resp.status}`, httpStatus: resp.status }; }
  if (!(resp.headers.get("Content-Type") || "").includes("application/json")) {
    return { ok: false, status: "invalid_shape", error: `unexpected content-type ${resp.headers.get("Content-Type")}`, httpStatus: 200 };
  }
  let json: unknown;
  try { json = await resp.json(); } catch (e) { return { ok: false, status: "invalid_shape", error: `JSON parse: ${e}`, httpStatus: 200 }; }
  const v = validateProductTable(json);
  if (!v.ok) return { ok: false, status: "invalid_shape", error: v.error, httpStatus: 200 };
  if (v.value.products.length === 0) return { ok: false, status: "empty", error: `no rows (recordsFiltered=${v.value.total})`, httpStatus: 200, itemCount: 0 };
  const zero = await looksLikeFalseZero(env.DB, meter, v.value.products);
  if (zero) return { ok: false, status: "suspicious", error: zero, httpStatus: 200, itemCount: v.value.products.length };
  return { ok: true, total: v.value.total, products: v.value.products, httpStatus: 200 };
}

// ---------- admin (manual) run ----------
export interface AttemptResult { kind: string; query: string; status: FetchStatus | string; httpStatus?: number; itemCount?: number; changed?: number; error?: string; fetchId?: number }

async function adminTable(env: FetcherEnv, client: PoliteClient, meter: Meter, base: string, q: ProductQuery, force: boolean): Promise<AttemptResult> {
  const key = queryKey(q);
  const res: AttemptResult = { kind: "product_table", query: key, status: "network_error" };
  const cacheKey = `${KV_PREFIX}table:${key}`;
  const { id, started } = await logStart(env.DB, meter, res.kind, key);
  res.fetchId = id;
  try {
    if (!force) {
      const cached = await env.UTAH_REMEDY_CACHE.get<{ products: Product[] }>(cacheKey, "json");
      if (cached) { Object.assign(res, { status: "cache_hit", itemCount: cached.products.length }); return res; }
    }
    const out = await fetchTablePage(env, client, meter, base, q);
    if (!out.ok) { Object.assign(res, { status: out.status, error: out.error, httpStatus: out.httpStatus, itemCount: out.itemCount }); return res; }
    res.httpStatus = out.httpStatus; res.itemCount = out.products.length;
    if (q.sku && !out.products.some((p) => p.sku === q.sku)) { Object.assign(res, { status: "invalid_shape", error: "requested sku not in result" }); return res; }
    const lastTotalKey = `${KV_PREFIX}total:${key}`;
    const lastTotal = Number(await env.UTAH_REMEDY_CACHE.get(lastTotalKey)) || 0;
    if (lastTotal >= 20 && out.total < lastTotal * 0.5) { Object.assign(res, { status: "suspicious", error: `result count dropped ${lastTotal} -> ${out.total}` }); return res; }
    const w = await writeProducts(env.DB, meter, out.products, id, nowIso());
    res.changed = w.changed;
    await kvPut(env.UTAH_REMEDY_CACHE, meter, cacheKey, JSON.stringify({ fetchedAt: nowIso(), total: out.total, products: out.products }), { expirationTtl: CACHE_TTL_S });
    if (lastTotal !== out.total) await kvPut(env.UTAH_REMEDY_CACHE, meter, lastTotalKey, String(out.total));
    res.status = "ok";
    return res;
  } finally {
    await logFinish(env.DB, meter, id, started, res);
  }
}

export type DetailOutcome =
  | { ok: true; detail: StoreDetail; httpStatus: number }
  | { ok: false; status: FetchStatus; error: string; httpStatus?: number; timeout?: boolean };

/** GetDetailUrl -> ProductDetail/Index (2 requests) + parse. Does NOT write anything. Throws BudgetExceeded. */
export async function fetchStoreDetailPage(env: FetcherEnv, client: PoliteClient, meter: Meter, base: string, sku: string,
  opts: { softTransient?: boolean } = {}): Promise<DetailOutcome> {
  if (!/^\d{6}$/.test(sku)) return { ok: false, status: "invalid_shape", error: "bad sku input" };
  let r1: Response;
  try { r1 = await client.request(`${base}/Products/GetDetailUrl?sku=${sku}`, { headers: { "X-Requested-With": "XMLHttpRequest" } }); }
  catch (e) { if (e instanceof BudgetExceeded) throw e; return { ok: false, status: "network_error", error: `GetDetailUrl: ${e}`, ...(isRequestTimeout(e) ? { timeout: true } : {}) }; }
  if (r1.status !== 200) { await maybeBackoff(env, meter, r1.status, opts.softTransient); return { ok: false, status: "http_error", error: `GetDetailUrl HTTP ${r1.status}`, httpStatus: r1.status }; }
  await r1.text();
  const cookie = r1.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c.startsWith(".AspNetCore.Mvc.CookieTempDataProvider=") && !c.endsWith("=")).join("; ");
  if (!cookie) return { ok: false, status: "invalid_shape", error: "GetDetailUrl did not set TempData cookie", httpStatus: 200 };
  let r2: Response;
  try { r2 = await client.request(`${base}/ProductDetail/Index`, { headers: { Cookie: cookie, Accept: "text/html" } }); }
  catch (e) { if (e instanceof BudgetExceeded) throw e; return { ok: false, status: "network_error", error: `ProductDetail: ${e}`, ...(isRequestTimeout(e) ? { timeout: true } : {}) }; }
  if (r2.status !== 200) { await maybeBackoff(env, meter, r2.status, opts.softTransient); return { ok: false, status: "http_error", error: `ProductDetail HTTP ${r2.status}`, httpStatus: r2.status }; }
  let html: string;
  try { html = await r2.text(); } catch (e) { return { ok: false, status: "network_error", error: `ProductDetail body: ${e}`, httpStatus: 200, ...(isRequestTimeout(e) ? { timeout: true } : {}) }; }
  const parsed = parseStoreDetail(html, sku);
  if (!parsed.ok) return { ok: false, status: "invalid_shape", error: parsed.error, httpStatus: 200 };
  return { ok: true, detail: parsed.value, httpStatus: 200 };
}

async function adminDetail(env: FetcherEnv, client: PoliteClient, meter: Meter, base: string, sku: string, force: boolean): Promise<AttemptResult> {
  const res: AttemptResult = { kind: "store_detail", query: `sku=${sku}`, status: "network_error" };
  const cacheKey = `${KV_PREFIX}detail:${sku}`;
  const { id, started } = await logStart(env.DB, meter, res.kind, res.query);
  res.fetchId = id;
  try {
    if (!/^\d{6}$/.test(sku)) { Object.assign(res, { status: "invalid_shape", error: "bad sku input" }); return res; }
    if (!force) {
      const cached = await env.UTAH_REMEDY_CACHE.get<StoreDetail>(cacheKey, "json");
      if (cached) { Object.assign(res, { status: "cache_hit", itemCount: cached.stores.length }); return res; }
    }
    const out = await fetchStoreDetailPage(env, client, meter, base, sku);
    res.httpStatus = out.httpStatus;
    if (!out.ok) { Object.assign(res, { status: out.status, error: out.error }); return res; }
    res.itemCount = out.detail.stores.length;
    // Fail closed: an incomplete / inconsistent store list writes nothing and verifies nothing.
    const bad = await validateStoreList(env.DB, meter, out.detail);
    if (bad) { Object.assign(res, { status: "incomplete", error: bad }); return res; }
    const w = await writeStoreDetail(env.DB, meter, out.detail, id, nowIso());
    res.changed = w.changed;
    await kvPut(env.UTAH_REMEDY_CACHE, meter, cacheKey, JSON.stringify(out.detail), { expirationTtl: CACHE_TTL_S });
    res.status = "ok";
    return res;
  } finally {
    await logFinish(env.DB, meter, id, started, res);
  }
}

/**
 * Manual run (admin endpoint). Same hard caps as cron: kill switch, single-run lock, daily budget.
 * Stops at the first hard failure.
 */
export async function runDabsFetch(env: FetcherEnv, opts: RunOptions, fetchImpl?: typeof fetch): Promise<{ ok: boolean; results: AttemptResult[]; blocked?: string }> {
  const disabled = await fetcherDisabledReason(env);
  if (disabled) return { ok: false, results: [], blocked: disabled };
  const cfg = fetcherConfig(env);
  const meter = new Meter();
  const holder = `admin:${crypto.randomUUID()}`;
  if (!(await acquireLock(env.DB, meter, holder, cfg.lockTtlMs))) {
    await logEvent(env.DB, meter, "run", "locked", "another run holds the lock");
    return { ok: false, results: [], blocked: "locked: another run is in progress" };
  }
  const budget = new Budget(env.DB, meter);
  const results: AttemptResult[] = [];
  try {
    try { await budget.startRun(); } catch (e) {
      if (e instanceof BudgetExceeded) { if (e.firstTrip) await logEvent(env.DB, meter, "run", "budget_exhausted", e.message); return { ok: false, results, blocked: `budget: ${e.message}` }; }
      throw e;
    }
    const backoff = await inBackoff(env);
    if (backoff) return { ok: false, results, blocked: `backoff until ${new Date(backoff).toISOString()}` };
    const client = new PoliteClient(env, budget, cfg.minGapMs, fetchImpl);
    const jobs: Array<() => Promise<AttemptResult>> = [
      ...opts.queries.slice(0, 5).map((q) => () => adminTable(env, client, meter, cfg.base, q, !!opts.force)),
      ...(opts.storeDetailSkus ?? []).slice(0, 3).map((s) => () => adminDetail(env, client, meter, cfg.base, s, !!opts.force)),
    ];
    let blocked: string | undefined;
    for (const job of jobs) {
      try {
        const r = await job();
        results.push(r);
        if (r.status !== "ok" && r.status !== "cache_hit") break; // fail closed: stop the run
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        if (e.firstTrip) await logEvent(env.DB, meter, "run", "budget_exhausted", e.message);
        blocked = `budget: ${e.message}`;
        break;
      }
    }
    const bad = results.find((r) => r.status !== "ok" && r.status !== "cache_hit");
    if (results.length) await setStatus(env, meter, !bad && !blocked, bad?.status ?? (blocked ? "budget_exhausted" : "ok"), bad?.error ?? blocked);
    await client.persist(meter);
    return { ok: !bad && !blocked, results, blocked };
  } finally {
    await releaseLock(env.DB, meter, holder);
    const trip = await budget.flush();
    if (trip?.firstTrip) await logEvent(env.DB, meter, "run", "budget_exhausted", trip.message);
  }
}
