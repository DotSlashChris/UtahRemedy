/**
 * Nightly in-stock catalog sweep (Option B), split across cron ticks.
 *
 * Paging: length 50, stride 48 (2-row overlap) ordered by name, so small list shifts between
 * pages don't silently drop items. Cursor lives in D1 (sweep_state), so a crashed tick resumes.
 *
 * Vanish-to-zero (out-of-stock detection) runs ONLY when the day's sweep completes and:
 *   - every page passed fail-closed validation (any failure marks the sweep failed for the day),
 *     except a transient 5xx (500, 502-504, 520-527) or our own request timeout (TimeoutError), which requeues just that page >= 5 min later in the same window
 *     (3 retries/page >= 5 min apart; a page that used its 3 retries RESTS 30 min and is re-queued for one more try, repeated
 *     until the hard stop, while the other pages carry on; every attempt counts against the 40 retry requests/day (20 until 2026-10-29), and reaching
 *     that cap fails the sweep; 3 distinct pages in a row -> a 15 min pause, then the streak restarts (post-rest attempts don't
 *     count toward it); a 429 still pauses 1 h). The sweep is only
 *     'complete' once every page succeeded; at the window's last tick an unresolved sweep is closed 'failed'.
 *
 * Maintenance window (owner-approved 2026-10-27): ticks every 5 min 07:30-10:55 UTC (01:30-04:55 MDT / 00:30-03:55 MST),
 * 42 ticks; a clean sweep needs ~11. The cursor + retry queue in sweep_state carry across ticks and pauses, so the
 * sweep resumes where it stopped; once the day's row is complete/failed every later tick is a read-only no-op (no
 * lock, no run, no request), so there is never a second sweep the same Utah day. Ticks that can't send a request
 * (DABS backoff/pause, or only not-yet-due retries left) return before a run is charged, so the longer window doesn't
 * eat the 60 runs/day cap that per-store also needs.
 *   - the reported total drifted by no more than the overlap, and every non-final page was full,
 *   - unique SKUs seen >= 98% of the final total,
 *   - vanished count <= max(25, 10% of previously in-stock SKUs).
 * Vanished SKUs get an inferred snapshot (statewide store qty 0; warehouse/on-order unknown).
 */
import { Budget, BudgetExceeded, Meter, acquireLock, releaseLock, fetcherDisabledReason, mtDay } from "./guard";
import { PoliteClient, fetchTablePage, fetcherConfig, inBackoff, setStatus, isTransient5xx, startBackoff, MAX_REQUESTS_PER_RUN, type FetcherEnv } from "./dabs-locator";
import { isLocalLastTick, SWEEP_LAST_TICK_LOCAL_MIN } from "../schedule";
import { writeProducts, writeVanished, currentlyInStock, logStart, logFinish, logEvent } from "./store";

export const PAGE_LEN = 50;
export const OVERLAP = 2;
export const STRIDE = PAGE_LEN - OVERLAP;
export const MAX_PAGES_PER_RUN = MAX_REQUESTS_PER_RUN;
const MIN_SEEN_RATIO = 0.98;

/** A running same-day catch-up that ends failed (retry_limit, hard error) is marked failed too (never re-queued). */
const CATCHUP_CLOSE_SQL = "catchup_finished_at = CASE WHEN catchup_status = 'running' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE catchup_finished_at END, catchup_status = CASE WHEN catchup_status = 'running' THEN 'failed' ELSE catchup_status END";
interface SweepRow {
  day: string; status: string; next_start: number; pages_done: number; total_first: number | null; total_last: number | null;
  seen: string; degraded: string | null; started_at: string;
  retry_json: string | null; retried: number; recovered: number; retry_requests: number; transient_errors: number;
  rest_cycles: number; page_failures_json: string | null;
}

/** Transient-5xx page retries (owner-approved 2026-10-25; mirrors the per-store design). Math in DECISIONS.md. */
export const SWEEP_MAX_RETRIES_PER_PAGE = 3;          // retries per page per day (4 tries total)
export const SWEEP_RETRY_REQUEST_LIMIT = 40;          // global: DABS requests/day spent on sweep retries (1 per retry; separate from per-store's 50); owner-approved 2026-10-29 (was 20)
export const SWEEP_RETRY_DELAY_MS = 5 * 60 * 1000;    // a retry is due >= 5 min (1 cron tick) after the failure
export const SWEEP_STREAK_PAUSE = 3;                  // distinct pages in a row hitting 5xx/timeout -> pause SWEEP_STREAK_PAUSE_MS
export const SWEEP_STREAK_PAUSE_MS = 15 * 60 * 1000;  // owner-approved 2026-10-26 (was the 1 h backoff); 429 keeps 1 h
export const SWEEP_PAGE_REST_MS = 30 * 60 * 1000;     // owner-approved 2026-10-28: a page that used its 3 retries rests 30 min, then 1 more try (repeats)
// Hard stop: the 03:55 America/Denver tick (src/schedule.ts; was 10:55 UTC = 03:55 MST until 2026-11-13, owner-approved t80u).
/** n = retries used so far (n > SWEEP_MAX_RETRIES_PER_PAGE = post-rest attempts); rest = rest periods this page has had. */
export interface Pending { start: number; n: number; due: number; rest?: number }
interface PageFailure { fails: number; rests: number; last_status: string; last_ms: number | null; max_ms: number | null; ms: (number | null)[]; at: string }
function parseFailures(j: string | null): Record<string, PageFailure> {
  try { const o = JSON.parse(j || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
export interface RetryState { pending: Pending[]; streak: number[] }
export function parseRetry(j: string | null): RetryState {
  try {
    const o = JSON.parse(j || "{}");
    return { pending: Array.isArray(o.pending) ? o.pending : [], streak: Array.isArray(o.streak) ? o.streak : [] };
  } catch { return { pending: [], streak: [] }; }
}
/** True for the cron tick scheduled at/after 03:55 America/Denver (catch-up: its own local hard stop). Manual (admin) ticks have no scheduledTime and are never the last tick. */
const isLastScheduledTick = (scheduledTime?: number, lastTickLocalMin = SWEEP_LAST_TICK_LOCAL_MIN) => isLocalLastTick(scheduledTime, lastTickLocalMin);

export interface TickResult { action: string; day: string; pages?: number; changed?: number; detail?: string; sweep_status?: string }

/**
 * opts.lastTickLocalMin / opts.requestCeiling are set ONLY by the same-day catch-up (src/fetchers/catchup.ts, owner-approved
 * 2026-11-13): its own 15:55 local hard stop instead of 03:55 local, and no page/retry starts once today's DABS requests would pass
 * min(500, day cap). The nightly cron path passes neither, so its behavior is unchanged.
 */
export async function runSweepTick(env: FetcherEnv, fetchImpl?: typeof fetch, opts: { scheduledTime?: number; lastTickLocalMin?: number; requestCeiling?: number } = {}): Promise<TickResult> {
  const day = mtDay();
  const disabled = await fetcherDisabledReason(env);
  if (disabled) { console.log(`[sweep] disabled: ${disabled}`); return { action: "disabled", day, detail: disabled }; }

  const cfg = fetcherConfig(env);
  const meter = new Meter();
  const db = env.DB;
  const lastTick = cfg.forceLastTick || isLastScheduledTick(opts.scheduledTime, opts.lastTickLocalMin);

  // Cheap pre-check before taking the lock or charging a run.
  const pre = await db.prepare("SELECT status FROM sweep_state WHERE day = ?").bind(day).first<{ status: string }>();
  if (pre && pre.status !== "running") return { action: "noop", day, detail: `sweep already ${pre.status}`, sweep_status: pre.status };

  const holder = `cron:${crypto.randomUUID()}`;
  if (!(await acquireLock(db, meter, holder, cfg.lockTtlMs))) {
    await logEvent(db, meter, "sweep", "locked", "another run holds the lock");
    return { action: "locked", day };
  }
  const budget = new Budget(db, meter);
  try {
    // Ticks that can't send a request return BEFORE a run is charged (the window has 42 ticks; runs cap is 60/day).
    await budget.openDay();
    const backoff = await inBackoff(env);
    if (backoff) {
      // Last tick of the window while paused with retries in play: close the day as failed (never 'complete').
      if (lastTick && await closeWindowEnded(env, meter, day)) return { action: "backoff", day, detail: `${new Date(backoff).toISOString()}; window ended`, sweep_status: "failed" };
      return { action: "backoff", day, detail: new Date(backoff).toISOString() };
    }
    if (pre) {
      // Main pages all done and only retries that aren't due yet: nothing to send this tick.
      const w = await db.prepare("SELECT next_start, total_last, retry_json FROM sweep_state WHERE day = ? AND status = 'running'").bind(day)
        .first<{ next_start: number; total_last: number | null; retry_json: string | null }>();
      const pend = w ? parseRetry(w.retry_json).pending : [];
      if (w && w.total_last != null && w.next_start + OVERLAP >= w.total_last && pend.length && !pend.some((p) => p.due <= Date.now())) {
        if (lastTick && await closeWindowEnded(env, meter, day)) return { action: "waiting", day, detail: "window ended with retries pending", sweep_status: "failed" };
        return { action: "waiting", day, detail: `${pend.length} retr${pend.length === 1 ? "y" : "ies"} not due yet` };
      }
    }
    try { await budget.startRun(); } catch (e) {
      if (e instanceof BudgetExceeded) {
        if (e.firstTrip) await logEvent(db, meter, "sweep", "budget_exhausted", e.message);
        if (lastTick && await closeWindowEnded(env, meter, day)) return { action: "budget_exhausted", day, detail: `${e.message}; window ended`, sweep_status: "failed" };
        return { action: "budget_exhausted", day, detail: e.message };
      }
      throw e;
    }

    const now = new Date().toISOString();
    meter.addResult(await db.prepare(
      "INSERT INTO sweep_state (day, status, started_at, updated_at) VALUES (?, 'running', ?, ?) ON CONFLICT(day) DO NOTHING",
    ).bind(day, now, now).run());
    let st = (await db.prepare(`SELECT day, status, next_start, pages_done, total_first, total_last, seen, degraded, started_at,
        retry_json, retried, recovered, retry_requests, transient_errors, rest_cycles, page_failures_json FROM sweep_state WHERE day = ?`).bind(day).first<SweepRow>())!;
    if (st.status !== "running") return { action: "noop", day, detail: `sweep already ${st.status}`, sweep_status: st.status };

    // Previous complete sweep total (for count-drop check).
    const prev = await db.prepare("SELECT total_last FROM sweep_state WHERE status = 'complete' AND day < ? ORDER BY day DESC LIMIT 1").bind(day).first<{ total_last: number }>();
    const usedRow = await db.prepare("SELECT dabs_requests FROM fetch_budget WHERE day = ?").bind(day).first<{ dabs_requests: number }>();
    const usedAtStart = Number(usedRow?.dabs_requests ?? 0);

    const client = new PoliteClient(env, budget, cfg.minGapMs, fetchImpl);
    const retryDelayMs = cfg.retryDelayMs ?? SWEEP_RETRY_DELAY_MS;
    const rs = parseRetry(st.retry_json);
    let retried = st.retried, recovered = st.recovered, retryRequests = st.retry_requests, transientErrors = st.transient_errors;
    let restCycles = st.rest_cycles ?? 0;
    const failures = parseFailures(st.page_failures_json);
    const noteFailure = (start: number, status: string, ms: number | null, rested: boolean) => {
      const f = failures[String(start)] ?? { fails: 0, rests: 0, last_status: "", last_ms: null, max_ms: null, ms: [], at: "" };
      f.fails++; if (rested) f.rests++;
      f.last_status = status; f.last_ms = ms; f.max_ms = ms != null && (f.max_ms == null || ms > f.max_ms) ? ms : f.max_ms;
      f.ms = [...f.ms, ms].slice(-8); f.at = new Date().toISOString();
      failures[String(start)] = f;
    };
    let pages = 0, changed = 0;
    let result: TickResult = { action: "progress", day };
    // Main cursor is done once the page that reached the reported total succeeded (or was requeued past it).
    const mainDone = () => st.total_last != null && st.next_start + OVERLAP >= st.total_last;
    const saveRetry = async () => {
      meter.addResult(await db.prepare(
        "UPDATE sweep_state SET retry_json = ?, retried = ?, recovered = ?, retry_requests = ?, transient_errors = ?, rest_cycles = ?, page_failures_json = ?, updated_at = ? WHERE day = ?",
      ).bind(JSON.stringify(rs), retried, recovered, retryRequests, transientErrors, restCycles, JSON.stringify(failures), new Date().toISOString(), day).run());
    };
    const failSweep = async (status: string, error: string, kvError = error) => {
      await saveRetry();
      meter.addResult(await db.prepare(`UPDATE sweep_state SET status = 'failed', error = ?, updated_at = ?, ${CATCHUP_CLOSE_SQL} WHERE day = ?`)
        .bind(error, new Date().toISOString(), day).run());
      await setStatus(env, meter, false, status, kvError);
      result = { action: "failed", day, pages, changed, detail: `${status}: ${error}`, sweep_status: "failed" };
    };

    while (pages < MAX_PAGES_PER_RUN) {
      // Catch-up only: the 500 combined ceiling applies to sweep pages too (1 request each). Nothing is consumed; the
      // catch-up just stops here and closes 'failed' at its hard stop.
      if (opts.requestCeiling != null && usedAtStart + client.requests + 1 > opts.requestCeiling) {
        const msg = `catch-up: combined ceiling ${opts.requestCeiling} would be passed by the next sweep request (${usedAtStart + client.requests} used)`;
        await logEvent(db, meter, "sweep", "ceiling", msg);
        result = { action: "budget_exhausted", day, pages, changed, detail: msg };
        break;
      }
      // Pick: a due retry first, else the next main page; if only not-yet-due retries remain, wait for a later tick.
      rs.pending.sort((a, b) => a.due - b.due);
      const due = rs.pending.length && rs.pending[0].due <= Date.now() ? rs.pending[0] : null;
      let start: number, n = 0, restsSoFar = 0;
      if (due) {
        if (retryRequests + 1 > SWEEP_RETRY_REQUEST_LIMIT) {
          await logEvent(db, meter, "sweep", "retry_limit", `sweep retry limit ${SWEEP_RETRY_REQUEST_LIMIT} requests/day reached; ${rs.pending.length} page(s) unresolved`);
          await failSweep("retry_limit", `retry_limit: sweep retry limit ${SWEEP_RETRY_REQUEST_LIMIT} requests/day reached with ${rs.pending.length} page(s) unresolved`);
          break;
        }
        // Daily request cap checked before every retry (the request itself is also reserved atomically in PoliteClient).
        if (usedAtStart + client.requests + 1 > budget.caps.dabs_requests) {
          const msg = `daily DABS request cap ${budget.caps.dabs_requests} would be passed by a retry`;
          await logEvent(db, meter, "sweep", "budget_exhausted", msg);
          result = { action: "budget_exhausted", day, pages, changed, detail: msg };
          break;
        }
        start = due.start; n = due.n; restsSoFar = due.rest ?? 0;
        rs.pending.shift();
      } else if (!mainDone()) {
        start = st.next_start;
      } else break;
      const isRetry = n > 0;

      const afterRest = n > SWEEP_MAX_RETRIES_PER_PAGE;   // this attempt follows a 30 min rest
      const { id, started } = await logStart(db, meter, "sweep_page", isRetry ? `start=${start};retry=${n}${afterRest ? `;rest=${restsSoFar}` : ""}` : `start=${start}`);
      let out;
      const before = client.requests;
      try {
        out = await fetchTablePage(env, client, meter, cfg.base, { inStockOnly: true, length: PAGE_LEN }, start, { softTransient: true });
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          if (isRetry) rs.pending.unshift({ start, n, due: Date.now() });
          await saveRetry();
          await logFinish(db, meter, id, started, { status: "budget_exhausted", error: e.message });
          if (e.firstTrip) await logEvent(db, meter, "sweep", "budget_exhausted", e.message);
          result = { action: "budget_exhausted", day, pages, changed, detail: e.message };
          break;
        }
        throw e;
      }
      if (isRetry) { retried++; retryRequests += client.requests - before; }
      pages++;
      const responseMs = client.requests > before ? client.lastResponseMs : null;
      // Extra fail-closed check specific to the sweep: count collapse vs the last complete sweep.
      if (out.ok && prev?.total_last && prev.total_last >= 100 && out.total < prev.total_last * 0.5) {
        out = { ok: false as const, status: "suspicious" as const, error: `in-stock total dropped ${prev.total_last} -> ${out.total}`, httpStatus: 200, itemCount: out.products.length };
      }
      if (!out.ok && ((out.status === "http_error" && isTransient5xx(out.httpStatus)) || (out.status === "network_error" && out.timeout))) {
        // Transient 5xx or our request timeout: nothing written for this page; requeue it (max SWEEP_MAX_RETRIES_PER_PAGE) and carry on.
        transientErrors++;
        // Post-rest attempts of an already-known-bad page don't feed the 3-in-a-row pause counter, so one resting page can't
        // keep re-triggering pauses for the others (they're bounded by the 40 retry requests/day anyway).
        if (!afterRest && !rs.streak.includes(start)) rs.streak.push(start);
        const nextN = n + 1;
        const rest = nextN > SWEEP_MAX_RETRIES_PER_PAGE;   // used its 3 retries -> rest 30 min instead of failing the sweep
        const capLeft = retryRequests < SWEEP_RETRY_REQUEST_LIMIT;
        noteFailure(start, out.httpStatus ? `${out.status} ${out.httpStatus}` : out.status, responseMs, rest && capLeft);
        await logFinish(db, meter, id, started, { status: out.status, httpStatus: out.httpStatus, responseMs,
          error: `${out.error} (transient; ${!capLeft ? "sweep retry limit reached" : rest ? `rest ${restsSoFar + 1} (${Math.round((cfg.restMs ?? SWEEP_PAGE_REST_MS) / 60000)} min) then retry` : `retry ${nextN} queued`})` });
        if (!isRetry) {
          meter.addResult(await db.prepare("UPDATE sweep_state SET next_start = ?, updated_at = ? WHERE day = ?")
            .bind(start + STRIDE, new Date().toISOString(), day).run());
          st = { ...st, next_start: start + STRIDE };
        }
        if (!capLeft) {
          await logEvent(db, meter, "sweep", "retry_limit", `sweep retry limit ${SWEEP_RETRY_REQUEST_LIMIT} requests/day reached at start=${start}`);
          await failSweep("retry_limit", `retry_limit: sweep retry limit ${SWEEP_RETRY_REQUEST_LIMIT} requests/day reached at start=${start}: ${out.error}`);
          break;
        }
        if (rest) {
          // Re-queued for a later attempt in the same window; the main cursor and other pages carry on immediately.
          const restMs = cfg.restMs ?? SWEEP_PAGE_REST_MS;
          restCycles++;
          rs.pending.push({ start, n: nextN, due: Date.now() + restMs, rest: restsSoFar + 1 });
          await logEvent(db, meter, "sweep", "page_rested", `start=${start} used ${n} retr${n === 1 ? "y" : "ies"} (${out.error}, ${responseMs ?? "?"} ms); rest ${restsSoFar + 1}: next try in ${Math.round(restMs / 60000)} min; retry requests ${retryRequests}/${SWEEP_RETRY_REQUEST_LIMIT}`);
        } else {
          rs.pending.push({ start, n: nextN, due: Date.now() + retryDelayMs, ...(restsSoFar ? { rest: restsSoFar } : {}) });
        }
        if (rs.streak.length >= SWEEP_STREAK_PAUSE) {
          // Several different pages failing in a row: DABS is likely down -> a short pause so queued retries still fit in
          // the window. Pending retries are kept. The streak restarts after the pause, so the next tick gets up to 3 more
          // attempts before pausing again (instead of re-pausing after every single failure); total requests stay bounded
          // by 3 retries/page, 40 retry requests/day, the daily cap and the window end.
          const pauseMs = cfg.sweepPauseMs ?? SWEEP_STREAK_PAUSE_MS;
          const n0 = rs.streak.length;
          await startBackoff(env, meter, pauseMs);
          rs.streak = [];
          await saveRetry();
          const msg = `${n0} distinct pages in a row hit a transient 5xx/timeout (last: start=${start} ${out.error}); ${Math.round(pauseMs / 60000)} min pause`;
          await logEvent(db, meter, "sweep", "paused", msg);
          await setStatus(env, meter, false, out.status, msg);
          result = { action: "stopped", day, pages, changed, detail: msg };
          break;
        }
        await saveRetry();
        continue;
      }
      if (!out.ok) {
        // Unchanged hard-failure path (429 + 1 h backoff, other HTTP errors, network errors/timeouts, bad shape, suspicious).
        noteFailure(start, out.httpStatus ? `${out.status} ${out.httpStatus}` : out.status, responseMs, false);
        await logFinish(db, meter, id, started, { status: out.status, httpStatus: out.httpStatus, itemCount: out.itemCount, error: out.error, responseMs });
        await failSweep(out.status, `${out.status} at start=${start}: ${out.error}`, out.error);
        break;
      }
      rs.streak = [];
      if (isRetry) recovered++;
      const w = await writeProducts(db, meter, out.products, id, new Date().toISOString());
      changed += w.changed;
      await logFinish(db, meter, id, started, { status: "ok", httpStatus: 200, itemCount: out.products.length, responseMs });

      const totalFirst = st.total_first ?? out.total;
      let degraded = st.degraded;
      if (!degraded && Math.abs(out.total - totalFirst) > OVERLAP) degraded = `total drifted ${totalFirst} -> ${out.total}`;
      const expectedRows = Math.min(PAGE_LEN, out.total - start);
      if (!degraded && out.products.length !== expectedRows) degraded = `page start=${start} had ${out.products.length} rows, expected ${expectedRows}`;
      const nextStart = isRetry ? st.next_start : start + STRIDE;
      const seenAdd = out.products.map((p) => p.sku).join(",") + ",";
      meter.addResult(await db.prepare(
        `UPDATE sweep_state SET next_start = ?, pages_done = pages_done + 1, total_first = COALESCE(total_first, ?), total_last = ?,
           seen = seen || ?, degraded = ?, retry_json = ?, retried = ?, recovered = ?, retry_requests = ?, transient_errors = ?, rest_cycles = ?, page_failures_json = ?, updated_at = ? WHERE day = ?`,
      ).bind(nextStart, out.total, out.total, seenAdd, degraded, JSON.stringify(rs), retried, recovered, retryRequests, transientErrors, restCycles, JSON.stringify(failures), new Date().toISOString(), day).run());
      st = { ...st, next_start: nextStart, total_first: totalFirst, total_last: out.total, seen: st.seen + seenAdd, degraded };

      // Complete only when every page succeeded: main cursor reached the total AND no page is waiting for a retry.
      if (mainDone() && rs.pending.length === 0) {
        const v = await completeSweep(env, meter, st, id);
        await setStatus(env, meter, true, "ok");
        result = { action: "complete", day, pages, changed, detail: v, sweep_status: "complete" };
        break;
      }
    }
    if (lastTick && result.action !== "complete" && result.action !== "failed" && await closeWindowEnded(env, meter, day)) {
      result = { ...result, sweep_status: "failed", detail: `${result.detail ?? ""} window ended with pages unresolved`.trim() };
    }
    if (result.action === "progress") result = { ...result, pages, changed, detail: `next_start=${st.next_start}; retries pending ${rs.pending.length}; retry requests ${retryRequests}/${SWEEP_RETRY_REQUEST_LIMIT}` };
    await client.persist(meter);
    return result;
  } finally {
    await releaseLock(db, meter, holder);
    const trip = await budget.flush();
    if (trip?.firstTrip) await logEvent(db, meter, "sweep", "budget_exhausted", trip.message);
  }
}

/**
 * Last scheduled tick of the window (10:55 UTC hard stop): ANY still-'running' sweep (retry pending, paused, or simply not
 * finished, e.g. the daily cap was hit) is closed as 'failed' so the day is clearly incomplete. (Until 2026-10-27 only
 * sweeps that had seen a transient 5xx/timeout were closed.) Writes no product data, never runs vanish-to-zero, never
 * advances freshness.
 */
async function closeWindowEnded(env: FetcherEnv, meter: Meter, day: string): Promise<boolean> {
  const db = env.DB;
  const row = await db.prepare("SELECT status, retry_json, transient_errors FROM sweep_state WHERE day = ?").bind(day)
    .first<{ status: string; retry_json: string | null; transient_errors: number }>();
  if (!row || row.status !== "running") return false;
  const pend = parseRetry(row.retry_json).pending;
  const unresolved = pend.length, resting = pend.filter((p) => (p.rest ?? 0) > 0);
  const restNote = resting.length ? ` (${resting.length} resting: ${resting.map((p) => `start=${p.start} x${p.rest}`).join(", ")})` : "";
  const msg = unresolved || row.transient_errors > 0
    ? `window_ended: sweep window ended with ${unresolved} page(s) still waiting for a retry${restNote} (incomplete; no vanish-to-zero)`
    : "window_ended: sweep window ended before every page was fetched (incomplete; no vanish-to-zero)";
  // Same-day catch-up (2026-11-13): a nightly window end QUEUES a catch-up of the unfinished pages (window_ended is the
  // only queued failure; retry_limit / 429 / hard errors / suspicious data are not queued: fail closed). A catch-up that
  // itself reaches its hard stop is closed 'failed' and never re-queued.
  meter.addResult(await db.prepare(`UPDATE sweep_state SET status = 'failed', error = ?, updated_at = ?,
      catchup_status = CASE WHEN catchup_status = 'running' THEN 'failed' WHEN catchup_status IS NULL THEN 'queued' ELSE catchup_status END,
      catchup_finished_at = CASE WHEN catchup_status = 'running' THEN ?2 ELSE catchup_finished_at END
    WHERE day = ?3 AND status = 'running'`)
    .bind(msg, new Date().toISOString(), day).run());
  await logEvent(db, meter, "sweep", "window_ended", msg);
  await setStatus(env, meter, false, "window_ended", msg);
  return true;
}

async function completeSweep(env: FetcherEnv, meter: Meter, st: SweepRow, fetchId: number): Promise<string> {
  const db = env.DB;
  const seen = new Set(st.seen.split(",").filter(Boolean));
  const total = st.total_last ?? 0;
  let skipped: string | null = null;
  let applied = 0;
  const prevInStock = await currentlyInStock(db, meter);
  const vanished = prevInStock.filter((s) => !seen.has(s));
  if (st.degraded) skipped = `degraded: ${st.degraded}`;
  else if (seen.size < total * MIN_SEEN_RATIO) skipped = `coverage ${seen.size}/${total} < ${MIN_SEEN_RATIO * 100}%`;
  else if (vanished.length > Math.max(25, prevInStock.length * 0.1)) skipped = `vanished ${vanished.length} of ${prevInStock.length} exceeds safety limit`;
  if (!skipped && vanished.length) {
    await writeVanished(db, meter, vanished, fetchId, new Date().toISOString());
    applied = vanished.length;
  }
  meter.addResult(await db.prepare(
    `UPDATE sweep_state SET status = 'complete', seen = '', vanished_applied = ?, vanish_skipped = ?, completed_at = ?, updated_at = ?,
       catchup_status = CASE WHEN catchup_status = 'running' THEN 'complete' ELSE catchup_status END,
       catchup_finished_at = CASE WHEN catchup_status = 'running' THEN ?3 ELSE catchup_finished_at END WHERE day = ?`,
  ).bind(applied, skipped, new Date().toISOString(), new Date().toISOString(), st.day).run());
  return skipped ? `seen=${seen.size}, vanish skipped (${skipped}), candidates=${vanished.length}` : `seen=${seen.size}, vanished_applied=${applied}`;
}

/** Read-only sweep summary for /health. */
export async function sweepStatus(db: D1Database) {
  const row = await db.prepare(
    `SELECT day, status, pages_done, next_start, total_last AS total, degraded, vanished_applied, vanish_skipped, error, started_at, completed_at,
       retried, recovered, retry_requests, transient_errors, rest_cycles, retry_json, page_failures_json FROM sweep_state ORDER BY day DESC LIMIT 1`,
  ).first<Record<string, unknown>>().catch(() => null);
  if (!row) return null;
  const { retry_json, page_failures_json, ...rest } = row;
  const pend = parseRetry(retry_json as string | null).pending;
  const failed = parseFailures(page_failures_json as string | null);
  return { ...rest, retries_pending: pend.length,
    pages_resting: pend.filter((p) => (p.rest ?? 0) > 0).map((p) => ({ start: p.start, rests: p.rest, next_try_at: new Date(p.due).toISOString() })),
    failed_pages: Object.entries(failed).map(([start, f]) => ({ start: Number(start), ...f })).sort((a, b) => a.start - b.start),
    retry_limits: { max_per_page: SWEEP_MAX_RETRIES_PER_PAGE, request_limit_per_day: SWEEP_RETRY_REQUEST_LIMIT, delay_min: SWEEP_RETRY_DELAY_MS / 60000, streak_pause: SWEEP_STREAK_PAUSE, streak_pause_min: SWEEP_STREAK_PAUSE_MS / 60000, page_rest_min: SWEEP_PAGE_REST_MS / 60000 } };
}
