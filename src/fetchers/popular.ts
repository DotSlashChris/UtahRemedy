/**
 * Popular-100 (owner decision 2026-10-22; docs/popular-100.md). Up to 100 extra SKUs get the same per-store refresh
 * as B1, in the same daily pass, AFTER the B1 (allocated) queue. Same guards; see perstore.ts.
 *
 * Roster: D1 table perstore_popular (migration 0007). ACTIVE list = all locked entries + best-ranked unlocked entries,
 * max POPULAR_MAX_SKUS in total. Locked entries count toward the 100; extra entries are inactive reserve (kept).
 * Locked entries can't be deleted (D1 trigger); a future weekly rotation must only touch unlocked rows.
 *
 * Daily fetch list = ACTIVE entries whose product-level statewide store qty is > 0 and that are NOT already in
 * today's B1 queue (no double fetch). Zero-qty entries (locked or not) are skipped for the day but stay in the list.
 *
 * Auto-prune (owner-approved 2026-11-05): when building today's popular queue, unlocked popular SKUs that have
 * stock (quantity > 0) in EVERY open-to-the-public DABS store are DELETE'd from perstore_popular (same path as
 * admin remove; keep_locked trigger respected). Club stores (isClubStore) do not count in the denominator or
 * numerator. Locked rows are never auto-removed. Caps, pauses, windows, retry, fail-closed, B1, stalest_first,
 * missing-store rule, and catalog pause are unchanged.
 *
 * On/off without a deploy: KV key perstore:v1:popular = "on" | "off" (missing = off). Read once per tick.
 * Skipped entirely on 3rd-Saturday drop days.
 */
import type { Meter } from "./guard";
import { logEvent } from "./store";
import { isClubStore } from "../club-store";

export const POPULAR_MAX_SKUS = 100;
export const POPULAR_FLAG_KEY = "perstore:v1:popular";
/** Owner-approved 2026-11-05: prune unlocked popular SKUs stocked in every public DABS store. */
export const AUTO_PRUNE_RULE = "all_public_stores";

export interface PopularEnv { DB: D1Database; UTAH_REMEDY_CACHE: KVNamespace }

export async function popularFlag(env: PopularEnv): Promise<"on" | "off"> {
  return (await env.UTAH_REMEDY_CACHE.get(POPULAR_FLAG_KEY)) === "on" ? "on" : "off";
}

const ACTIVE_SQL = `SELECT sku, rank, locked FROM perstore_popular ORDER BY locked DESC, rank, sku LIMIT ?`;

/** Public (non-club) store ids — shared predicate with the UI (src/club-store.ts). */
export async function publicStoreIds(db: D1Database, meter: Meter): Promise<string[]> {
  const r = await db.prepare("SELECT id, name FROM stores").all<{ id: string; name: string | null }>();
  meter.addResult(r);
  return r.results.filter((s) => !isClubStore(s.name)).map((s) => s.id);
}

/**
 * Auto-prune unlocked popular SKUs that have quantity > 0 in every public store.
 * No-op when there are zero public stores. Locked rows are never touched (DELETE ... AND locked = 0 + trigger).
 * Returns the SKUs removed (already deleted) and the public-store denominator used.
 */
export async function autoPrunePopularAllPublicStores(db: D1Database, meter: Meter): Promise<{ pruned: string[]; publicStores: number }> {
  const publicIds = await publicStoreIds(db, meter);
  const publicStores = publicIds.length;
  if (publicStores === 0) return { pruned: [], publicStores: 0 };

  const unlocked = await db.prepare("SELECT sku FROM perstore_popular WHERE locked = 0").all<{ sku: string }>();
  meter.addResult(unlocked);
  if (!unlocked.results.length) return { pruned: [], publicStores };

  // Count public stores with stock per unlocked popular SKU (join stores so orphan store_keys don't count).
  const placeholders = publicIds.map(() => "?").join(",");
  const stock = await db.prepare(
    `SELECT i.sku AS sku, COUNT(*) AS n FROM inventory_latest i
       JOIN stores s ON s.id = i.store_key
      WHERE i.store_key <> '' AND i.quantity > 0
        AND i.sku IN (SELECT sku FROM perstore_popular WHERE locked = 0)
        AND i.store_key IN (${placeholders})
      GROUP BY i.sku`,
  ).bind(...publicIds).all<{ sku: string; n: number }>();
  meter.addResult(stock);

  const pruned: string[] = [];
  for (const row of stock.results) {
    if (Number(row.n) < publicStores) continue;
    const del = await db.prepare("DELETE FROM perstore_popular WHERE sku = ? AND locked = 0").bind(row.sku).run();
    meter.addResult(del);
    if (del.meta.changes) pruned.push(row.sku);
  }
  pruned.sort();
  if (pruned.length) {
    await logEvent(
      db, meter, "perstore", "popular_auto_pruned",
      `skus=${pruned.join(",")}; public_stores=${publicStores}; rule=${AUTO_PRUNE_RULE}`,
    );
  }
  return { pruned, publicStores };
}

/** Today's popular fetch list (in fetch order: locked first, then rank), excluding B1 SKUs and zero-store-qty items. */
export async function selectPopularSkus(db: D1Database, meter: Meter, b1: string[]): Promise<{ skus: string[]; active: number; zero: number; dedup: number; pruned: number; publicStores: number }> {
  // Auto-prune first so removed SKUs never enter today's frozen queue.
  const ap = await autoPrunePopularAllPublicStores(db, meter);

  const r = await db.prepare(
    `SELECT a.sku, a.locked, COALESCE(l.store_total_qty, 0) AS st
       FROM (${ACTIVE_SQL}) a LEFT JOIN inventory_latest l ON l.sku = a.sku AND l.store_key = ''
      ORDER BY a.locked DESC, a.rank, a.sku`,
  ).bind(POPULAR_MAX_SKUS).all<{ sku: string; locked: number; st: number }>();
  meter.addResult(r);
  const inB1 = new Set(b1);
  let zero = 0, dedup = 0;
  const kept: { sku: string; st: number }[] = [];
  for (const x of r.results) {
    if (inB1.has(x.sku)) { dedup++; continue; }
    if (!(Number(x.st) > 0)) { zero++; continue; }
    kept.push({ sku: x.sku, st: Number(x.st) });
  }
  // Fetch ORDER (owner-approved 2026-11-04, "stalest_first"): membership is unchanged (locked + best-ranked, deduped,
  // zero-qty skipped); only the order changes. Never-updated first, then oldest last good per-store update, then higher
  // statewide qty, then SKU. B1 is built elsewhere and always precedes this list.
  const lastGood = await popularLastGood(db, meter);
  const skus = sortStalestFirst(kept, lastGood).map((x) => x.sku);
  return { skus, active: r.results.length, zero, dedup, pruned: ap.pruned.length, publicStores: ap.publicStores };
}

export const POPULAR_ORDER = "stalest_first";

/**
 * Last good per-store update per SKU = newest fetch_log row of kind 'perstore_detail' with status 'ok' (this includes
 * category 'missing_store_accepted_inferred', which is logged as status 'ok'). Same definition as the 2026-11-04 review.
 * fetch_log.query is "sku=<sku>;list=...[;retry=n]". One query per day (at queue build), read-only.
 */
export async function popularLastGood(db: D1Database, meter: Meter): Promise<Map<string, string>> {
  const r = await db.prepare(
    `SELECT substr(query, 5, instr(query, ';') - 5) AS sku, MAX(started_at) AS t FROM fetch_log
      WHERE kind = 'perstore_detail' AND status = 'ok' AND query LIKE 'sku=%;%' GROUP BY 1`,
  ).all<{ sku: string; t: string }>();
  meter.addResult(r);
  return new Map(r.results.map((x) => [x.sku, x.t]));
}

/** Pure sort (exported for tests): never-updated first, then oldest last-good, then statewide qty DESC, then SKU. */
export function sortStalestFirst<T extends { sku: string; st: number }>(xs: T[], lastGood: Map<string, string>): T[] {
  return [...xs].sort((a, b) => {
    const ta = lastGood.get(a.sku), tb = lastGood.get(b.sku);
    if (ta !== tb) {
      if (ta === undefined) return -1;
      if (tb === undefined) return 1;
      return ta < tb ? -1 : 1;
    }
    if (a.st !== b.st) return b.st - a.st;
    return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
  });
}

/** Counts for /health (no SKU list; public endpoint). Includes auto-prune rule + last prune summary. */
export async function popularCounts(db: D1Database) {
  const r = await db.prepare(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(locked), 0) AS locked FROM perstore_popular`,
  ).first<{ entries: number; locked: number }>();
  const entries = Number(r?.entries ?? 0), locked = Number(r?.locked ?? 0);
  const stores = await db.prepare("SELECT name FROM stores").all<{ name: string | null }>();
  const public_stores = stores.results.filter((s) => !isClubStore(s.name)).length;
  const last = await db.prepare(
    `SELECT started_at, error FROM fetch_log WHERE kind = 'perstore' AND status = 'popular_auto_pruned' ORDER BY id DESC LIMIT 1`,
  ).first<{ started_at: string; error: string | null }>();
  let last_auto_prune: { at: string; skus: string[]; count: number; public_stores: number | null } | null = null;
  if (last) {
    const m = /skus=([^;]*).*public_stores=(\d+)/.exec(last.error ?? "");
    const skus = m?.[1] ? m[1].split(",").filter(Boolean) : [];
    last_auto_prune = {
      at: last.started_at,
      skus,
      count: skus.length,
      public_stores: m?.[2] != null ? Number(m[2]) : null,
    };
  }
  return {
    entries, active: Math.min(entries, Math.max(POPULAR_MAX_SKUS, locked)), locked, max: POPULAR_MAX_SKUS,
    auto_prune_rule: AUTO_PRUNE_RULE, public_stores, last_auto_prune,
  };
}

// ---------- admin (ADMIN_TOKEN-guarded endpoints in index.ts) ----------

export async function popularList(db: D1Database) {
  const r = await db.prepare(
    `SELECT pp.sku, pp.rank, pp.locked, pp.source, pp.note, pp.added_at, pp.updated_at, p.name, p.status,
            l.store_total_qty AS statewide_store_qty, l.quantity AS warehouse_qty, l.on_order_qty
       FROM perstore_popular pp LEFT JOIN products p ON p.sku = pp.sku
       LEFT JOIN inventory_latest l ON l.sku = pp.sku AND l.store_key = ''
      ORDER BY pp.locked DESC, pp.rank, pp.sku`,
  ).all<Record<string, unknown>>();
  const all = r.results.map((x, i) => ({ ...x, locked: Number(x.locked) === 1, active: i < POPULAR_MAX_SKUS || Number(x.locked) === 1 }));
  const active = all.filter((x) => x.active);
  return {
    max: POPULAR_MAX_SKUS, entries: all.length, active_count: active.length, locked_count: all.filter((x) => x.locked).length,
    active, reserve: all.filter((x) => !x.active),
  };
}

export type AdminResult = { status: number; body: Record<string, unknown> };
const bad = (status: number, error: string): AdminResult => ({ status, body: { ok: false, error } });

export async function popularAdmin(db: D1Database, op: "lock" | "unlock" | "add" | "remove", rawSku: unknown, opts: { rank?: unknown; note?: unknown } = {}): Promise<AdminResult> {
  const s = typeof rawSku === "string" || typeof rawSku === "number" ? String(rawSku).trim() : "";
  if (!/^\d{1,6}$/.test(s)) return bad(400, "sku must be 1-6 digits");
  const sku = s.padStart(6, "0");
  const now = new Date().toISOString();
  const note = typeof opts.note === "string" ? opts.note.slice(0, 200) : null;
  const prod = await db.prepare("SELECT sku, name, status FROM products WHERE sku = ?").bind(sku).first<{ sku: string; name: string; status: string | null }>();
  const cur = await db.prepare("SELECT sku, rank, locked FROM perstore_popular WHERE sku = ?").bind(sku).first<{ sku: string; rank: number; locked: number }>();

  if (op === "lock" || op === "add") {
    if (!prod) return bad(404, `sku ${sku} is not in the catalog`);
    if (op === "lock" && !(cur && Number(cur.locked) === 1)) {
      const n = await db.prepare("SELECT COUNT(*) AS n FROM perstore_popular WHERE locked = 1").first<{ n: number }>();
      if (Number(n?.n ?? 0) >= POPULAR_MAX_SKUS) return bad(409, `already ${POPULAR_MAX_SKUS} locked entries; unlock one first`);
    }
    if (op === "add" && cur) return { status: 200, body: { ok: true, sku, name: prod.name, result: "already listed", locked: Number(cur.locked) === 1, rank: cur.rank } };
    let rank = Number(opts.rank);
    if (!Number.isInteger(rank) || rank < 1 || rank > 100000) {
      rank = cur?.rank ?? Number((await db.prepare("SELECT COALESCE(MAX(rank), 0) + 1 AS r FROM perstore_popular").first<{ r: number }>())?.r ?? 1);
    }
    await db.prepare(
      `INSERT INTO perstore_popular (sku, rank, locked, source, note, added_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET locked = MAX(locked, excluded.locked), note = COALESCE(excluded.note, note), updated_at = excluded.updated_at`,
    ).bind(sku, rank, op === "lock" ? 1 : 0, note, now, now).run();
    return { status: 200, body: { ok: true, sku, name: prod.name, catalog_status: prod.status, result: cur ? "locked" : op === "lock" ? "added and locked" : "added", note: "takes effect from the next day's queue" } };
  }
  if (!cur) return bad(404, `sku ${sku} is not in the popular list`);
  if (op === "unlock") {
    await db.prepare("UPDATE perstore_popular SET locked = 0, updated_at = ? WHERE sku = ?").bind(now, sku).run();
    return { status: 200, body: { ok: true, sku, result: Number(cur.locked) === 1 ? "unlocked" : "was not locked" } };
  }
  // remove
  if (Number(cur.locked) === 1) return bad(409, `sku ${sku} is locked; unlock it before removing`);
  await db.prepare("DELETE FROM perstore_popular WHERE sku = ? AND locked = 0").bind(sku).run();
  return { status: 200, body: { ok: true, sku, result: "removed" } };
}
