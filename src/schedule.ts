/**
 * Local-time pinning of every scheduled DABS window (owner-approved 2026-11-13, message t80u).
 *
 * Cloudflare Cron Triggers are UTC-only. Each window is therefore registered as the UNION of its MST (UTC-7) and MDT (UTC-6)
 * UTC hours, and scheduled() runs a job ONLY when the tick's scheduledTime, read in America/Denver with Intl (no hardcoded
 * offsets), falls inside that job's local window. A tick outside its local window returns before anything else: no D1 read,
 * no KV read, no lock, no run charged, no DABS request, no state change.
 *
 * Local windows (America/Denver, all year; the same clock times as the MST schedule in force on 2026-11-13):
 *   sweep     00:30-03:55, hard stop at the 03:55 local tick
 *   perstore  04:00-10:55, hard stop at the 10:55 local tick
 *   catalog   11:30 on local days 2-8 (cron path still paused unless KV catalog:v1:auto = "on")
 *   catchup   13:00-15:55, hard stop at the 15:55 local tick
 * The windows are disjoint in local time, so at most one job acts on any tick, even where two registered expressions fire
 * in the same UTC minute (10:00-10:55 UTC: sweep in MST, per-store in MDT; 17:30 UTC on days 2-8: per-store in MST,
 * catalog in MDT). The other one is a pure no-op.
 *
 * DST: spring forward (e.g. 2027-03-14, 02:00 MST -> 03:00 MDT) the local 02:00-02:59 hour does not exist, so that night's
 * sweep has 30 ticks instead of 42 (00:30-01:55 MST + 03:00-03:55 MDT). Fall back (e.g. 2027-11-07, 02:00 MDT -> 01:00 MST)
 * the local 01:00-01:55 hour happens twice, so that night's sweep has 54 ticks; the repeated hour is just more ticks of the
 * same Utah day (same day key, same sweep_state row, same counters and caps); only the single 03:55 MST tick is the hard stop.
 * Per-store, catalog and catch-up are never on a transition hour.
 *
 * The Utah-day key (guard.ts mtDay(): America/Denver date of the execution time) is unchanged.
 */

export type Job = "sweep" | "perstore" | "catalog" | "catchup";
export const SCHEDULE_TZ = "America/Denver";

export interface LocalWindow { first: number; last: number; days?: [number, number]; label: string }
/** Minutes after local midnight. */
export const LOCAL_WINDOWS: Record<Job, LocalWindow> = {
  sweep: { first: 30, last: 3 * 60 + 55, label: "12:30-3:55 AM America/Denver (hard stop at the 3:55 AM tick)" },
  perstore: { first: 4 * 60, last: 10 * 60 + 55, label: "4:00-10:55 AM America/Denver (hard stop at the 10:55 AM tick)" },
  catalog: { first: 11 * 60 + 30, last: 11 * 60 + 30, days: [2, 8], label: "11:30 AM America/Denver on days 2-8 (paused unless KV catalog:v1:auto = on)" },
  catchup: { first: 13 * 60, last: 15 * 60 + 55, label: "1:00-3:55 PM America/Denver (hard stop at the 3:55 PM tick)" },
};
/** Hard-stop (last tick) local minute per window, used by sweep.ts / perstore.ts / catchup.ts. */
export const SWEEP_LAST_TICK_LOCAL_MIN = LOCAL_WINDOWS.sweep.last;
export const PERSTORE_LAST_TICK_LOCAL_MIN = LOCAL_WINDOWS.perstore.last;
export const CATCHUP_LAST_TICK_LOCAL_MIN = LOCAL_WINDOWS.catchup.last;

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

export interface LocalTime { day: string; dom: number; minute: number; zone: string; text: string }
/** Wall-clock time in America/Denver for an instant (ms since epoch). */
export function localTime(ms: number): LocalTime {
  const p: Record<string, string> = {};
  for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  const h = Number(p.hour) % 24, m = Number(p.minute);
  return { day: `${p.year}-${p.month}-${p.day}`, dom: Number(p.day), minute: h * 60 + m, zone: p.timeZoneName, text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}` };
}

/** True when a tick at `ms` is inside `job`'s America/Denver window. */
export function inLocalWindow(job: Job, ms: number): boolean {
  const w = LOCAL_WINDOWS[job];
  const t = localTime(ms);
  if (t.minute < w.first || t.minute > w.last) return false;
  if (w.days && (t.dom < w.days[0] || t.dom > w.days[1])) return false;
  return true;
}

/** True for a scheduled tick at/after the window's last local tick. Manual (admin) ticks have no scheduledTime: never last. */
export function isLocalLastTick(scheduledTime: number | undefined, lastLocalMin: number): boolean {
  if (!scheduledTime) return false;
  return localTime(scheduledTime).minute >= lastLocalMin;
}

// ---------- minimal cron matcher (only for /health "next open" and tests; scheduled() uses the exact-string allowlist) ----------
function field(spec: string, v: number): boolean {
  return spec.split(",").some((part) => {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    let lo: number, hi: number;
    if (range === "*") { lo = 0; hi = 99; } else if (range.includes("-")) { [lo, hi] = range.split("-").map(Number); } else { lo = hi = Number(range); if (stepS) hi = 99; }
    return v >= lo && v <= hi && (v - lo) % step === 0;
  });
}
/** Does a 5-field cron (min hour dom mon dow; UTC) match the UTC minute `ms`? Supports *, a-b, a,b and /step. */
export function cronMatches(expr: string, ms: number): boolean {
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const d = new Date(ms);
  return field(mi, d.getUTCMinutes()) && field(h, d.getUTCHours()) && field(dom, d.getUTCDate()) && field(mon, d.getUTCMonth() + 1) && field(dow, d.getUTCDay());
}

/** The first tick at/after `fromMs` that opens `job`'s local window (local minute == window start) under the given crons. */
export function nextLocalOpen(job: Job, crons: string[], fromMs = Date.now(), horizonDays = 40): number | null {
  const step = 5 * 60 * 1000;
  let t = Math.ceil(fromMs / step) * step;
  const end = fromMs + horizonDays * 86400000;
  for (; t <= end; t += step) {
    if (!crons.some((c) => cronMatches(c, t))) continue;
    if (inLocalWindow(job, t) && localTime(t).minute === LOCAL_WINDOWS[job].first) return t;
  }
  return null;
}
