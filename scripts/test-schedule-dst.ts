/**
 * Local-time pin tests (owner-approved 2026-11-13, t80u). Pure logic, ZERO requests: simulates every UTC minute of a day
 * against the registered crons (wrangler.jsonc, cross-checked with EXPECTED_CRONS in src/index.ts) and the scheduled()
 * gate (src/schedule.ts inLocalWindow), on Jan 15 2027 (MST), Jul 15 2027 (MDT), Mar 14 2027 (spring forward) and
 * Nov 7 2027 (fall back), plus catalog days. Run: node --experimental-strip-types scripts/test-schedule-dst.ts
 */
import { readFileSync } from "node:fs";
import { cronMatches, inLocalWindow, localTime, isLocalLastTick, LOCAL_WINDOWS, SWEEP_LAST_TICK_LOCAL_MIN, PERSTORE_LAST_TICK_LOCAL_MIN, CATCHUP_LAST_TICK_LOCAL_MIN, nextLocalOpen, type Job } from "../src/schedule.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, info = "") => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${info}`); } };

const wj = readFileSync("wrangler.jsonc", "utf8");
const crons: string[] = JSON.parse(wj.match(/"crons":\s*(\[[^\]]*\])/)![1]);
const idx = readFileSync("src/index.ts", "utf8");
const block = idx.slice(idx.indexOf("export const EXPECTED_CRONS"), idx.indexOf("};", idx.indexOf("export const EXPECTED_CRONS")));
const EXPECTED: Record<string, Job> = Object.fromEntries([...block.matchAll(/^\s*"([^"]+)":\s*"(\w+)"/gm)].map((m) => [m[1], m[2] as Job]));
check("crons: wrangler.jsonc == EXPECTED_CRONS keys", JSON.stringify([...crons].sort()) === JSON.stringify(Object.keys(EXPECTED).sort()), `${crons} vs ${Object.keys(EXPECTED)}`);
check("cron count 5 (same as before; Paid limit 250/account)", crons.length === 5, String(crons.length));
const catchupTs = readFileSync("src/fetchers/catchup.ts", "utf8");
check("CATCHUP_CRON is registered for catchup", EXPECTED[catchupTs.match(/CATCHUP_CRON = "([^"]+)"/)![1]] === "catchup");

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const range = (a: number, b: number) => { const r: number[] = []; for (let m = a; m <= b; m += 5) r.push(m); return r; };

interface Tick { utc: string; ms: number; job: Job; local: string; min: number; zone: string }
/** Every tick that ACTS (passes the gate) between UTC [startMs, startMs+hours). Also counts no-op firings. */
function simulate(startMs: number, hours: number) {
  const acts: Tick[] = []; let noops = 0, firings = 0, multi = 0;
  for (let t = startMs; t < startMs + hours * 3600000; t += 60000) {
    const fired = crons.filter((c) => cronMatches(c, t));
    const acting = fired.filter((c) => inLocalWindow(EXPECTED[c], t));
    firings += fired.length; noops += fired.length - acting.length;
    if (acting.length > 1) multi++;
    for (const c of acting) { const lt = localTime(t); acts.push({ utc: new Date(t).toISOString().slice(11, 16), ms: t, job: EXPECTED[c], local: lt.text, min: lt.minute, zone: lt.zone }); }
  }
  return { acts, noops, firings, multi };
}
const byJob = (acts: Tick[], j: Job) => acts.filter((a) => a.job === j);
const localMins = (ts: Tick[]) => ts.map((t) => t.min);
const eq = (a: number[], b: number[]) => JSON.stringify(a) === JSON.stringify(b);
const lastTicks = (ts: Tick[], last: number) => ts.filter((t) => isLocalLastTick(t.ms, last));

// The 24 UTC hours that contain local day D's windows: local 00:00 -> 23:59 is 06:00/07:00 UTC on D -> next day. Simulate
// UTC D 05:00 .. D+1 06:00 (25 h) and keep ticks whose local day is D.
function day(dateUtc: string) {
  const s = simulate(Date.parse(`${dateUtc}T05:00:00Z`), 25);
  const acts = s.acts.filter((a) => a.local.startsWith(dateUtc));
  return { ...s, acts };
}

function steadyDay(label: string, date: string, zone: string, utcOffsetH: number) {
  const d = day(date);
  const sw = byJob(d.acts, "sweep"), ps = byJob(d.acts, "perstore"), cu = byJob(d.acts, "catchup"), ca = byJob(d.acts, "catalog");
  check(`${label}: all acting ticks are ${zone}`, d.acts.every((a) => a.zone === zone));
  check(`${label}: sweep 00:30-03:55 local, 42 ticks`, eq(localMins(sw), range(30, 235)), `${sw.length} ${sw[0]?.local}..${sw.at(-1)?.local}`);
  check(`${label}: sweep hard stop only at 03:55 local (${hm(235 + utcOffsetH * 60)} UTC)`, lastTicks(sw, SWEEP_LAST_TICK_LOCAL_MIN).map((t) => t.min).join() === "235" && sw.at(-1)!.utc === hm(235 + utcOffsetH * 60));
  check(`${label}: per-store 04:00-10:55 local, 84 ticks, hard stop only 10:55`, eq(localMins(ps), range(240, 655)) && lastTicks(ps, PERSTORE_LAST_TICK_LOCAL_MIN).map((t) => t.min).join() === "655");
  check(`${label}: catch-up 13:00-15:55 local, 36 ticks, hard stop only 15:55`, eq(localMins(cu), range(780, 955)) && lastTicks(cu, CATCHUP_LAST_TICK_LOCAL_MIN).map((t) => t.min).join() === "955");
  const dom = Number(date.slice(8));
  check(`${label}: catalog ${dom >= 2 && dom <= 8 ? "once at 11:30 local" : "absent"} on day ${dom} (days 2-8 only)`, dom >= 2 && dom <= 8 ? ca.length === 1 && ca[0].min === 690 : ca.length === 0);
  check(`${label}: never two jobs acting on one tick`, d.multi === 0);
  console.log(`  ${label}: sweep ${sw[0].utc}-${sw.at(-1)!.utc} UTC, per-store ${ps[0].utc}-${ps.at(-1)!.utc} UTC, catch-up ${cu[0].utc}-${cu.at(-1)!.utc} UTC; ${d.firings} firings/25h, ${d.noops} no-op`);
}
steadyDay("Jan 15 2027 (MST)", "2027-01-15", "MST", 7);
steadyDay("Jul 15 2027 (MDT)", "2027-07-15", "MDT", 6);

// Equivalence with the pre-2026-11-13 UTC crons in MST: same acting (UTC minute, job) set.
{
  const OLD: Record<string, Job> = { "30-55/5 7 * * *": "sweep", "*/5 8-10 * * *": "sweep", "*/5 11-17 * * *": "perstore", "30 18 2-8 * *": "catalog", "*/5 20-22 * * *": "catchup" };
  for (const date of ["2027-01-05", "2027-01-15", "2026-11-14", "2026-12-03"]) {
    const start = Date.parse(`${date}T00:00:00Z`);
    const oldSet: string[] = [], newSet: string[] = [];
    for (let t = start; t < start + 86400000; t += 60000) {
      for (const [c, j] of Object.entries(OLD)) if (cronMatches(c, t)) oldSet.push(`${t}:${j}`);
      for (const c of crons) if (cronMatches(c, t) && inLocalWindow(EXPECTED[c], t)) newSet.push(`${t}:${EXPECTED[c]}`);
    }
    check(`MST ${date}: new acting ticks == old UTC schedule (no behavior change in winter)`, eq(oldSet.sort() as any, newSet.sort() as any), `${oldSet.length} vs ${newSet.length}`);
  }
}

// Catalog: 11:30 local on days 2-8, both seasons, exactly once a day.
for (const [date, zone, utc] of [["2027-01-05", "MST", "18:30"], ["2027-07-05", "MDT", "17:30"], ["2027-03-02", "MST", "18:30"], ["2027-11-08", "MST", "18:30"]] as const) {
  const ca = byJob(day(date).acts, "catalog");
  check(`catalog ${date} (${zone}): one tick at 11:30 local = ${utc} UTC`, ca.length === 1 && ca[0].min === 690 && ca[0].utc === utc, JSON.stringify(ca));
}
check("catalog day 1 / day 9: no tick", byJob(day("2027-07-01").acts, "catalog").length === 0 && byJob(day("2027-01-09").acts, "catalog").length === 0);

// Spring forward: Sun Mar 14 2027, 02:00 MST -> 03:00 MDT (local 02:00-02:59 does not exist).
{
  const d = day("2027-03-14");
  const sw = byJob(d.acts, "sweep"), ps = byJob(d.acts, "perstore"), cu = byJob(d.acts, "catchup");
  const want = [...range(30, 115), ...range(180, 235)];
  check("Mar 14 2027: sweep 00:30-01:55 MST + 03:00-03:55 MDT (30 ticks, 02:xx skipped)", eq(localMins(sw), want), `${sw.map((t) => t.local).join(" | ")}`);
  check("Mar 14 2027: sweep UTC 07:30-08:55 then 09:00-09:55", sw[0].utc === "07:30" && sw.at(-1)!.utc === "09:55" && sw.length === 30);
  check("Mar 14 2027: sweep hard stop exactly once, at 03:55 MDT (09:55 UTC)", lastTicks(sw, SWEEP_LAST_TICK_LOCAL_MIN).length === 1 && lastTicks(sw, SWEEP_LAST_TICK_LOCAL_MIN)[0].utc === "09:55");
  check("Mar 14 2027: per-store 04:00-10:55 MDT (10:00-16:55 UTC), 84 ticks, hard stop 10:55", eq(localMins(ps), range(240, 655)) && ps[0].utc === "10:00" && ps.at(-1)!.utc === "16:55");
  check("Mar 14 2027: catch-up 13:00-15:55 MDT (19:00-21:55 UTC)", eq(localMins(cu), range(780, 955)) && cu[0].utc === "19:00" && cu.at(-1)!.utc === "21:55");
  check("Mar 14 2027: never two jobs acting on one tick", d.multi === 0);
  // 10:00-10:55 UTC: sweep expression fires but is a no-op (it's 04:xx MDT); per-store acts.
  const t1000 = Date.parse("2027-03-14T10:00:00Z");
  check("Mar 14 2027 10:00 UTC: sweep cron no-op, per-store acts", !inLocalWindow("sweep", t1000) && inLocalWindow("perstore", t1000));
  // Day before (Mar 13, MST) unchanged.
  steadyDay("Mar 13 2027 (MST, eve of spring forward)", "2027-03-13", "MST", 7);
  steadyDay("Mar 15 2027 (MDT, after)", "2027-03-15", "MDT", 6);
}

// Fall back: Sun Nov 7 2027, 02:00 MDT -> 01:00 MST (local 01:00-01:55 happens twice).
{
  const d = day("2027-11-07");
  const sw = byJob(d.acts, "sweep"), ps = byJob(d.acts, "perstore"), cu = byJob(d.acts, "catchup");
  const want = [...range(30, 115), ...range(60, 235)];
  check("Nov 7 2027: sweep 00:30-01:55 MDT + 01:00-03:55 MST (54 ticks, repeated 01:xx hour)", eq(localMins(sw), want), `${sw.length}`);
  check("Nov 7 2027: sweep UTC 06:30-10:55, all one Utah day", sw[0].utc === "06:30" && sw.at(-1)!.utc === "10:55" && new Set(sw.map((t) => t.local.slice(0, 10))).size === 1);
  check("Nov 7 2027: hard stop exactly once, at 03:55 MST (10:55 UTC), not in the repeated hour", lastTicks(sw, SWEEP_LAST_TICK_LOCAL_MIN).length === 1 && lastTicks(sw, SWEEP_LAST_TICK_LOCAL_MIN)[0].utc === "10:55");
  check("Nov 7 2027: no two sweep ticks share a UTC instant (repeated hour = distinct ticks, not double firing)", new Set(sw.map((t) => t.ms)).size === sw.length);
  check("Nov 7 2027: per-store 04:00-10:55 MST (11:00-17:55 UTC), 84 ticks", eq(localMins(ps), range(240, 655)) && ps[0].utc === "11:00" && ps.at(-1)!.utc === "17:55");
  check("Nov 7 2027: catch-up 13:00-15:55 MST (20:00-22:55 UTC)", eq(localMins(cu), range(780, 955)) && cu[0].utc === "20:00");
  check("Nov 7 2027: never two jobs acting on one tick", d.multi === 0);
  steadyDay("Nov 6 2027 (MDT, eve of fall back)", "2027-11-06", "MDT", 6);
  steadyDay("Nov 8 2027 (MST, after)", "2027-11-08", "MST", 7);
}

// Out-of-window ticks of each expression are no-ops (gate false), e.g. sweep cron at 23:30/00:25 local, 04:xx local.
{
  const noop = (iso: string, job: Job) => !inLocalWindow(job, Date.parse(iso));
  check("no-op: sweep 06:30 UTC Jan (23:30 MST previous day)", noop("2027-01-15T06:30:00Z", "sweep"));
  check("no-op: sweep 07:25 UTC Jan (00:25 MST, before 00:30)", noop("2027-01-15T07:25:00Z", "sweep"));
  check("no-op: sweep 10:00-10:55 UTC Jul (04:xx MDT)", range(0, 55).every((m) => noop(`2027-07-15T10:${String(m).padStart(2, "0")}:00Z`, "sweep")));
  check("no-op: per-store 10:00-10:55 UTC Jan (03:xx MST)", range(0, 55).every((m) => noop(`2027-01-15T10:${String(m).padStart(2, "0")}:00Z`, "perstore")));
  check("no-op: per-store 17:00-17:55 UTC Jul (11:xx MDT)", range(0, 55).every((m) => noop(`2027-07-15T17:${String(m).padStart(2, "0")}:00Z`, "perstore")));
  check("no-op: catalog 17:30 UTC Jan (10:30 MST)", noop("2027-01-05T17:30:00Z", "catalog"));
  check("no-op: catalog 18:30 UTC Jul (12:30 MDT)", noop("2027-07-05T18:30:00Z", "catalog"));
  check("no-op: catch-up 19:xx UTC Jan (12:xx MST)", noop("2027-01-15T19:00:00Z", "catchup") && noop("2027-01-15T19:55:00Z", "catchup"));
  check("no-op: catch-up 22:xx UTC Jul (16:xx MDT)", noop("2027-07-15T22:00:00Z", "catchup") && noop("2027-07-15T22:55:00Z", "catchup"));
  check("manual (no scheduledTime) is never a last tick", !isLocalLastTick(undefined, SWEEP_LAST_TICK_LOCAL_MIN));
}

// /health next-open helper.
{
  const from = Date.parse("2027-03-13T12:00:00Z");   // Mar 13 05:00 MST
  const n = nextLocalOpen("sweep", crons.filter((c) => EXPECTED[c] === "sweep"), from);
  check("nextLocalOpen sweep from Mar 13 05:00 MST = Mar 14 00:30 MST (07:30 UTC)", n === Date.parse("2027-03-14T07:30:00Z"), n ? new Date(n).toISOString() : "null");
  const p = nextLocalOpen("perstore", crons.filter((c) => EXPECTED[c] === "perstore"), from);
  check("nextLocalOpen per-store after spring forward = Mar 14 04:00 MDT (10:00 UTC)", p === Date.parse("2027-03-14T10:00:00Z"), p ? new Date(p).toISOString() : "null");
  const c = nextLocalOpen("catalog", crons.filter((x) => EXPECTED[x] === "catalog"), Date.parse("2027-03-09T00:00:00Z"));
  check("nextLocalOpen catalog from Mar 9 = Apr 2 11:30 MDT (17:30 UTC)", c === Date.parse("2027-04-02T17:30:00Z"), c ? new Date(c).toISOString() : "null");
}

// Year sweep: every day Nov 14 2026 .. Dec 31 2027, every window acts at its local times, never two jobs on one tick.
{
  let bad: string[] = [];
  for (let t = Date.parse("2026-11-14T00:00:00Z"); t < Date.parse("2028-01-01T00:00:00Z"); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const d = day(date);
    if (d.multi) bad.push(`${date} multi`);
    const sw = localMins(byJob(d.acts, "sweep"));
    if (date !== "2027-03-14" && date !== "2027-11-07" && !eq(sw, range(30, 235))) bad.push(`${date} sweep`);
    if (!eq(localMins(byJob(d.acts, "perstore")), range(240, 655))) bad.push(`${date} perstore`);
    if (!eq(localMins(byJob(d.acts, "catchup")), range(780, 955))) bad.push(`${date} catchup`);
    const dom = Number(date.slice(8)); const ca = byJob(d.acts, "catalog");
    if ((dom >= 2 && dom <= 8) ? !(ca.length === 1 && ca[0].min === 690) : ca.length) bad.push(`${date} catalog`);
  }
  check("every day 2026-11-14..2027-12-31: windows at the same local times (only the 2 transition nights differ, as above)", bad.length === 0, bad.slice(0, 10).join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
