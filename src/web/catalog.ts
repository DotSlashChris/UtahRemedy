/**
 * Read-only catalog queries for user-facing pages. NEVER calls DABS: everything comes from D1.
 *
 * Freshness model (fail closed):
 *  - inventory_latest.observed_at only moves when a value CHANGES, so it is a lower bound on when a value
 *    was last confirmed. A COMPLETE, CLEAN nightly sweep (status='complete' AND vanish_skipped IS NULL)
 *    re-confirms every product-level statewide store count at its completed_at: in-stock SKUs were seen,
 *    SKUs that dropped off were written as inferred 0, and SKUs already at 0 weren't in the in-stock list.
 *  - Warehouse / on-order counts are only re-confirmed by the sweep when the SKU was in the in-stock list
 *    (store qty > 0); otherwise we fall back to observed_at.
 *  - Per-store rows come only from VALIDATED store-detail fetches. Their freshness is verified_at (migration 0006:
 *    advanced on every validated re-check, changed or not), falling back to observed_at for rows never re-checked
 *    since 0006. A store missing from a later list keeps its old verified_at and goes stale; it is not zeroed, EXCEPT under the
 *    owner-approved 2026-11-02 rule (same stores absent two Utah days running from an otherwise clean list): qty 0, inferred = 1.
 *  - Anything older than STALE_MS is shown as "unknown (last confirmed …)", never as a current count.
 */

export const STALE_MS = 36 * 60 * 60 * 1000;
export const PAGE_SIZE = 20;
export const MAX_PAGES = 10;            // PAGE_SIZE * MAX_PAGES = candidate cap below
export const CANDIDATE_CAP = 200;
export const MAX_Q_LEN = 80;
const MAX_TOKENS = 6;

export const KINDS = ["spirits", "wine", "beer", "cider", "premixed", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = {
  spirits: "Spirits", wine: "Wine", beer: "Beer", cider: "Cider", premixed: "Premixed & canned cocktails", other: "Other",
};

/** DABS status codes -> plain words. Descriptions from abs.utah.gov "Product status codes"; P has no official description. */
export const STATUS: Record<string, { word: string; note: string; tone: "ok" | "warn" | "rare" | "off" }> = {
  "1": { word: "General", note: "Regular item, carried by most stores.", tone: "ok" },
  L: { word: "Limited", note: "Higher-end item sold at select stores.", tone: "ok" },
  A: { word: "Allocated", note: "Allocated in limited quantities to select stores.", tone: "rare" },
  P: { word: "Limited availability", note: "DABS lists this as limited availability.", tone: "rare" },
  T: { word: "Trial", note: "Trial or seasonal item; availability is short-term.", tone: "warn" },
  S: { word: "Special order", note: "Not stocked in stores; available by DABS special order only.", tone: "off" },
  D: { word: "Discontinued", note: "Discontinued general item; remaining stock only.", tone: "warn" },
  X: { word: "Discontinued (limited)", note: "Discontinued limited item; remaining stock at select stores.", tone: "warn" },
  U: { word: "Going unavailable", note: "DABS says this item will be unavailable shortly.", tone: "warn" },
  N: { word: "Unavailable", note: "General item that is currently unavailable.", tone: "off" },
};
export const statusInfo = (code: string | null, label: string | null) =>
  (code && STATUS[code]) || { word: label || "Unknown status", note: label ? `DABS status: ${label}` : "No status on file.", tone: "warn" as const };

export interface Meter { rowsRead: number; queries: number }
const track = <T>(m: Meter, r: D1Result<T>) => { m.rowsRead += r.meta?.rows_read ?? 0; m.queries++; return r.results; };

// ---------------- data status (global) ----------------
export interface DataStatus {
  state: "ok" | "running" | "failed" | "incomplete" | "stale" | "never";
  level: "ok" | "info" | "warn" | "bad";
  lastCleanAt: string | null;       // ISO; null = no clean full sweep yet
  latestDay: string | null;
  latestStatus: string | null;
  latestError: string | null;
  productsTracked: number;           // max(products.rowid): rows are never deleted, so this is the count
  storeLevelSkus: number;            // filled from storeCoverage() (cached separately, 1 h)
  checkedAt: string;                // when this status was computed
}

export async function dataStatus(db: D1Database, m: Meter, now = Date.now()): Promise<DataStatus> {
  const [latest, clean, counts] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT day, status, vanish_skipped, error, completed_at, updated_at FROM sweep_state ORDER BY day DESC LIMIT 1"),
    db.prepare("SELECT completed_at FROM sweep_state WHERE status = 'complete' AND vanish_skipped IS NULL ORDER BY day DESC LIMIT 1"),
    db.prepare("SELECT rowid AS products FROM products ORDER BY rowid DESC LIMIT 1"),
  ]);
  const L = track(m, latest)[0] as { day: string; status: string; vanish_skipped: string | null; error: string | null; completed_at: string | null; updated_at: string } | undefined;
  const C = track(m, clean)[0] as { completed_at: string } | undefined;
  const N = track(m, counts)[0] as { products: number | null } | undefined;
  const lastCleanAt = C?.completed_at ?? null;
  let state: DataStatus["state"] = "ok";
  if (!lastCleanAt) state = "never";
  else if (now - Date.parse(lastCleanAt) > STALE_MS) state = "stale";
  else if (L && L.status === "failed") state = "failed";
  else if (L && L.status === "running" && now - Date.parse(L.updated_at) > 2 * 3600_000) state = "incomplete";
  else if (L && L.status === "running") state = "running";
  else if (L && L.status === "complete" && L.vanish_skipped) state = "incomplete";
  const level = ({ ok: "ok", running: "info", failed: "warn", incomplete: "warn", stale: "bad", never: "warn" } as const)[state];
  return {
    state, level, lastCleanAt, latestDay: L?.day ?? null, latestStatus: L?.status ?? null,
    latestError: L?.error ?? (L?.vanish_skipped ? `gaps: ${L.vanish_skipped}` : null),
    productsTracked: N?.products ?? 0, storeLevelSkus: 0, checkedAt: new Date(now).toISOString(),
  };
}

/** Products with any per-store row (reads every per-store row once; cache it for an hour). */
export async function storeCoverage(db: D1Database, m: Meter): Promise<number> {
  const r = await db.prepare("SELECT COUNT(DISTINCT sku) AS n FROM inventory_latest INDEXED BY idx_latest_store WHERE store_key <> ''").all<{ n: number }>();
  return track(m, r)[0]?.n ?? 0;
}

// ---------------- per-product classification ----------------
export interface LatestRow { quantity: number | null; store_total_qty: number | null; on_order_qty: number | null; observed_at: string | null; inferred: number | null }
export type StockState = "in_stock" | "warehouse_only" | "out" | "stale" | "unknown";
export interface Count { value: number | null; asOf: string | null; stale: boolean }
export interface Stock { state: StockState; stores: Count; warehouse: Count; onOrder: Count; verifiedAt: string | null; inferred: boolean }

const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

export function classify(l: LatestRow | null | undefined, lastCleanAt: string | null, now = Date.now()): Stock {
  const none: Count = { value: null, asOf: null, stale: true };
  if (!l || !l.observed_at) return { state: "unknown", stores: none, warehouse: none, onOrder: none, verifiedAt: null, inferred: false };
  const verifiedAt = maxIso(l.observed_at, lastCleanAt);
  const isStale = (iso: string | null) => !iso || now - Date.parse(iso) > STALE_MS;
  const seenInSweep = (l.store_total_qty ?? 0) > 0;
  const whAt = seenInSweep ? verifiedAt : l.observed_at;
  const stores: Count = { value: l.store_total_qty, asOf: verifiedAt, stale: isStale(verifiedAt) || l.store_total_qty === null };
  const warehouse: Count = { value: l.quantity, asOf: whAt, stale: isStale(whAt) || l.quantity === null };
  const onOrder: Count = { value: l.on_order_qty, asOf: whAt, stale: isStale(whAt) || l.on_order_qty === null };
  let state: StockState;
  if (l.store_total_qty === null) state = "unknown";
  else if (stores.stale) state = "stale";
  else if (l.store_total_qty > 0) state = "in_stock";
  else if (!warehouse.stale && (l.quantity ?? 0) > 0) state = "warehouse_only";
  else state = "out";
  return { state, stores, warehouse, onOrder, verifiedAt, inferred: l.inferred === 1 };
}

// ---------------- query parsing ----------------
export interface SearchParams { q: string; kind: Kind | ""; inStock: boolean; store: string; page: number }

export function parseSearch(url: URL): SearchParams {
  const q = (url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_Q_LEN);
  const k = (url.searchParams.get("type") ?? "").toLowerCase();
  const store = normStoreId(url.searchParams.get("store") ?? "");
  const page = Math.min(Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), MAX_PAGES);
  return { q, kind: (KINDS as readonly string[]).includes(k) ? (k as Kind) : "", inStock: url.searchParams.get("stock") === "1", store, page };
}
export const normStoreId = (s: string) => (/^\d{1,4}$/.test(s.trim()) ? s.trim().padStart(4, "0") : "");
export const normSku = (s: string) => (/^\d{1,6}$/.test(s) ? s.padStart(6, "0") : "");

/** Canonical query string (used for cache keys and links). */
export function canonical(p: SearchParams, page = p.page): string {
  const u = new URLSearchParams();
  if (p.q) u.set("q", p.q.toLowerCase());
  if (p.kind) u.set("type", p.kind);
  if (p.inStock) u.set("stock", "1");
  if (p.store) u.set("store", p.store);
  if (page > 1) u.set("page", String(page));
  return u.toString();
}

/** Free text -> safe FTS5 MATCH expression (alphanumeric prefix tokens only; no user syntax reaches FTS). */
export function ftsQuery(q: string, kind: Kind | ""): string | null {
  const tokens = q.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['\u2019]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).slice(0, MAX_TOKENS).map((t) => t.slice(0, 30));
  const parts: string[] = [];
  if (tokens.length) parts.push(`{name category} : (${tokens.map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(" AND ")})`);
  if (kind) parts.push(`kind : "${kind}"`);
  return parts.length ? parts.join(" AND ") : null;
}

// ---------------- search ----------------
export interface ProductRow {
  sku: string; name: string; size_ml: number | null; price_cents: number | null; status: string | null; status_label: string | null;
  category: string | null; kind: Kind; quantity: number | null; store_total_qty: number | null; on_order_qty: number | null;
  observed_at: string | null; inferred: number | null; store_qty?: number | null; store_verified_at?: string | null;
}
export interface SearchResult { params: SearchParams; rows: ProductRow[]; hasMore: boolean; capped: boolean; mode: "fts" | "sku" | "store" | "empty" }

const SELECT_COLS = `v.sku, v.name, v.size_ml, v.price_cents, v.status, v.status_label, v.category, v.kind,
  l.quantity, l.store_total_qty, l.on_order_qty, l.observed_at, l.inferred`;

export async function search(db: D1Database, m: Meter, p: SearchParams, lastCleanAt: string | null = null, now = Date.now()): Promise<SearchResult> {
  const offset = (p.page - 1) * PAGE_SIZE;
  // "Fresh in stock" first (same rule as classify(): confirmed time = max(observed_at, last clean sweep), within STALE_MS).
  const cutoff = new Date(now - STALE_MS).toISOString();
  const freshOrder = "(COALESCE(l.store_total_qty, 0) > 0 AND MAX(COALESCE(l.observed_at, ''), ?) >= ?) DESC";
  const orderBinds = [lastCleanAt ?? "", cutoff];
  const storeJoin = p.store ? "JOIN inventory_latest ls ON ls.sku = v.sku AND ls.store_key = ? AND ls.store_key <> '' AND ls.quantity > 0" : "";
  // Per-store as-of for DISPLAY only (verified_at, falling back to observed_at). Ordering is unchanged (freshOrder).
  const storeCols = p.store ? ", ls.quantity AS store_qty, COALESCE(ls.verified_at, ls.observed_at) AS store_verified_at" : "";

  // Exact SKU (1-6 digits): primary-key lookup.
  const skuOnly = /^\d{1,6}$/.test(p.q) && !p.kind;
  if (skuOnly) {
    const r = await db.prepare(`SELECT ${SELECT_COLS}${storeCols} FROM product_search_source v ${storeJoin}
      LEFT JOIN inventory_latest l ON l.sku = v.sku AND l.store_key = '' WHERE v.sku = ?`)
      .bind(...(p.store ? [p.store] : []), normSku(p.q)).all<ProductRow>();
    const rows = track(m, r);
    if (rows.length || p.q.length === 6) return { params: p, rows, hasMore: false, capped: false, mode: "sku" };
  }
  const match = ftsQuery(p.q, p.kind);
  if (!match && p.store) {
    // Everything with stock at one store (partial index on per-store rows).
    const r = await db.prepare(`SELECT ${SELECT_COLS}, ls.quantity AS store_qty, COALESCE(ls.verified_at, ls.observed_at) AS store_verified_at
      FROM inventory_latest ls JOIN product_search_source v ON v.sku = ls.sku
      LEFT JOIN inventory_latest l ON l.sku = ls.sku AND l.store_key = ''
      WHERE ls.store_key = ? AND ls.store_key <> '' AND ls.quantity > 0 ${p.inStock ? "AND l.store_total_qty > 0" : ""}
      ORDER BY ${freshOrder}, v.name LIMIT ? OFFSET ?`).bind(p.store, ...orderBinds, PAGE_SIZE + 1, offset).all<ProductRow>();
    const rows = track(m, r);
    return { params: p, rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, capped: false, mode: "store" };
  }
  if (!match) return { params: p, rows: [], hasMore: false, capped: false, mode: "empty" };

  // Candidates: the first CANDIDATE_CAP matches in index order (rowid ~ first-seen order, which follows the
  // sweep's alphabetical paging), with filters applied INSIDE the capped set. No bm25 ranking: ranking would
  // read a size row for every match. Rows read stay bounded no matter how broad the query.
  const r = await db.prepare(`WITH c AS MATERIALIZED (
      SELECT s.rowid AS rid FROM product_search s
      ${p.inStock ? "JOIN products p0 ON p0.rowid = s.rowid JOIN inventory_latest l0 ON l0.sku = p0.sku AND l0.store_key = '' AND l0.store_total_qty > 0" : ""}
      ${p.store ? `${p.inStock ? "" : "JOIN products p0 ON p0.rowid = s.rowid"} JOIN inventory_latest ls0 ON ls0.sku = p0.sku AND ls0.store_key = ? AND ls0.store_key <> '' AND ls0.quantity > 0` : ""}
      WHERE product_search MATCH ? LIMIT ${CANDIDATE_CAP})
    SELECT ${SELECT_COLS}${storeCols}
    FROM c JOIN product_search_source v ON v.rid = c.rid ${storeJoin}
    LEFT JOIN inventory_latest l ON l.sku = v.sku AND l.store_key = ''
    ORDER BY ${freshOrder}, v.name, v.size_ml LIMIT ? OFFSET ?`)
    .bind(...(p.store ? [p.store] : []), match, ...(p.store ? [p.store] : []), ...orderBinds, PAGE_SIZE + 1, offset).all<ProductRow>();
  const rows = track(m, r);
  // Only knowable on the last page: we ran into the candidate cap.
  const capped = rows.length <= PAGE_SIZE && offset + rows.length >= CANDIDATE_CAP;
  return { params: p, rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, capped, mode: "fts" };
}

// ---------------- product detail ----------------
export interface StoreRow { id: string; name: string; address: string | null; city: string | null; phone: string | null; lat: number | null; lng: number | null; quantity: number | null;
  /** last change */ observed_at: string; /** last validated re-check (falls back to observed_at) */ verified_at: string;
  /** 1 = qty 0 inferred: absent from a clean, exactly-adding-up DABS list two Utah days running (owner rule 2026-11-02) */ inferred?: number | null }
export interface ProductDetail { product: ProductRow; stores: StoreRow[] }

export async function product(db: D1Database, m: Meter, sku: string): Promise<ProductDetail | null> {
  const [a, b] = await db.batch([
    db.prepare(`SELECT ${SELECT_COLS} FROM product_search_source v LEFT JOIN inventory_latest l ON l.sku = v.sku AND l.store_key = '' WHERE v.sku = ?`).bind(sku),
    db.prepare(`SELECT s.id, s.name, s.address, s.city, s.phone, s.lat, s.lng, i.quantity, i.observed_at, COALESCE(i.verified_at, i.observed_at) AS verified_at, i.inferred
      FROM inventory_latest i JOIN stores s ON s.id = i.store_key WHERE i.sku = ? AND i.store_key <> '' ORDER BY i.quantity DESC, s.city, s.id`).bind(sku),
  ]);
  const p = track(m, a as D1Result<ProductRow>)[0];
  if (!p) return null;
  return { product: p, stores: track(m, b as D1Result<StoreRow>) };
}

// ---------------- stores ----------------
export interface StoreInfo { id: string; name: string; address: string | null; city: string | null; phone: string | null; lat: number | null; lng: number | null }
export async function stores(db: D1Database, m: Meter): Promise<StoreInfo[]> {
  return track(m, await db.prepare("SELECT id, name, address, city, phone, lat, lng FROM stores ORDER BY city, id").all<StoreInfo>());
}
export async function store(db: D1Database, m: Meter, id: string): Promise<{ store: StoreInfo; skusChecked: number } | null> {
  const [a, b] = await db.batch([
    db.prepare("SELECT id, name, address, city, phone, lat, lng FROM stores WHERE id = ?").bind(id),
    db.prepare("SELECT COUNT(*) AS n FROM inventory_latest WHERE store_key = ? AND store_key <> ''").bind(id),
  ]);
  const s = track(m, a as D1Result<StoreInfo>)[0];
  if (!s) return null;
  return { store: s, skusChecked: (track(m, b as D1Result<{ n: number }>)[0]?.n) ?? 0 };
}

export { isClubStore, CLUB_STORE_RE } from "../club-store";
