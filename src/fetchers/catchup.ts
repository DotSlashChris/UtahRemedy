/**
 * Automatic same-day catch-up for an incomplete nightly sweep (owner-approved 2026-11-13, message t79u).
 *
 * Trigger: the nightly sweep's 10:55 UTC hard stop closes a still-running sweep 'failed' (window_ended) and, in the same
 * UPDATE, sets sweep_state.catchup_status = 'queued' (sweep.ts closeWindowEnded). Only window_ended is queued. A sweep that
 * failed on retry_limit (40/day), a 429, a non-transient HTTP/network error, bad shape or the count-collapse check is NOT
 * queued (fail closed; owner decides). A day with no successful page (total unknown) would be a full sweep: skipped.
 *
 * Window: cron "*\/5 20-22 * * *" = 20:00-22:55 UTC = 1:00-3:55 PM MST (2:00-4:55 PM MDT while DST is in effect), after the
 * 04:00-10:55 MST per-store window and the 11:30 MST catalog tick; hard stop at the 22:55 UTC tick.
 *
 * Start (first tick that finds 'queued'): today's DABS requests + unfinished pages must fit min(500, day cap), and the
 * sweep retry counter must have room if retries are pending; otherwise 'skipped' (headroom never grows later the same day).
 * Then the SAME day's row is reopened ('running') and driven by the normal runSweepTick: same counters (retry_requests, runs,
 * dabs_requests continue; nothing reset), 10 s gap, 3 retries/page + 30 min rest, 3-in-a-row 15 min pause and re-pause,
 * 429 1 h backoff, fail-closed validation, vanish-to-zero only on a complete sweep. The cursor continues at next_start and
 * the pending retries, so only unfinished pages are fetched: never a second full sweep. Extra catch-up-only guard: no sweep
 * request starts past min(500, day cap). At the 22:55 UTC tick an unresolved catch-up is closed 'failed' (never re-queued).
 *
 * Per-store follow-on: if the catch-up sweep completes and today's per-store row is 'skipped' because the nightly sweep
 * wasn't complete, and requests + 2 still fit min(500, cap), that skipped row is replaced by a normal per-store pass
 * (runPerstoreTick: same queue rules, 50 retry requests/day, missing-store rule, fail closed, 500 ceiling) with the 22:55 UTC
 * hard stop. One pass at most per day. It never runs on a day whose per-store pass already ran.
 */
import { Meter, mtDay, capsFor, fetcherDisabledReason } from "./guard";
import { runSweepTick, parseRetry, OVERLAP, STRIDE, SWEEP_RETRY_REQUEST_LIMIT, type TickResult } from "./sweep";
import { runPerstoreTick, PERSTORE_DAY_REQUEST_CEILING, REQUESTS_PER_SKU, type PerstoreEnv } from "./perstore";
import { logEvent } from "./store";
import { CATCHUP_LAST_TICK_LOCAL_MIN as CATCHUP_LAST_TICK_LOCAL } from "../schedule";

// Pinned to America/Denver since 2026-11-13 (owner-approved t80u; src/schedule.ts): the cron covers 19:00-22:55 UTC (MDT and
// MST hours) and scheduled() acts only on ticks 1:00-3:55 PM local. Was "*\/5 20-22 * * *" (22:55 UTC hard stop).
export const CATCHUP_CRON = "*/5 19-22 * * *";
export const CATCHUP_LAST_TICK_LOCAL_MIN = CATCHUP_LAST_TICK_LOCAL;   // 15:55 America/Denver = hard stop
export const CATCHUP_WINDOW = { local: "1:00-3:55 PM America/Denver", time_zone: "America/Denver", hard_stop_local: "15:55", utc_cron_hours: "19:00-22:55 (MDT 19-21, MST 20-22)" };

type Row = {
  day: string; status: string; next_start: number; total_last: number | null; pages_done: number; retry_json: string | null;
  retry_requests: number; transient_errors: number; error: string | null; catchup_status: string | null; catchup_perstore: string | null;
};

/** Pages still to fetch: main-cursor pages not yet attempted + pages waiting for a retry. null = total unknown (no page ok). */
export function unfinishedPages(r: { next_start: number; total_last: number | null; retry_json: string | null }): number | null {
  if (r.total_last == null) return null;
  const main = r.next_start + OVERLAP >= r.total_last ? 0 : Math.ceil((r.total_last - OVERLAP - r.next_start) / STRIDE);
  return main + parseRetry(r.retry_json).pending.length;
}

export interface CatchupResult { phase: string; day: string; action: string; detail?: string; sweep?: TickResult; perstore?: unknown }

export async function runCatchupTick(env: PerstoreEnv, opts: { scheduledTime?: number } = {}, fetchImpl?: typeof fetch): Promise<CatchupResult> {
  const day = mtDay();
  const db = env.DB;
  const meter = new Meter();
  const disabled = await fetcherDisabledReason(env);
  if (disabled) return { phase: "none", day, action: "disabled", detail: disabled };
  const ceiling = Math.min(PERSTORE_DAY_REQUEST_CEILING, capsFor().dabs_requests);
  const used = async () => Number((await db.prepare("SELECT dabs_requests FROM fetch_budget WHERE day = ?").bind(day).first<{ dabs_requests: number }>())?.dabs_requests ?? 0);
  const now = () => new Date().toISOString();
  const row = await db.prepare(`SELECT day, status, next_start, total_last, pages_done, retry_json, retry_requests, transient_errors, error,
      catchup_status, catchup_perstore FROM sweep_state WHERE day = ?`).bind(day).first<Row>();
  if (!row?.catchup_status) return { phase: "none", day, action: "noop", detail: row ? `sweep ${row.status}; no catch-up queued` : "no sweep today; nothing to catch up" };

  if (row.catchup_status === "queued") {
    const skip = async (why: string) => {
      meter.addResult(await db.prepare("UPDATE sweep_state SET catchup_status = 'skipped', catchup_note = ?, catchup_finished_at = ?, updated_at = ? WHERE day = ? AND catchup_status = 'queued'")
        .bind(why, now(), now(), day).run());
      await logEvent(db, meter, "catchup", "skipped", why);
      return { phase: "sweep", day, action: "skipped", detail: why };
    };
    if (row.status !== "failed") return skip(`sweep row is ${row.status}, not failed`);
    const left = unfinishedPages(row);
    if (left == null) return skip("no page succeeded overnight (total unknown): a catch-up would be a full sweep");
    const pend = parseRetry(row.retry_json).pending.length;
    if (pend && row.retry_requests + 1 > SWEEP_RETRY_REQUEST_LIMIT) return skip(`sweep retry limit ${SWEEP_RETRY_REQUEST_LIMIT} already used with ${pend} page(s) pending`);
    const u = await used();
    if (u + Math.max(1, left) > ceiling) return skip(`not enough headroom: ${u} DABS requests used + ${left} unfinished page(s) > ${ceiling}`);
    const r = await db.prepare(`UPDATE sweep_state SET status = 'running', catchup_status = 'running', catchup_note = error, error = NULL,
        catchup_started_at = ?1, catchup_base_requests = ?2, catchup_end_requests = ?2, catchup_base_pages = pages_done, catchup_base_retry = retry_requests,
        catchup_base_transients = transient_errors, catchup_unfinished = ?3, updated_at = ?1 WHERE day = ?4 AND status = 'failed' AND catchup_status = 'queued'`)
      .bind(now(), u, left, day).run();
    meter.addResult(r);
    if (!r.meta.changes) return { phase: "sweep", day, action: "noop", detail: "catch-up already started" };
    await logEvent(db, meter, "catchup", "started", `same-day catch-up: ${left} unfinished page(s) (${pend} pending retry), ${u}/${ceiling} requests used, sweep retries ${row.retry_requests}/${SWEEP_RETRY_REQUEST_LIMIT}`);
    row.catchup_status = "running"; row.status = "running";
  }

  if (row.catchup_status === "running") {
    const t = await runSweepTick(env, fetchImpl, { scheduledTime: opts.scheduledTime, lastTickLocalMin: CATCHUP_LAST_TICK_LOCAL_MIN, requestCeiling: ceiling });
    meter.addResult(await db.prepare("UPDATE sweep_state SET catchup_end_requests = ? WHERE day = ?").bind(await used(), day).run());
    if (t.sweep_status !== "complete") return { phase: "sweep", day, action: t.action, detail: t.detail, sweep: t };
    row.catchup_status = "complete";   // sweep.ts completeSweep set it; fall through so per-store can start this tick
  }

  if (row.catchup_status !== "complete") return { phase: "none", day, action: "noop", detail: `catch-up ${row.catchup_status}` };
  let ps = row.catchup_perstore;
  if (ps == null) {
    const p = await db.prepare("SELECT status, error FROM perstore_state WHERE day = ?").bind(day).first<{ status: string; error: string | null }>();
    const set = async (v: string, note: string) => {
      meter.addResult(await db.prepare("UPDATE sweep_state SET catchup_perstore = ?, catchup_perstore_note = ? WHERE day = ? AND catchup_perstore IS NULL").bind(v, note, day).run());
      await logEvent(db, meter, "catchup", `perstore_${v}`, note);
    };
    const u = await used();
    if (!p || p.status !== "skipped" || !(p.error ?? "").startsWith("nightly sweep not complete")) {
      await set("not_needed", p ? `per-store already ${p.status} today` : "no per-store row today (normal window will handle it)");
      return { phase: "perstore", day, action: "not_needed" };
    }
    if (u + REQUESTS_PER_SKU > ceiling) { await set("skipped", `no budget: ${u} used + ${REQUESTS_PER_SKU} > ${ceiling}`); return { phase: "perstore", day, action: "skipped" }; }
    // Replace the day's 'skipped' row so the normal per-store code builds today's queue (same rules) on this tick.
    meter.addResult(await db.prepare("DELETE FROM perstore_state WHERE day = ? AND status = 'skipped'").bind(day).run());
    await set("running", `one-time per-store pass after the catch-up sweep (${u}/${ceiling} requests used)`);
    ps = "running";
  }
  if (ps !== "running") return { phase: "perstore", day, action: "noop", detail: `per-store catch-up ${ps}` };
  const r = await runPerstoreTick(env, { scheduledTime: opts.scheduledTime, lastTickLocalMin: CATCHUP_LAST_TICK_LOCAL_MIN }, fetchImpl);
  meter.addResult(await db.prepare("UPDATE perstore_state SET catchup = 1 WHERE day = ? AND catchup = 0").bind(day).run());
  if (r.status && r.status !== "running") {
    meter.addResult(await db.prepare("UPDATE sweep_state SET catchup_perstore = 'done', catchup_perstore_note = COALESCE(catchup_perstore_note, '') || ?, updated_at = ? WHERE day = ? AND catchup_perstore = 'running'")
      .bind(`; ended ${r.status}`, now(), day).run());
  }
  return { phase: "perstore", day, action: r.action, detail: r.detail, perstore: r };
}

/** /health + daily status: today's and the PREVIOUS Utah day's catch-up (the daily status runs ~11:15 AM, before the window). */
export async function catchupStatus(db: D1Database) {
  const rows = await db.prepare(`SELECT s.day, s.status AS sweep_status, s.catchup_status, s.catchup_note, s.catchup_started_at, s.catchup_finished_at,
      s.catchup_unfinished, s.pages_done - s.catchup_base_pages AS pages_ok, s.retry_requests - s.catchup_base_retry AS retries_used,
      s.retry_requests AS sweep_retries_total, s.transient_errors - s.catchup_base_transients AS transients,
      s.catchup_end_requests - s.catchup_base_requests AS sweep_requests, s.total_last AS in_stock_total, s.vanished_applied, s.vanish_skipped,
      s.retry_json, s.error AS sweep_error, s.catchup_perstore, s.catchup_perstore_note,
      p.status AS perstore_status, p.ok AS perstore_ok, p.failed AS perstore_failed, p.accepted_inferred AS perstore_inferred,
      p.qty_mismatch_above + p.qty_mismatch_below AS perstore_qty_mismatch, p.retry_cap_dropped AS perstore_cap_drops, p.requests AS perstore_requests,
      p.completed_at AS perstore_completed_at, b.dabs_requests AS day_dabs_requests
    FROM sweep_state s LEFT JOIN perstore_state p ON p.day = s.day AND p.catchup = 1 LEFT JOIN fetch_budget b ON b.day = s.day
    ORDER BY s.day DESC LIMIT 2`).all<Record<string, unknown>>().catch(() => null);
  const pauses = async (r: Record<string, unknown>) => r.catchup_started_at ? Number((await db.prepare(
    "SELECT COUNT(*) n FROM fetch_log WHERE kind = 'sweep' AND status = 'paused' AND started_at >= ? AND started_at <= COALESCE(?, '9999')",
  ).bind(r.catchup_started_at, r.catchup_finished_at ?? null).first<{ n: number }>().catch(() => null))?.n ?? 0) : null;
  const out = [];
  for (const r of rows?.results ?? []) {
    const { retry_json, ...rest } = r;
    out.push(r.catchup_status ? { ...rest, pages_failed: parseRetry(retry_json as string | null).pending.map((p) => p.start), pauses: await pauses(r) } : { day: r.day, sweep_status: r.sweep_status, catchup_status: null });
  }
  return { cron: CATCHUP_CRON, window: CATCHUP_WINDOW, trigger: "nightly sweep closed window_ended -> queued", today: out[0] ?? null, previous_day: out[1] ?? null };
}
