/**
 * Per-store refresh, option B1 ONLY (owner decision 2026-10-22): once a day, after that Mountain-time day's
 * nightly sweep is COMPLETE, fetch the per-store list (GetDetailUrl -> ProductDetail, 2 DABS requests) for every
 * status-A (allocated) SKU that shows any stock (statewide store, warehouse or on-order qty > 0). ~43 SKUs/day
 * = ~86 requests; ~202/day with the ~116-request sweep, under the 700 cap.
 *
 * Option B2 (all status-L limited items) is NOT implemented and NOT enabled. The B1 selection is hard-coded
 * to status 'A'; PERSTORE_REFRESH only accepts "allocated" (anything else = off for the whole per-store job).
 *
 * POPULAR-100 (owner decision 2026-10-22, popular.ts): after the B1 SKUs, the same daily queue continues with up
 * to 100 owner-curated popular SKUs (D1 perstore_popular; locked entries always included). Separate SKU limits
 * (B1 60, popular 100); popular SKUs already in today's B1 queue are not fetched twice; zero statewide-store-qty
 * entries are skipped for the day; popular is skipped on 3rd-Saturday drop days and when the KV flag
 * perstore:v1:popular != "on" (checked every tick, so turning it off stops popular mid-run). Cron window
 * 11:00-17:55 UTC (every 5 min, hours 11-17 UTC = 4:00-10:55 AM MST / 5:00-11:55 AM MDT; moved from 10-12 on 2026-10-27 to start
 * after the sweep's 10:55 hard stop; widened from 11-13 on 2026-11-01 and from 11-15 on 2026-11-03, owner-approved, caps unchanged):
 * ~143 SKUs max = 24 ticks of 6 SKUs, inside 84 ticks (runs still capped at 60/day incl. the sweep; paused/waiting ticks charge none).
 *
 * Same hard guards as every DABS run: kill switch (FETCHER_ENABLED + KV kill), cron allowlist (index.ts),
 * single "dabs" lock, daily budget (Budget.startRun / reserveRequest), 10 s min gap and the 12-request per-tick
 * cap (PoliteClient), 429/5xx backoff. Plus a per-store soft ceiling: no SKU (B1 or popular) is started if today's
 * DABS requests (sweep included) would pass min(PERSTORE_DAY_REQUEST_CEILING, the day's DABS cap). No per-SKU KV cache.
 *
 * FAIL CLOSED per SKU: fetch error, parse/shape error or an incomplete/inconsistent store list (validateStoreList)
 * writes nothing, does not advance verified_at, never marks anything out of stock; logged to fetch_log
 * (kind 'perstore_detail'). 3 consecutive non-'incomplete' failures (layout change / outage) stop the day.
 *
 * TRANSIENT 5xx RETRIES (owner-approved 2026-10-23, after one 522 on SKU 027100 paused the whole morning): a 500/502/503/504/
 * 520-527 on one SKU does NOT start the 1 h backoff. The SKU is requeued to retry >= 15 min later in the same window and the
 * pass continues. Max 3 retries per SKU/day, then the SKU is failed for the day (nothing written). Global limit: 50 DABS
 * requests/day spent on retries (perstore_state.retry_requests; 40 until 2026-11-10), and retries go through the same 500/day ceiling and 700 cap
 * checks. If 3 DISTINCT SKUs in a row hit 5xx (DABS is really down) the pass pauses 15 min (PERSTORE_STREAK_PAUSE_MS, owner-approved
 * 2026-10-30, was the 1 h backoff; same as the sweep) and the streak restarts when the pause starts; pending retries are kept. 429,
 * other 4xx and unlisted 5xx keep the old behavior (1 h hard backoff / stop the tick). Failed or incomplete data is never written (fail closed).
 * TIMEOUTS (owner-approved 2026-10-30, same as the sweep since 2026-10-25): our own 20 s request timeout (TimeoutError, on either
 * request or the ProductDetail body) is handled exactly like a transient 5xx: requeued under the same 3/SKU and 50/day limits, counts
 * toward the 3-distinct-SKU streak, and does not count toward the 3-consecutive-failures stop. Other network errors are unchanged.
 * RUNS (owner-approved 2026-10-30, same as the sweep): ticks that only sit out a backoff/pause, or only wait for retries that aren't
 * due yet (queue drained), return BEFORE a run is charged. Ticks that can send requests still charge one run.
 * RETRY ORDER (owner-approved 2026-10-31, after 3 persistently failing SKUs re-triggered the pause 4 times in a row and no fresh
 * SKU was checked): while fresh SKUs remain, at most one due retry is worked between two fresh SKUs, and the first SKU after a
 * streak pause is fresh. When the queue is drained, due retries run as before. Pure reordering: no limit changes.
 * RE-PAUSE (owner-approved 2026-11-03): after a 15 min streak pause the first request is a probe (retry_json.probe). If it fails
 * with a transient error (522/5xx/timeout), another 15 min pause starts at once (no 3-in-a-row needed); the failed probe is
 * counted exactly like the failure that triggers a pause today (transient_errors++, the SKU's retry counter n+1, requeued >= 15 min
 * later or failed for the day after 3 retries; it never charges the 50/day retry budget unless the probe itself was a retry).
 * A probe that succeeds, or answers with anything non-transient (incl. 429 -> 1 h backoff as before), ends probe mode and normal
 * running (3 distinct in a row) resumes. Only the 15 min streak pause arms the probe; the sweep is untouched.
 * MISSING-STORE RULE (owner-approved 2026-11-02, the ONE narrow exception to fail-closed): a list that is a clean 200, parsed, has no
 * duplicate store, adds up EXACTLY to the sweep's statewide store count, and whose ONLY problem is that stores we hold with stock are
 * absent, is ACCEPTED when every absent store was also in the absent set recorded for that SKU on the previous Utah (America/Denver)
 * day (perstore_missing; a superset the previous day is fine). Then the listed stores are written as a normal ok (verified_at
 * advanced) and each absent store is written as qty 0, inferred=1 with inferred_reason. Any store absent for the first time, no
 * previous-day record, a total mismatch, duplicates or parse problems: nothing written, nothing zeroed, no freshness (unchanged).
 * EMPTY-LIST RULE (owner-approved 2026-11-22, t102u, the SECOND narrow exception): when the missing-store rule did not accept, a clean
 * 200, parsed store list with ZERO rows (sum 0 = the sweep's statewide 0) whose only problem is stores we hold with stock is ACCEPTED
 * when TODAY's (America/Denver) nightly sweep is 'complete' (not degraded, vanish not skipped) and the product-level row still holds
 * that sweep's statewide 0 (store.ts sweepConfirmsZero). Each held store -> qty 0 (observed, verified now); fetch_log category
 * 'empty_accepted', perstore_missing outcome 'empty_accepted', /health categories.empty_accepted. Anything else stays held.
 * The absent set is recorded (perstore_missing) every time "missing stores" is the only failure, held or accepted. Incomplete lists are
 * still never retried; no requests are added (the previous-day lookup is D1 only). Outcome categories (perstore_state counters,
 * fetch_log.category): ok, missing_store_accepted_inferred, missing_store_held, qty_mismatch_above / _below, duplicate, parse,
 * no_statewide, transient_retry_queued, transient_exhausted (522/5xx/timeout, 3 retries used), retry_cap_dropped (50/day retry cap),
 * http_error, network_error.
 * The run row is closed (complete / capped / failed / window_ended) with ok/failed/retried/skipped counts, and stale 'running'
 * rows from earlier days are closed ('expired') by the next day's first tick.
 */
import { Budget, BudgetExceeded, Meter, acquireLock, releaseLock, fetcherDisabledReason, mtDay, isDropDay } from "./guard";
import { POPULAR_MAX_SKUS, POPULAR_FLAG_KEY, popularFlag, selectPopularSkus, popularCounts, POPULAR_ORDER } from "./popular";
import { PoliteClient, fetchStoreDetailPage, fetcherConfig, inBackoff, startBackoff, isTransient5xx, MAX_REQUESTS_PER_RUN, type FetcherEnv } from "./dabs-locator";
import { checkStoreList, writeStoreDetail, writeInferredMissing, writeEmptyAccepted, sweepConfirmsZero, missingRecord, recordMissing, prevDay, logStart, logFinish, logEvent } from "./store";
import { isLocalLastTick, PERSTORE_LAST_TICK_LOCAL_MIN } from "../schedule";

export const PERSTORE_CONFIG = {
  /** B1: allocated (status A) SKUs with any stock. Enabled when env PERSTORE_REFRESH === "allocated". */
  allocated: true,
  /** B2: limited (status L) SKUs. OFF. Not implemented; do not enable without a new owner decision. */
  limited: false,
} as const;
export const PERSTORE_STATUS = "A";
export const REQUESTS_PER_SKU = 2;
export const PERSTORE_MAX_SKUS = 60;                 // B1 (allocated) daily SKU limit (120 requests)
export { POPULAR_MAX_SKUS };                         // popular daily SKU limit: 100 (200 requests)
export const PERSTORE_DAY_REQUEST_CEILING = 500;     // no per-store SKU starts past this many DABS requests today (incl. sweep)
export const PERSTORE_MAX_CONSECUTIVE_FAILURES = 3;
export const PERSTORE_KIND = "perstore_detail";
/** Transient-5xx retries (see header). Budget math is in DECISIONS.md: baseline ~391 + 50 retry requests < 500 ceiling < 700 cap. */
export const PERSTORE_MAX_RETRIES_PER_SKU = 3;       // retries per SKU per day (4 tries total) for a transient 5xx
export const PERSTORE_RETRY_REQUEST_LIMIT = 50;      // global: DABS requests per day spent on retries (each retry costs 1-2); owner-approved 2026-11-10 (was 40)
export const PERSTORE_RETRY_DELAY_MS = 15 * 60 * 1000; // a retry is due >= 15 min (3 cron ticks) after the failure
export const PERSTORE_STREAK_PAUSE = 3;              // distinct SKUs in a row hitting 5xx/timeout -> pause PERSTORE_STREAK_PAUSE_MS
export const PERSTORE_STREAK_PAUSE_MS = 15 * 60 * 1000; // owner-approved 2026-10-30 (was the 1 h backoff; matches the sweep); 429 keeps 1 h
// Hard stop: the 10:55 AM America/Denver tick (src/schedule.ts; was 17:55 UTC = 10:55 MST until 2026-11-13, owner-approved t80u).

export interface PerstoreEnv extends FetcherEnv { PERSTORE_REFRESH?: string }
export const perstoreMode = (env: PerstoreEnv) => (env.PERSTORE_REFRESH === "allocated" ? "allocated" : "off");

type StateRow = {
  day: string; status: string; queue: string; total: number; next_idx: number; ok: number; failed: number;
  consecutive_failures: number; stores_verified: number; stores_changed: number; requests: number;
  b1_total: number | null; popular_total: number;
  skipped: number; retry_json: string | null; retried: number; recovered: number; retry_requests: number; transient_errors: number;
} & Record<CatCol, number>;
interface Pending { sku: string; n: number; due: number }
/** lr = the last attempt was a retry (or a pause just started): the next attempt must be a fresh SKU while any remain. */
interface RetryState { pending: Pending[]; streak: string[]; lr?: boolean; probe?: boolean }
function parseRetry(j: string | null): RetryState {
  try {
    const o = JSON.parse(j || "{}");
    return { pending: Array.isArray(o.pending) ? o.pending : [], streak: Array.isArray(o.streak) ? o.streak : [], lr: o.lr === true, probe: o.probe === true };
  } catch { return { pending: [], streak: [] }; }
}
/** /health: retry ordering policy (owner-approved 2026-10-31). */
export const PERSTORE_RETRY_ORDER = "fresh_first_max1_interleave";
/** /health: re-pause rule (owner-approved 2026-11-03): after a 15 min streak pause, the FIRST request is a probe; a transient
 *  failure on it (522/5xx/timeout) immediately starts another 15 min pause instead of spending 2 more failures. */
export const PERSTORE_REPAUSE_RULE = "first_transient_after_pause";
/** /health: missing-store acceptance rule (owner-approved 2026-11-02). */
export const PERSTORE_MISSING_STORE_ACCEPT = "prev_day_same_stores";
/** /health: empty-list rule (owner-approved 2026-11-22, t102u). */
export const PERSTORE_EMPTY_LIST_ACCEPT = "complete_sweep_today_statewide_0";
/** Per-day outcome counters (migration 0011), in perstore_state column order. */
const CAT_COLS = ["accepted_inferred", "inferred_stores", "held_first_day_missing", "qty_mismatch_above", "qty_mismatch_below", "dup_parse",
  "transient_exhausted", "retry_cap_dropped", "other_failed"] as const;
type CatCol = typeof CAT_COLS[number];
/** True for the cron tick scheduled at/after 10:55 AM America/Denver (catch-up: 3:55 PM). Manual (admin) ticks have no scheduledTime and are never the "last tick". */
const isLastScheduledTick = (scheduledTime?: number, lastTickLocalMin = PERSTORE_LAST_TICK_LOCAL_MIN) => isLocalLastTick(scheduledTime, lastTickLocalMin);

/**
 * Close a still-'running' row with a terminal status. skipped = queued SKUs never checked (next_idx..end) + unresolved
 * retries, so ok + failed + skipped = total. No-op unless the row is 'running'. Never touches product data.
 */
export async function closeRunning(db: D1Database, meter: Meter, day: string, status: string, error: string | null): Promise<boolean> {
  const row = await db.prepare("SELECT queue, next_idx, skipped, retry_json, status FROM perstore_state WHERE day = ?")
    .bind(day).first<{ queue: string; next_idx: number; skipped: number; retry_json: string | null; status: string }>();
  if (!row || row.status !== "running") return false;
  const total = row.queue ? row.queue.split(",").length : 0;
  const skipped = row.skipped + Math.max(0, total - row.next_idx) + parseRetry(row.retry_json).pending.length;
  const t = new Date().toISOString();
  const r = await db.prepare(
    "UPDATE perstore_state SET status = ?, error = COALESCE(?, error), skipped = ?, updated_at = ?, completed_at = ? WHERE day = ? AND status = 'running'",
  ).bind(status, error, skipped, t, t, day).run();
  meter.addResult(r);
  return !!r.meta.changes;
}
export interface PerstoreTickResult { action: string; day: string; skus?: number; ok?: number; failed?: number; retried?: number; detail?: string; status?: string }

export async function selectPerstoreSkus(db: D1Database, meter: Meter): Promise<string[]> {
  const r = await db.prepare(
    `SELECT p.sku FROM products p JOIN inventory_latest l ON l.sku = p.sku AND l.store_key = ''
     WHERE p.status = ? AND (COALESCE(l.store_total_qty,0) > 0 OR COALESCE(l.quantity,0) > 0 OR COALESCE(l.on_order_qty,0) > 0)
     ORDER BY COALESCE(l.store_total_qty,0) DESC, p.sku LIMIT ?`,
  ).bind(PERSTORE_STATUS, PERSTORE_MAX_SKUS).all<{ sku: string }>();
  meter.addResult(r);
  return r.results.map((x) => x.sku);
}

/**
 * One tick. opts.maxSkus (manual trigger via the guarded internal endpoint only) limits this tick to 1-2 SKUs;
 * it advances the same day's queue, so a manual tick never adds requests beyond the normal daily job.
 */
/** opts.lastTickLocalMin is set ONLY by the same-day catch-up (catchup.ts): its 3:55 PM local hard stop instead of 10:55 AM. */
export async function runPerstoreTick(env: PerstoreEnv, opts: { maxSkus?: number; scheduledTime?: number; lastTickLocalMin?: number } = {}, fetchImpl?: typeof fetch): Promise<PerstoreTickResult> {
  const day = mtDay();
  if (perstoreMode(env) !== "allocated") return { action: "disabled", day, detail: "PERSTORE_REFRESH is not 'allocated'" };
  const disabled = await fetcherDisabledReason(env);
  if (disabled) { console.log(`[perstore] disabled: ${disabled}`); return { action: "disabled", day, detail: disabled }; }

  const cfg = fetcherConfig(env);
  const meter = new Meter();
  const db = env.DB;
  const lastTick = cfg.forceLastTick || isLastScheduledTick(opts.scheduledTime, opts.lastTickLocalMin);

  // A 'running' row from an earlier day can never progress again: close it so it doesn't read as running forever.
  const stale = await db.prepare("SELECT day FROM perstore_state WHERE status = 'running' AND day < ?").bind(day).all<{ day: string }>();
  for (const r of stale.results) {
    if (await closeRunning(db, meter, r.day, "expired", "window ended with the run still 'running'; closed by a later day's tick")) {
      await logEvent(db, meter, "perstore", "expired", `closed stale running row ${r.day}`);
    }
  }

  // Cheap pre-checks before taking the lock or charging a run.
  const pre = await db.prepare("SELECT status FROM perstore_state WHERE day = ?").bind(day).first<{ status: string }>();
  if (pre && pre.status !== "running") return { action: "noop", day, detail: `already ${pre.status}`, status: pre.status };
  if (!pre) {
    const sw = await db.prepare("SELECT status FROM sweep_state WHERE day = ?").bind(day).first<{ status: string }>();
    if (sw?.status !== "complete") {
      // Runs only after the nightly sweep COMPLETES (the sweep window 00:30-03:55 local is over by the 04:00 local start).
      // If the sweep failed / never finished, skip B1 for the day (logged once; per-store data just ages).
      const now = new Date().toISOString();
      const reason = `nightly sweep not complete (${sw?.status ?? "missing"})`;
      const ins = await db.prepare(
        "INSERT INTO perstore_state (day, status, error, started_at, updated_at) VALUES (?, 'skipped', ?, ?, ?) ON CONFLICT(day) DO NOTHING",
      ).bind(day, reason, now, now).run();
      if (ins.meta.changes) { meter.addResult(ins); await logEvent(db, meter, "perstore", "skipped", reason); }
      return { action: "skipped", day, detail: reason, status: "skipped" };
    }
  }

  const holder = `perstore:${crypto.randomUUID()}`;
  if (!(await acquireLock(db, meter, holder, cfg.lockTtlMs))) {
    await logEvent(db, meter, "perstore", "locked", "another run holds the lock");
    return { action: "locked", day };
  }
  const budget = new Budget(db, meter);
  try {
    // Ticks that can't send a request return BEFORE a run is charged (owner-approved 2026-10-30, same as the sweep).
    await budget.openDay();
    const backoff = await inBackoff(env);
    if (backoff) {
      // A backoff (1 h for 429/hard errors, 15 min streak pause) can outlast the window (the 2026-10-23 incident): don't leave the row 'running' forever.
      if (lastTick && await closeRunning(db, meter, day, "window_ended", `window ended during DABS backoff (until ${new Date(backoff).toISOString()})`)) {
        await logEvent(db, meter, "perstore", "window_ended", `backoff until ${new Date(backoff).toISOString()}`);
      }
      return { action: "backoff", day, detail: new Date(backoff).toISOString() };
    }
    const flag = await popularFlag(env);
    if (pre) {
      // Queue drained and only retries that aren't due yet: nothing to send this tick (no run charged). If popular was
      // stopped mid-run the main loop must drop those retries, so that case is not short-cut here.
      const w = await db.prepare("SELECT queue, next_idx, b1_total, retry_json FROM perstore_state WHERE day = ? AND status = 'running'").bind(day)
        .first<{ queue: string; next_idx: number; b1_total: number | null; retry_json: string | null }>();
      if (w) {
        const q = w.queue ? w.queue.split(",") : [];
        const stoppedPop = q.length > (w.b1_total ?? q.length) && (flag !== "on" || isDropDay());
        const pend = parseRetry(w.retry_json).pending;
        if (!stoppedPop && w.next_idx >= q.length && pend.length && !pend.some((p) => p.due <= Date.now())) {
          if (lastTick) {
            const why = `window ended: 0 unchecked, ${pend.length} retries pending (not due)`;
            if (await closeRunning(db, meter, day, "window_ended", why)) await logEvent(db, meter, "perstore", "window_ended", why);
            return { action: "waiting", day, detail: why, status: "window_ended" };
          }
          return { action: "waiting", day, detail: `${pend.length} retr${pend.length === 1 ? "y" : "ies"} not due yet`, status: "running" };
        }
      }
    }
    try { await budget.startRun(); } catch (e) {
      if (e instanceof BudgetExceeded) { if (e.firstTrip) await logEvent(db, meter, "perstore", "budget_exhausted", e.message); if (lastTick) await closeRunning(db, meter, day, "window_ended", `window ended; ${e.message}`); return { action: "budget_exhausted", day, detail: e.message }; }
      throw e;
    }

    const now = new Date().toISOString();
    if (!pre) {
      // Frozen daily queue: B1 first, then popular (deduped, zero-qty skipped). List edits apply from the next day.
      const b1 = await selectPerstoreSkus(db, meter);
      let pop: string[] = [], note: string;
      if (isDropDay()) note = "drop day: popular skipped";
      else if (flag !== "on") note = `popular flag off (${POPULAR_FLAG_KEY})`;
      else {
        const sel = await selectPopularSkus(db, meter, b1);
        pop = sel.skus;
        note = `active ${sel.active}, queued ${pop.length}, skipped zero-qty ${sel.zero}, already in B1 ${sel.dedup}, auto-pruned ${sel.pruned}`;
      }
      const queue = [...b1, ...pop];
      meter.addResult(await db.prepare(
        `INSERT INTO perstore_state (day, status, queue, total, b1_total, popular_total, popular_note, started_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO NOTHING`,
      ).bind(day, queue.join(","), queue.length, b1.length, pop.length, note, now, now).run());
    }
    const st = (await db.prepare("SELECT * FROM perstore_state WHERE day = ?").bind(day).first<StateRow>())!;
    if (st.status !== "running") return { action: "noop", day, detail: `already ${st.status}`, status: st.status };
    let queue = st.queue ? st.queue.split(",") : [];
    const b1Total = st.b1_total ?? queue.length;
    // Popular turned off (KV flag) or a drop day mid-run: stop after the B1 part.
    const popularStopped = queue.length > b1Total && (flag !== "on" || isDropDay());
    if (popularStopped) queue = queue.slice(0, b1Total);

    const used = await db.prepare("SELECT dabs_requests FROM fetch_budget WHERE day = ?").bind(day).first<{ dabs_requests: number }>();
    const usedAtStart = Number(used?.dabs_requests ?? 0);

    const client = new PoliteClient(env, budget, cfg.minGapMs, fetchImpl);
    const maxSkus = opts.maxSkus ? Math.max(1, Math.min(2, Math.floor(opts.maxSkus))) : Infinity;
    const retryDelayMs = cfg.retryDelayMs ?? PERSTORE_RETRY_DELAY_MS;
    const ceiling = Math.min(PERSTORE_DAY_REQUEST_CEILING, budget.caps.dabs_requests);
    const rs = parseRetry(st.retry_json);
    let idx = st.next_idx, ok = st.ok, failed = st.failed, skipped = st.skipped, consec = st.consecutive_failures;
    let retried = st.retried, recovered = st.recovered, retryRequests = st.retry_requests, transientErrors = st.transient_errors;
    const cat = Object.fromEntries(CAT_COLS.map((c) => [c, Number(st[c] ?? 0)])) as Record<CatCol, number>;
    let tickOk = 0, tickFailed = 0, tickRetried = 0, verified = 0, changedStores = 0, reqsD = 0, done = 0;
    let endStatus: string | null = null, endError: string | null = null, stop: string | null = null;
    const save = async (fin: string | null) => {
      const t = new Date().toISOString();
      meter.addResult(await db.prepare(
        `UPDATE perstore_state SET next_idx = ?, ok = ?, failed = ?, skipped = ?, consecutive_failures = ?, stores_verified = stores_verified + ?,
           stores_changed = stores_changed + ?, requests = requests + ?, retried = ?, recovered = ?, retry_requests = ?, transient_errors = ?,
           retry_json = ?, status = COALESCE(?, status), error = COALESCE(?, error), updated_at = ?,
           completed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END, ${CAT_COLS.map((c) => `${c} = ?`).join(", ")} WHERE day = ?`,
      ).bind(idx, ok, failed, skipped, consec, verified, changedStores, reqsD, retried, recovered, retryRequests, transientErrors,
        JSON.stringify(rs), fin, fin ? endError : null, t, fin, t, ...CAT_COLS.map((c) => cat[c]), day).run());
      verified = 0; changedStores = 0; reqsD = 0;
    };
    const queueSet = new Set(queue);

    while (done < maxSkus) {
      // Retries of popular SKUs are dropped if popular was turned off / drop day mid-run (they count as skipped).
      const dropped = rs.pending.filter((p) => !queueSet.has(p.sku));
      if (dropped.length) { rs.pending = rs.pending.filter((p) => queueSet.has(p.sku)); skipped += dropped.length; await save(null); }
      // Global retry budget: if there isn't room for another full retry, the remaining retries are failed for the day.
      if (rs.pending.length && PERSTORE_RETRY_REQUEST_LIMIT - retryRequests < REQUESTS_PER_SKU) {
        const n = rs.pending.length;
        failed += n; tickFailed += n; cat.retry_cap_dropped += n;
        const skus = rs.pending.map((p) => p.sku).join(",");
        rs.pending = [];
        await save(null);
        await logEvent(db, meter, "perstore", "retry_limit", `global retry limit ${PERSTORE_RETRY_REQUEST_LIMIT} requests/day reached (${retryRequests} used); ${n} pending retries failed for the day (${skus}), no data written`, undefined, "retry_cap_dropped");
      }
      const nowMs = Date.now();
      // Retry order (owner-approved 2026-10-31): while fresh (never-tried) SKUs remain, at most ONE due retry runs between two
      // fresh SKUs (fresh, retry, fresh, retry, ...), and the first attempt after a streak pause is fresh. Once the queue is
      // drained, due retries run back to back as before. Only reorders work; the limits and the >= 15 min delay are unchanged.
      const freshLeft = idx < queue.length;
      const dueRetry = freshLeft && rs.lr ? undefined : rs.pending.filter((p) => p.due <= nowMs).sort((x, y) => x.due - y.due)[0];
      const isRetry = !!dueRetry;
      if (!isRetry && idx >= queue.length) break;                                          // drained, or only not-yet-due retries left
      if (client.requests + REQUESTS_PER_SKU > MAX_REQUESTS_PER_RUN) break;                // per-tick cap
      if (usedAtStart + client.requests + REQUESTS_PER_SKU > ceiling) {                    // same ceiling for first tries and retries
        endStatus = "capped"; endError = `per-store day request ceiling ${ceiling} reached`; break;
      }
      const sku = isRetry ? dueRetry!.sku : queue[idx];
      const prevN = isRetry ? dueRetry!.n : 0;
      const list = queue.indexOf(sku) < b1Total ? "b1" : "popular";
      const { id, started } = await logStart(db, meter, PERSTORE_KIND, `sku=${sku};list=${list}${isRetry ? `;retry=${prevN}` : ""}`);
      const before = client.requests;
      let res: { status: string; httpStatus?: number; itemCount?: number; error?: string; timeout?: boolean; category?: string };
      let skuChanged = 0;
      try {
        const out = await fetchStoreDetailPage(env, client, meter, cfg.base, sku, { softTransient: true });
        if (!out.ok) res = { status: out.status, httpStatus: out.httpStatus, error: out.error, timeout: out.timeout };
        else {
          const n = out.detail.stores.length;
          const chk = await checkStoreList(db, meter, out.detail);
          if (chk.kind === "ok") {
            const w = await writeStoreDetail(db, meter, out.detail, id, new Date().toISOString());
            skuChanged = w.changed; verified += n; changedStores += w.changed;
            res = { status: "ok", httpStatus: 200, itemCount: n, error: w.changed ? `${w.changed} changed` : undefined, category: "ok" };
          } else if (chk.kind === "missing") {
            // Owner rule 2026-11-02: accept ONLY if every absent store was also absent for this SKU on the previous Utah day.
            const pd = prevDay(day);
            const prev = await missingRecord(db, meter, sku, pd);
            const prevSet = new Set(prev ?? []);
            const firstTime = chk.missing.filter((x) => !prevSet.has(x));
            const accept = prev !== null && firstTime.length === 0;
            // Empty-list rule (owner-approved 2026-11-22, t102u): only when the missing-store rule did not already accept, the clean
            // list is EMPTY (sum 0 = statewide 0) and TODAY's complete nightly sweep says statewide 0 (sweepConfirmsZero; D1 only).
            const emptyCandidate = !accept && n === 0 && chk.sum === 0 && chk.statewide === 0;
            const emptyWhy = emptyCandidate ? await sweepConfirmsZero(db, meter, sku, day) : null;
            const emptyAccept = emptyCandidate && emptyWhy === null;
            await recordMissing(db, meter, { sku, day, missing: chk.missing, listed: n, sum: chk.sum, statewide: chk.statewide,
              outcome: accept ? "accepted_inferred" : emptyAccept ? "empty_accepted" : "held", fetchId: id });
            if (emptyAccept) {
              const at = new Date().toISOString();
              await writeEmptyAccepted(db, meter, sku, chk.missing, id, at);
              skuChanged = chk.missing.length; changedStores += chk.missing.length;
              res = { status: "ok", httpStatus: 200, itemCount: 0, category: "empty_accepted",
                error: `empty-accepted: clean empty store list and today's complete sweep (${day}) says statewide 0; ${chk.missing.length} store(s) set to 0: ${chk.missing.join(",")}` };
            } else if (accept) {
              const at = new Date().toISOString();
              const w = await writeStoreDetail(db, meter, out.detail, id, at);
              await writeInferredMissing(db, meter, sku, chk.missing, id, at,
                `absent from the DABS store list on ${pd} and ${day} (list otherwise clean: no duplicates, sum ${chk.sum} = statewide ${chk.statewide})`);
              skuChanged = w.changed + chk.missing.length; verified += n; changedStores += w.changed + chk.missing.length;
              cat.accepted_inferred++; cat.inferred_stores += chk.missing.length;
              res = { status: "ok", httpStatus: 200, itemCount: n, category: "missing_store_accepted_inferred",
                error: `accepted_inferred: ${chk.missing.length} absent store(s) also absent ${pd}, recorded as 0 (inferred): ${chk.missing.join(",")}${w.changed ? `; ${w.changed} changed` : ""}` };
            } else {
              cat.held_first_day_missing++;
              res = { status: "incomplete", httpStatus: 200, itemCount: n, category: "missing_store_held",
                error: `${chk.error} [held: ${prev === null ? `no absent-store record for ${pd}` : `absent for the first time: ${firstTime.slice(0, 10).join(",")}`}${emptyCandidate ? `; empty list not accepted: ${emptyWhy}` : ""}]` };
            }
          } else if (chk.kind === "qty_mismatch") {
            cat[chk.dir === "above" ? "qty_mismatch_above" : "qty_mismatch_below"]++;
            res = { status: "incomplete", httpStatus: 200, itemCount: n, error: chk.error, category: `qty_mismatch_${chk.dir}` };
          } else {
            cat.dup_parse++;
            res = { status: "incomplete", httpStatus: 200, itemCount: n, error: chk.error, category: chk.kind };
          }
        }
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        await logFinish(db, meter, id, started, { status: "budget_exhausted", error: e.message });
        if (e.firstTrip) await logEvent(db, meter, "perstore", "budget_exhausted", e.message);
        stop = `budget: ${e.message}`;
        const spent = client.requests - before; reqsD += spent; if (isRetry) retryRequests += spent;
        await save(null);
        break; // SKU not advanced / not requeued; nothing written
      }
      const spent = client.requests - before;
      reqsD += spent;
      done++;
      if (isRetry) { retried++; tickRetried++; retryRequests += spent; rs.pending = rs.pending.filter((p) => p.sku !== sku); } else idx++;
      rs.lr = isRetry;
      let note = "";
      // Transient = 500/502-504/520-527, or our own request timeout (owner-approved 2026-10-30, same as the sweep).
      const transient = (res.status === "http_error" && isTransient5xx(res.httpStatus)) || (res.status === "network_error" && !!res.timeout);
      if (res.status === "ok") {
        ok++; tickOk++; consec = 0; rs.streak = []; rs.probe = false;
        if (isRetry) recovered++;
      } else if (transient) {
        // Temporary DABS error or timeout: nothing written. Requeue for later in the window (or fail the SKU for the day).
        transientErrors++;
        const n = prevN + 1;
        if (!rs.streak.includes(sku)) rs.streak.push(sku);
        if (n <= PERSTORE_MAX_RETRIES_PER_SKU) {
          rs.pending.push({ sku, n, due: Date.now() + retryDelayMs });
          note = ` [transient; retry ${n}/${PERSTORE_MAX_RETRIES_PER_SKU} queued]`;
        } else {
          failed++; tickFailed++; cat.transient_exhausted++; res.category = "transient_exhausted";
          note = ` [transient; ${PERSTORE_MAX_RETRIES_PER_SKU} retries exhausted, failed for the day]`;
        }
        res.category ??= "transient_retry_queued";
        const probeFail = rs.probe === true;   // first request after a streak pause failed -> re-pause at once (2026-11-03)
        if (probeFail || rs.streak.length >= PERSTORE_STREAK_PAUSE) {
          // DABS looks down: short pause (pending retries kept). The streak restarts when the pause starts, so the next tick
          // gets up to 3 more distinct SKUs before pausing again instead of re-pausing after a single failure. Requests stay
          // bounded by 3 retries/SKU, 50 retry requests/day, the 500 combined ceiling / 700 cap and the 17:55 UTC window end.
          const pauseMs = cfg.perstorePauseMs ?? PERSTORE_STREAK_PAUSE_MS;
          await startBackoff(env, meter, pauseMs);
          stop = probeFail
            ? `first request after a pause failed (${sku}: ${res.httpStatus ?? (res.timeout ? "timeout" : res.status)}): DABS still down, re-pause ${Math.round(pauseMs / 60000)} min`
            : `${rs.streak.length} distinct SKUs in a row hit 5xx/timeout (${rs.streak.join(",")}): DABS looks down, ${Math.round(pauseMs / 60000)} min pause`;
          rs.streak = [];
          rs.probe = true;   // the next request after this pause is again a probe
          rs.lr = true;   // after the pause, a fresh SKU goes first (2026-10-31)
          await logEvent(db, meter, "perstore", "paused", stop);
        }
      } else {
        rs.streak = [];   // DABS answered, so it is not an outage
        rs.probe = false; // and probe mode ends (a 429 still starts the 1 h backoff below, as before)
        failed++; tickFailed++;
        if (res.status === "invalid_shape") { cat.dup_parse++; res.category = "parse"; }
        else if (res.status !== "incomplete") { cat.other_failed++; res.category = res.status; }
        if (res.status !== "incomplete") consec++;
        if (res.status === "http_error") { stop = `http_error on ${sku}: ${res.error}`; rs.lr = true; }   // 429/hard 5xx backoff: fresh first after it (2026-10-31)
        if (consec >= PERSTORE_MAX_CONSECUTIVE_FAILURES) { endStatus = "failed"; endError = `${consec} consecutive failures; last ${res.status}: ${res.error}`; }
      }
      const { timeout: _t, ...logRes } = res;
      await logFinish(db, meter, id, started, note ? { ...logRes, error: `${logRes.error ?? ""}${note}` } : logRes);
      await save(null);
      if (endStatus || stop) break;
    }

    // Close the row when this tick finished the day (or the window).
    const workLeft = idx < queue.length || rs.pending.length > 0;
    if (endStatus === "failed") {
      await closeRunning(db, meter, day, "failed", endError);
      await logEvent(db, meter, "perstore", "failed", endError!);
    } else if (endStatus === "capped" && workLeft) {
      await closeRunning(db, meter, day, "capped", endError);
      await logEvent(db, meter, "perstore", "capped", endError!);
    } else if (!endStatus && !workLeft) {
      await closeRunning(db, meter, day, "complete", null);
    } else if (!endStatus && lastTick) {
      const why = `window ended: ${Math.max(0, queue.length - idx)} unchecked, ${rs.pending.length} retries pending${stop ? `; ${stop}` : ""}`;
      if (await closeRunning(db, meter, day, "window_ended", why)) await logEvent(db, meter, "perstore", "window_ended", why);
    }
    if (popularStopped) {
      meter.addResult(await db.prepare(
        `UPDATE perstore_state SET popular_note = COALESCE(popular_note, '') || '; popular stopped mid-run (flag off / drop day)'
          WHERE day = ? AND COALESCE(popular_note, '') NOT LIKE '%stopped mid-run%'`,
      ).bind(day).run());
    }
    await client.persist(meter);
    const cur = await db.prepare("SELECT status FROM perstore_state WHERE day = ?").bind(day).first<{ status: string }>();
    const status = cur?.status ?? "running";
    return { action: stop ? "stopped" : status === "running" ? "progress" : status, day, skus: done, ok: tickOk, failed: tickFailed, retried: tickRetried,
      detail: stop ?? endError ?? `next ${idx}/${queue.length}; retries pending ${rs.pending.length}; retry requests ${retryRequests}/${PERSTORE_RETRY_REQUEST_LIMIT}`, status };
  } finally {
    await releaseLock(db, meter, holder);
    const trip = await budget.flush();
    if (trip?.firstTrip) await logEvent(db, meter, "perstore", "budget_exhausted", trip.message);
  }
}

/** Read-only state for /health. */
export async function perstoreStatus(env: PerstoreEnv) {
  const last = await env.DB.prepare(
    `SELECT day, status, total, b1_total, popular_total, popular_note, next_idx, ok, failed, skipped, retried, recovered, retry_requests,
            transient_errors, stores_verified, stores_changed, requests, error, started_at, completed_at, ${CAT_COLS.join(", ")}
       FROM perstore_state ORDER BY day DESC LIMIT 1`,
  ).first<Record<string, unknown>>().catch(() => null);
  const c = (k: CatCol) => Number(last?.[k] ?? 0);
  // Empty-list rule (2026-11-22): counted from perstore_missing (no new perstore_state column).
  const emptyAccepted = last ? Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM perstore_missing WHERE day = ? AND outcome = 'empty_accepted'")
    .bind(last.day).first<{ n: number }>().catch(() => null))?.n ?? 0) : 0;
  // Daily-status categories (2026-11-02): missing-store cases, quantity mismatches, 522/timeouts and cap drops reported separately.
  const categories = last ? {
    day: last.day, ok: Number(last.ok ?? 0) - c("accepted_inferred") - emptyAccepted, accepted_inferred: c("accepted_inferred"), inferred_stores: c("inferred_stores"),
    empty_accepted: emptyAccepted,
    held_first_day_missing: c("held_first_day_missing"),
    qty_mismatch: c("qty_mismatch_above") + c("qty_mismatch_below"), qty_mismatch_above: c("qty_mismatch_above"), qty_mismatch_below: c("qty_mismatch_below"),
    dup_parse: c("dup_parse"), transient_exhausted_522_timeout: c("transient_exhausted"), retry_cap_dropped: c("retry_cap_dropped"), other_failed: c("other_failed"),
    skipped: Number(last.skipped ?? 0),
  } : null;
  const flag = await popularFlag(env).catch(() => "unknown");
  const counts = await popularCounts(env.DB).catch(() => null);
  return {
    mode: perstoreMode(env), missing_store_accept: PERSTORE_MISSING_STORE_ACCEPT, empty_list_accept: PERSTORE_EMPTY_LIST_ACCEPT, allocated_b1: perstoreMode(env) === "allocated", limited_b2: PERSTORE_CONFIG.limited,
    limits: { b1_max_skus: PERSTORE_MAX_SKUS, popular_max_skus: POPULAR_MAX_SKUS, day_request_ceiling: PERSTORE_DAY_REQUEST_CEILING, requests_per_sku: REQUESTS_PER_SKU,
      retry_max_per_sku: PERSTORE_MAX_RETRIES_PER_SKU, retry_request_limit_per_day: PERSTORE_RETRY_REQUEST_LIMIT, retry_delay_min: PERSTORE_RETRY_DELAY_MS / 60000, streak_pause: PERSTORE_STREAK_PAUSE,
      streak_pause_min: PERSTORE_STREAK_PAUSE_MS / 60000, repause_rule: PERSTORE_REPAUSE_RULE, repause_min: PERSTORE_STREAK_PAUSE_MS / 60000, timeout_retryable: true, paused_or_waiting_ticks_charge_run: false,
      retry_order: PERSTORE_RETRY_ORDER },
    popular_order: POPULAR_ORDER,
    popular: { flag, flag_key: POPULAR_FLAG_KEY, order: POPULAR_ORDER, skipped_today_drop_day: isDropDay(), ...(counts ?? { error: "unavailable" }) },
    last_run: last, categories,
  };
}
