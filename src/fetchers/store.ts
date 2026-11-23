/**
 * D1 persistence with change detection.
 *  - inventory_latest holds the current value per (sku, store_key); store_key '' = product-level.
 *  - A snapshot row is written ONLY when a value changes (or replaces an inferred value).
 *  - products / stores upserts are guarded so unchanged rows write 0 rows.
 *  - A locator product write claims a row first created by the monthly catalog import (data_source 'catalog' -> NULL).
 *  - Per-store rows carry verified_at (migration 0006): advanced for EVERY store in a validated store list,
 *    changed or not; observed_at still means "last change". Only writeStoreDetail sets it, and callers must
 *    run validateStoreList first (fail closed).
 */
import type { Meter } from "./guard";
import type { Product, StoreDetail } from "./dabs-locator";

export const SOURCE = "dabs-locator";

const PRODUCT_UPSERT = `INSERT INTO products (sku, name, category, status, status_label, price_cents, size_ml, on_spa, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET name=excluded.name, category=excluded.category, status=excluded.status,
    status_label=excluded.status_label, price_cents=excluded.price_cents, size_ml=excluded.size_ml,
    on_spa=excluded.on_spa, updated_at=excluded.updated_at, data_source=NULL
  WHERE products.data_source IS NOT NULL OR products.name IS NOT excluded.name OR products.category IS NOT excluded.category
    OR products.status IS NOT excluded.status OR products.status_label IS NOT excluded.status_label
    OR products.price_cents IS NOT excluded.price_cents OR products.size_ml IS NOT excluded.size_ml
    OR products.on_spa IS NOT excluded.on_spa`;

const STORE_UPSERT = `INSERT INTO stores (id, name, address, city, phone, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, city=excluded.city,
    phone=excluded.phone, lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at
  WHERE stores.name IS NOT excluded.name OR stores.address IS NOT excluded.address OR stores.city IS NOT excluded.city
    OR stores.phone IS NOT excluded.phone OR stores.lat IS NOT excluded.lat OR stores.lng IS NOT excluded.lng`;

const SNAPSHOT_INSERT = `INSERT INTO inventory_snapshots (sku, store_id, quantity, store_total_qty, on_order_qty, source, observed_at, fetch_id, inferred)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const LATEST_UPSERT = `INSERT INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at, inferred)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sku, store_key) DO UPDATE SET quantity=excluded.quantity, store_total_qty=excluded.store_total_qty,
    on_order_qty=excluded.on_order_qty, observed_at=excluded.observed_at, inferred=excluded.inferred`;

// Per-store rows: same as LATEST_UPSERT plus verified_at (a changed value is also a verified value).
const STORE_LATEST_UPSERT = `INSERT INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at, inferred, verified_at)
  VALUES (?, ?, ?, NULL, NULL, ?, 0, ?)
  ON CONFLICT(sku, store_key) DO UPDATE SET quantity=excluded.quantity, store_total_qty=NULL, on_order_qty=NULL,
    observed_at=excluded.observed_at, inferred=0, verified_at=excluded.verified_at, inferred_reason=NULL`;

interface LatestRow { sku: string; store_key: string; quantity: number | null; store_total_qty: number | null; on_order_qty: number | null; inferred: number }

async function latestFor(db: D1Database, meter: Meter, skus: string[], storeKeys: string[] | null): Promise<Map<string, LatestRow>> {
  const out = new Map<string, LatestRow>();
  if (!skus.length) return out;
  // <= 100 bound params per query (D1 limit)
  if (storeKeys === null) {
    for (let i = 0; i < skus.length; i += 90) {
      const chunk = skus.slice(i, i + 90);
      const r = await db.prepare(`SELECT sku, store_key, quantity, store_total_qty, on_order_qty, inferred FROM inventory_latest
        WHERE store_key = '' AND sku IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<LatestRow>();
      meter.addResult(r);
      for (const row of r.results) out.set(`${row.sku}|`, row);
    }
  } else {
    const r = await db.prepare(`SELECT sku, store_key, quantity, store_total_qty, on_order_qty, inferred FROM inventory_latest WHERE sku = ?`)
      .bind(skus[0]).all<LatestRow>();
    meter.addResult(r);
    for (const row of r.results) out.set(`${row.sku}|${row.store_key}`, row);
  }
  return out;
}

/** Fail-closed guard: >= 3 SKUs that currently have stock in inventory_latest now ALL report zero. Indexed PK reads only. */
export async function looksLikeFalseZero(db: D1Database, meter: Meter, products: Product[]): Promise<string | null> {
  if (products.length < 3 || products.some((p) => p.warehouseQty + p.storeQty + p.onOrderQty > 0)) return null;
  const skus = products.slice(0, 90).map((p) => p.sku);
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM inventory_latest WHERE store_key = '' AND sku IN (${skus.map(() => "?").join(",")})
    AND COALESCE(quantity,0) + COALESCE(store_total_qty,0) > 0`).bind(...skus).first<{ n: number }>();
  return (r?.n ?? 0) >= 3 ? `all ${products.length} products report zero; ${r!.n} have stock in inventory_latest` : null;
}

export interface WriteStats { changed: number; unchanged: number }

export async function writeProducts(db: D1Database, meter: Meter, products: Product[], fetchId: number | null, observedAt: string): Promise<WriteStats> {
  const latest = await latestFor(db, meter, products.map((p) => p.sku), null);
  const stmts: D1PreparedStatement[] = [];
  let changed = 0;
  for (const p of products) {
    stmts.push(db.prepare(PRODUCT_UPSERT).bind(p.sku, p.name, p.category, p.statusCode, p.statusLabel, p.priceCents, p.sizeMl, p.onSpa ? 1 : 0, observedAt));
    const l = latest.get(`${p.sku}|`);
    if (l && !l.inferred && l.quantity === p.warehouseQty && l.store_total_qty === p.storeQty && l.on_order_qty === p.onOrderQty) continue;
    changed++;
    stmts.push(db.prepare(SNAPSHOT_INSERT).bind(p.sku, null, p.warehouseQty, p.storeQty, p.onOrderQty, SOURCE, observedAt, fetchId, 0));
    stmts.push(db.prepare(LATEST_UPSERT).bind(p.sku, "", p.warehouseQty, p.storeQty, p.onOrderQty, observedAt, 0));
  }
  for (let i = 0; i < stmts.length; i += 100) meter.addResult(await db.batch(stmts.slice(i, i + 100)));
  return { changed, unchanged: products.length - changed };
}

/** Outcome of the fail-closed completeness check. kind 'missing' = the ONLY problem is absent stores (owner rule 2026-11-02). */
export type StoreListCheck =
  | { kind: "ok" }
  | { kind: "duplicate" | "no_statewide"; error: string }
  | { kind: "qty_mismatch"; dir: "above" | "below"; sum: number; statewide: number; error: string }
  | { kind: "missing"; missing: string[]; sum: number; statewide: number; error: string };

/**
 * Fail-closed completeness check for a parsed store list, BEFORE anything is written. Rules, in order:
 *  - no duplicate store ids;
 *  - a product-level statewide store count must exist to cross-check against;
 *  - sum of per-store qty must EQUAL the product-level statewide store_total_qty (the prototype matched exactly;
 *    B1 runs overnight right after the sweep refreshed that number, while stores are closed);
 *  - no store we currently hold with qty > 0 for this SKU may be missing from the list.
 * Any failure = do not write, do not verify. The ONE exception (owner-approved 2026-11-02) is applied by the per-store pass, not
 * here: kind 'missing' (all other checks passed) can be accepted when the same stores were absent the previous Utah day
 * (perstore.ts, writeInferredMissing). Otherwise missing stores are never written as 0; they go stale after 36 h.
 * `missing` lists ALL absent stores (sorted); the error text keeps its old format (first 10 ids).
 */
export async function checkStoreList(db: D1Database, meter: Meter, d: StoreDetail): Promise<StoreListCheck> {
  const ids = new Set(d.stores.map((s) => s.id));
  if (ids.size !== d.stores.length) return { kind: "duplicate", error: `duplicate store ids in list (${d.stores.length} rows, ${ids.size} unique)` };
  const r = await db.prepare("SELECT store_key, quantity, store_total_qty FROM inventory_latest WHERE sku = ?").bind(d.sku)
    .all<{ store_key: string; quantity: number | null; store_total_qty: number | null }>();
  meter.addResult(r);
  const statewide = r.results.find((x) => x.store_key === "")?.store_total_qty;
  if (statewide === null || statewide === undefined) return { kind: "no_statewide", error: "no product-level statewide store count to cross-check against" };
  const sum = d.stores.reduce((a, s) => a + s.qty, 0);
  if (sum !== statewide) return { kind: "qty_mismatch", dir: sum > statewide ? "above" : "below", sum, statewide,
    error: `store list sum ${sum} != statewide store count ${statewide} (${d.stores.length} stores listed)` };
  const missing = r.results.filter((x) => x.store_key !== "" && (x.quantity ?? 0) > 0 && !ids.has(x.store_key)).map((x) => x.store_key).sort();
  if (missing.length) return { kind: "missing", missing, sum, statewide, error: `${missing.length} previously stocked store(s) missing from list: ${missing.slice(0, 10).join(",")}` };
  return { kind: "ok" };
}

/** Same check as an error string (null = valid). Used by the admin store-detail path, which never applies the 2026-11-02 exception. */
export async function validateStoreList(db: D1Database, meter: Meter, d: StoreDetail): Promise<string | null> {
  const c = await checkStoreList(db, meter, d);
  return c.kind === "ok" ? null : c.error;
}

// ---------- missing-store records (owner rule 2026-11-02) ----------
/** The previous calendar day of a 'YYYY-MM-DD' Utah day string. */
export function prevDay(day: string): string {
  const [y, m, dd] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
}
/** Absent-store set recorded for (sku, day), or null when there is no record (or it is unreadable: fail closed). */
export async function missingRecord(db: D1Database, meter: Meter, sku: string, day: string): Promise<string[] | null> {
  const r = await db.prepare("SELECT stores_json FROM perstore_missing WHERE sku = ? AND day = ?").bind(sku, day).first<{ stores_json: string }>();
  void meter;   // read only (the meter counts writes)
  if (!r) return null;
  try { const a = JSON.parse(r.stores_json); return Array.isArray(a) && a.every((x) => typeof x === "string") ? a : null; } catch { return null; }
}
export async function recordMissing(db: D1Database, meter: Meter, rec: { sku: string; day: string; missing: string[]; listed: number; sum: number;
  statewide: number; outcome: "held" | "accepted_inferred" | "empty_accepted"; fetchId: number | null }) {
  meter.addResult(await db.prepare(
    `INSERT INTO perstore_missing (sku, day, stores_json, listed, list_sum, statewide, outcome, source, fetch_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'perstore', ?, ?)
     ON CONFLICT(sku, day) DO UPDATE SET stores_json=excluded.stores_json, listed=excluded.listed, list_sum=excluded.list_sum,
       statewide=excluded.statewide, outcome=excluded.outcome, source=excluded.source, fetch_id=excluded.fetch_id, recorded_at=excluded.recorded_at`,
  ).bind(rec.sku, rec.day, JSON.stringify([...rec.missing].sort()), rec.listed, rec.sum, rec.statewide, rec.outcome, rec.fetchId, new Date().toISOString()).run());
}

const INFERRED_STORE_UPSERT = `INSERT INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at, inferred, verified_at, inferred_reason)
  VALUES (?, ?, 0, NULL, NULL, ?, 1, ?, ?)
  ON CONFLICT(sku, store_key) DO UPDATE SET quantity=0, store_total_qty=NULL, on_order_qty=NULL, observed_at=excluded.observed_at,
    inferred=1, verified_at=excluded.verified_at, inferred_reason=excluded.inferred_reason`;
/**
 * Owner rule 2026-11-02, ONLY after checkStoreList returned kind 'missing' AND every absent store was also absent the previous
 * Utah day: each absent store -> qty 0, inferred=1 (+ reason), snapshot row marked inferred. Call after writeStoreDetail.
 */
export async function writeInferredMissing(db: D1Database, meter: Meter, sku: string, stores: string[], fetchId: number | null, observedAt: string, reason: string) {
  const stmts: D1PreparedStatement[] = [];
  for (const id of stores) {
    stmts.push(db.prepare(SNAPSHOT_INSERT).bind(sku, id, 0, null, null, SOURCE, observedAt, fetchId, 1));
    stmts.push(db.prepare(INFERRED_STORE_UPSERT).bind(sku, id, observedAt, observedAt, reason));
  }
  for (let i = 0; i < stmts.length; i += 100) meter.addResult(await db.batch(stmts.slice(i, i + 100)));
}

// ---------- empty-list rule (owner-approved 2026-11-22, t102u) ----------
/**
 * Second narrow exception to fail-closed, applied by the per-store pass ONLY to a clean, parsed, EMPTY store list (0 rows, so
 * sum 0 = statewide 0) whose only problem is stores we hold with stock. Returns null when TODAY's (America/Denver `day`) nightly
 * sweep backs it up, else the reason it does not:
 *  - sweep_state for `day` is 'complete' (every page succeeded), not degraded, vanish-to-zero not skipped, completed_at set;
 *  - the product-level row says statewide store qty 0 (seen at 0 or vanished) and was last written no later than that sweep
 *    completed (so it is the sweep's value, not a later write).
 * D1 reads only; no DABS request.
 */
export async function sweepConfirmsZero(db: D1Database, meter: Meter, sku: string, day: string): Promise<string | null> {
  void meter;   // read only (the meter counts writes)
  const sw = await db.prepare("SELECT status, degraded, vanish_skipped, completed_at FROM sweep_state WHERE day = ?").bind(day)
    .first<{ status: string; degraded: string | null; vanish_skipped: string | null; completed_at: string | null }>();
  if (!sw) return `no nightly sweep for ${day}`;
  if (sw.status !== "complete" || !sw.completed_at) return `nightly sweep ${day} not complete (${sw.status})`;
  if (sw.degraded) return `nightly sweep ${day} degraded (${sw.degraded})`;
  if (sw.vanish_skipped) return `nightly sweep ${day} skipped vanish-to-zero (${sw.vanish_skipped})`;
  const p = await db.prepare("SELECT store_total_qty, observed_at FROM inventory_latest WHERE sku = ? AND store_key = ''").bind(sku)
    .first<{ store_total_qty: number | null; observed_at: string | null }>();
  if (!p || p.store_total_qty !== 0) return `sweep statewide store count is ${p?.store_total_qty ?? "unknown"}, not 0`;
  if (!p.observed_at || p.observed_at > sw.completed_at) return "product-level row changed after the nightly sweep completed";
  return null;
}
/** Empty-list rule (2026-11-22): each held store -> qty 0, observed (inferred=0), verified now; snapshot row per store. */
export async function writeEmptyAccepted(db: D1Database, meter: Meter, sku: string, stores: string[], fetchId: number | null, observedAt: string) {
  const stmts: D1PreparedStatement[] = [];
  for (const id of stores) {
    stmts.push(db.prepare(SNAPSHOT_INSERT).bind(sku, id, 0, null, null, SOURCE, observedAt, fetchId, 0));
    stmts.push(db.prepare(STORE_LATEST_UPSERT).bind(sku, id, 0, observedAt, observedAt));
  }
  for (let i = 0; i < stmts.length; i += 100) meter.addResult(await db.batch(stmts.slice(i, i + 100)));
}

/** Write a VALIDATED store list. Changed rows: snapshot + latest upsert. Every listed store: verified_at = observedAt. */
export async function writeStoreDetail(db: D1Database, meter: Meter, d: StoreDetail, fetchId: number | null, observedAt: string): Promise<WriteStats> {
  const latest = await latestFor(db, meter, [d.sku], d.stores.map((s) => s.id));
  const stmts: D1PreparedStatement[] = [];
  const unchangedIds: string[] = [];
  let changed = 0;
  for (const s of d.stores) {
    stmts.push(db.prepare(STORE_UPSERT).bind(s.id, s.name, s.address, s.city, s.phone, s.lat, s.lng, observedAt));
    const l = latest.get(`${d.sku}|${s.id}`);
    if (l && !l.inferred && l.quantity === s.qty) { unchangedIds.push(s.id); continue; }
    changed++;
    stmts.push(db.prepare(SNAPSHOT_INSERT).bind(d.sku, s.id, s.qty, null, null, SOURCE, observedAt, fetchId, 0));
    stmts.push(db.prepare(STORE_LATEST_UPSERT).bind(d.sku, s.id, s.qty, observedAt, observedAt));
  }
  // Unchanged value re-confirmed: advance verified_at only (1 row each; column is not indexed). A store listed again is no longer
  // inferred (2026-11-02 missing-store rule): clear the flag/reason in the same row write.
  for (let i = 0; i < unchangedIds.length; i += 90) {
    const chunk = unchangedIds.slice(i, i + 90);
    stmts.push(db.prepare(`UPDATE inventory_latest SET verified_at = ?, inferred = 0, inferred_reason = NULL WHERE sku = ? AND store_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(observedAt, d.sku, ...chunk));
  }
  for (let i = 0; i < stmts.length; i += 100) meter.addResult(await db.batch(stmts.slice(i, i + 100)));
  return { changed, unchanged: unchangedIds.length };
}

/** Record SKUs that vanished from a COMPLETE, clean in-stock sweep as statewide store qty 0 (inferred). Warehouse/on-order unknown -> NULL. */
export async function writeVanished(db: D1Database, meter: Meter, skus: string[], fetchId: number | null, observedAt: string) {
  const stmts: D1PreparedStatement[] = [];
  for (const sku of skus) {
    stmts.push(db.prepare(SNAPSHOT_INSERT).bind(sku, null, null, 0, null, SOURCE, observedAt, fetchId, 1));
    stmts.push(db.prepare(LATEST_UPSERT).bind(sku, "", null, 0, null, observedAt, 1));
  }
  for (let i = 0; i < stmts.length; i += 100) meter.addResult(await db.batch(stmts.slice(i, i + 100)));
}

/** SKUs whose current product-level statewide store qty is > 0. */
export async function currentlyInStock(db: D1Database, meter: Meter): Promise<string[]> {
  const r = await db.prepare("SELECT sku FROM inventory_latest WHERE store_key = '' AND store_total_qty > 0").all<{ sku: string }>();
  meter.addResult(r);
  return r.results.map((x) => x.sku);
}

// ---------- fetch_log ----------
export async function logStart(db: D1Database, meter: Meter, kind: string, query: string, source = SOURCE): Promise<{ id: number; started: number }> {
  const started = Date.now();
  const r = await db.prepare("INSERT INTO fetch_log (source, kind, query, started_at, status) VALUES (?, ?, ?, ?, 'running') RETURNING id")
    .bind(source, kind, query, new Date(started).toISOString()).first<{ id: number }>();
  meter.addResult({ meta: { rows_written: 2 } } as unknown as D1Result); // row + index (RETURNING via first() has no meta)
  return { id: r!.id, started };
}
export async function logFinish(db: D1Database, meter: Meter, id: number, started: number,
  res: { status: string; httpStatus?: number; itemCount?: number; error?: string; responseMs?: number | null; category?: string }) {
  if (res.category) {
    // Per-store rows (migration 0011, 2026-11-02): also store the outcome category.
    meter.addResult(await db.prepare("UPDATE fetch_log SET finished_at = ?, status = ?, http_status = ?, item_count = ?, duration_ms = ?, error = ?, category = ? WHERE id = ?")
      .bind(new Date().toISOString(), res.status, res.httpStatus ?? null, res.itemCount ?? null, Date.now() - started, res.error?.slice(0, 1000) ?? null, res.category, id).run());
    return;
  }
  if (res.responseMs != null) {
    // Sweep pages (migration 0010): also store the DABS response time, excluding the politeness gap.
    meter.addResult(await db.prepare("UPDATE fetch_log SET finished_at = ?, status = ?, http_status = ?, item_count = ?, duration_ms = ?, response_ms = ?, error = ? WHERE id = ?")
      .bind(new Date().toISOString(), res.status, res.httpStatus ?? null, res.itemCount ?? null, Date.now() - started, Math.round(res.responseMs), res.error?.slice(0, 1000) ?? null, id).run());
    return;
  }
  meter.addResult(await db.prepare("UPDATE fetch_log SET finished_at = ?, status = ?, http_status = ?, item_count = ?, duration_ms = ?, error = ? WHERE id = ?")
    .bind(new Date().toISOString(), res.status, res.httpStatus ?? null, res.itemCount ?? null, Date.now() - started, res.error?.slice(0, 1000) ?? null, id).run());
}
/** One-shot log row (skips, cap trips, rejected crons). */
export async function logEvent(db: D1Database, meter: Meter, kind: string, status: string, error: string, source = SOURCE, category?: string) {
  const { id, started } = await logStart(db, meter, kind, "-", source);
  await logFinish(db, meter, id, started, { status, error, category });
}
