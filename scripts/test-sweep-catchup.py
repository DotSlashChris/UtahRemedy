#!/usr/bin/env python3
"""Sweep suite: same-day catch-up for an incomplete nightly sweep (src/fetchers/catchup.ts, owner-approved 2026-11-13).
ZERO real DABS requests: reuses scripts/test-sweep-retry.py's harness (mock-dabs.py on 9911 + `wrangler dev --local` on 8788,
throwaway persist dir /tmp/ur-sweep-test). Run it as its OWN job (never alongside the per-store suite or test-sweep-retry.py:
same ports). The admin token stays in memory only.

Run:  python3 scripts/test-sweep-catchup.py [c1 c2 ...]    # exits non-zero on any failure
Mock catalog: 199 in-stock items -> 5 pages (start 0, 48, 96, 144, 192)."""
import importlib.util, json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("swr", os.path.join(HERE, "test-sweep-retry.py")); H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
check, d1, row, tick, sched, baseline, reset_day, start_mock, mock_set, page_hits, all_hits, used, runs, inv, wait, kv_del = (
    H.check, H.d1, H.row, H.tick, H.sched, H.baseline, H.reset_day, H.start_mock, H.mock_set, H.page_hits, H.all_hits, H.used, H.runs, H.inv, H.wait, H.kv_del)
CU = "*/5 19-22 * * *"   # local-time pinned 2026-11-13 (was */5 20-22); sched() uses an MST date, so 20:00-22:55 UTC = 1:00-3:55 PM
def st(): return row("SELECT status, error, catchup_status, catchup_note, catchup_unfinished, catchup_base_requests, catchup_end_requests, retry_requests, transient_errors, pages_done, vanished_applied, next_start, retry_json, catchup_perstore, catchup_perstore_note FROM sweep_state")
def nightly_close(): sched("*/5 7-10 * * *", 10, 55)
def health_cu(): return (json.load(urllib.request.urlopen(H.BASE + "/health")).get("fetcher") or {}).get("sweep_catchup") or {}
def hits(): return dict(json.load(urllib.request.urlopen(H.MOCK + "/__stats"))["page"])

def c1_queue_on_window_end():
    print("C1: nightly window end with a page pending -> failed window_ended AND catchup queued; nothing partial applied")
    baseline(); mock_set(page_mode={"96": "fail:522:1"})
    tick(); nightly_close(); s = st()
    check("C1 nightly closed failed/window_ended", s["status"] == "failed" and "window_ended" in (s["error"] or ""), str(s))
    check("C1 catch-up queued", s["catchup_status"] == "queued", str(s))
    check("C1 no vanish yet (item 199 still in stock)", s["vanished_applied"] is None and inv(199)["q"] > 0)
    return s

def c2_catchup_completes_unfinished_only():
    print("C2: 20:00 UTC catch-up tick fetches ONLY the unfinished page, counters continue, completes, vanish applied")
    s0 = c1_queue_on_window_end(); wait()
    h0, u0, r0 = hits(), used(), runs()
    sched(CU, 20, 0); s = st()
    h1 = hits(); delta = {k: h1.get(k, 0) - h0.get(k, 0) for k in set(h0) | set(h1)}
    check("C2 sweep complete, catchup complete", s["status"] == "complete" and s["catchup_status"] == "complete", str(s))
    check("C2 only page 96 requested (1 request), never a second full sweep", {k: v for k, v in delta.items() if v} == {"96": 1} and used() == u0 + 1, f"{delta} {used()} {u0}")
    check("C2 retry counter continued (1 -> 2), not reset", s0["retry_requests"] == 0 and s["retry_requests"] == 1, f"{s0['retry_requests']} {s['retry_requests']}")
    check("C2 one run charged", runs() == r0 + 1, f"{runs()} {r0}")
    check("C2 vanish-to-zero applied as a normal complete sweep (item 199 -> 0)", (s["vanished_applied"] or 0) >= 1 and inv(199)["q"] == 0, str(s))
    check("C2 catch-up bookkeeping: unfinished 1, base/end requests", s["catchup_unfinished"] == 1 and s["catchup_end_requests"] - s["catchup_base_requests"] == 1 and "window_ended" in (s["catchup_note"] or ""), str(s))
    t = health_cu().get("today") or {}
    check("C2 /health sweep_catchup.today reports the result", t.get("catchup_status") == "complete" and t.get("pages_ok") == 1 and t.get("sweep_requests") == 1 and t.get("retries_used") == 1, str(t))
    check("C2 /health shows the window", health_cu().get("cron") == CU and (health_cu().get("window") or {}).get("hard_stop_local") == "15:55")
    u1 = used(); sched(CU, 20, 5); sched(CU, 21, 0)
    check("C2 later catch-up ticks: no sweep requests, sweep stays complete", st()["status"] == "complete" and hits().get("96") == h1.get("96") and used() == u1)

def c3_unattempted_pages_after_pause():
    print("C3: streak pause leaves page 192 never attempted -> catch-up does 48/96/144 retries + 192 only")
    baseline(); mock_set(page_mode={"48": "fail:522:1", "96": "fail:522:1", "144": "fail:522:1"})
    tick(); nightly_close(); s = st()
    check("C3 queued with 4 unfinished (3 pending + 1 unattempted)", s["catchup_status"] == "queued" and s["next_start"] == 192, str(s))
    kv_del("dabs:v1:backoff_until"); wait(); h0 = hits()
    sched(CU, 20, 0); s = st(); h1 = hits()
    delta = {k: h1.get(k, 0) - h0.get(k, 0) for k in set(h0) | set(h1) if h1.get(k, 0) != h0.get(k, 0)}
    check("C3 complete; page 0 not re-fetched; 48/96/144/192 once each", s["status"] == "complete" and s["catchup_unfinished"] == 4 and delta == {"48": 1, "96": 1, "144": 1, "192": 1}, f"{delta} {s}")

def c4_hard_failures_not_queued():
    print("C4: 429 / bad shape / retry_limit failures are NOT queued (fail closed); catch-up tick is a no-op with 0 requests")
    for mode in ({"page_mode": {"96": "fail:429:*"}}, {"fail_at": 96, "fail_kind": "badshape"}):
        baseline(); mock_set(**mode); tick(); kv_del("dabs:v1:backoff_until"); nightly_close(); s = st()
        u0 = used(); sched(CU, 20, 0); s2 = st()
        check(f"C4 {mode}: failed, not queued, catch-up no-op", s["status"] == "failed" and s["catchup_status"] is None and s2["status"] == "failed" and used() == u0, f"{s} {s2}")
    baseline(); mock_set(page_mode={"96": "fail:522:1"}); tick()
    d1("UPDATE sweep_state SET retry_requests = 40"); nightly_close(); s = st(); u0 = used()
    sched(CU, 20, 0); s2 = st()
    check("C4 retry cap already used with a page pending -> skipped, 0 requests", s["catchup_status"] == "queued" and s2["catchup_status"] == "skipped" and "retry limit" in (s2["catchup_note"] or "") and used() == u0, f"{s2}")

def c5_no_headroom_skipped():
    print("C5: not enough headroom under min(500, cap) -> skipped, 0 requests; ceiling also stops mid-catch-up")
    c1_queue_on_window_end(); d1("UPDATE fetch_budget SET dabs_requests = 500"); u0 = used(); wait()
    sched(CU, 20, 0); s = st()
    check("C5 skipped (headroom), sweep stays failed, 0 requests", s["catchup_status"] == "skipped" and s["status"] == "failed" and "headroom" in (s["catchup_note"] or "") and used() == u0, str(s))
    # mid-run: 2 unfinished pages, 498 used -> page 144 ok (499), page 96 fails (500) -> its retry would pass 500 -> stop
    baseline(); mock_set(page_mode={"96": "fail:522:1", "144": "fail:522:1"}); tick(); nightly_close()
    d1("UPDATE fetch_budget SET dabs_requests = 498"); mock_set(page_mode={"96": "fail:522:*"}); wait()
    sched(CU, 20, 0); wait(); sched(CU, 20, 5); s = st()
    check("C5 mid-run ceiling: never past 500, sweep still incomplete (no vanish)", used() <= 500 and s["status"] == "running" and s["vanished_applied"] is None, f"{used()} {s}")
    check("C5 ceiling event logged", row("SELECT COUNT(*) n FROM fetch_log WHERE kind='sweep' AND status='ceiling'")["n"] >= 1)
    sched(CU, 22, 55); s = st()
    check("C5 22:55 UTC hard stop closes it failed; catch-up failed, not re-queued", s["status"] == "failed" and s["catchup_status"] == "failed", str(s))
    u1 = used(); sched(CU, 20, 0)
    check("C5 no re-run after failure", st()["catchup_status"] == "failed" and used() == u1)

def c6_catchup_hard_stop():
    print("C6: catch-up still failing at 22:55 UTC -> failed (window_ended), no vanish, freshness not advanced, never re-queued")
    c1_queue_on_window_end(); mock_set(page_mode={"96": "fail:522:*"}); wait()
    sched(CU, 20, 0); s = st()
    check("C6 first catch-up attempt failed transiently, still running", s["status"] == "running" and s["catchup_status"] == "running", str(s))
    sched(CU, 22, 55); s = st()
    check("C6 hard stop: failed + catchup failed, no vanish", s["status"] == "failed" and s["catchup_status"] == "failed" and "window_ended" in (s["error"] or "") and s["vanished_applied"] is None and inv(199)["q"] > 0, str(s))
    t = health_cu().get("today") or {}
    check("C6 /health lists the failed page", t.get("catchup_status") == "failed" and 96 in (t.get("pages_failed") or []), str(t))

def c7_idle_and_previous_day():
    print("C7: clean day -> catch-up ticks are no-ops (no lock/run/request); /health shows previous_day")
    baseline(); mock_set(); tick(); u0, r0 = used(), runs()
    for hh, mm in ((20, 0), (21, 30), (22, 55)): sched(CU, hh, mm)
    check("C7 clean day: no requests, no runs", used() == u0 and runs() == r0 and st()["catchup_status"] is None)
    d1("INSERT INTO sweep_state (day, status, started_at, updated_at, catchup_status, catchup_started_at, catchup_finished_at, catchup_base_pages, pages_done, catchup_base_retry, retry_requests, catchup_base_transients, transient_errors, catchup_base_requests, catchup_end_requests) VALUES ('2000-01-01', 'complete', 'x', 'x', 'complete', '2000-01-01T20:00:00Z', '2000-01-01T20:10:00Z', 84, 115, 24, 27, 27, 27, 111, 142)")
    d1("DELETE FROM sweep_state WHERE day NOT IN ('2000-01-01', (SELECT MAX(day) FROM sweep_state))")
    p = health_cu().get("previous_day") or {}
    check("C7 /health previous_day carries the earlier catch-up", p.get("day") == "2000-01-01" and p.get("pages_ok") == 31 and p.get("sweep_requests") == 31, str(p))
    d1("DELETE FROM sweep_state WHERE day = '2000-01-01'")

def c8_nightly_unchanged():
    print("C8: nightly path unchanged: a 3:55 AM local close on a clean-running sweep still fails it; nightly never treats catch-up hours as its window")
    baseline(); mock_set(); tick()
    check("C8 nightly clean sweep complete, nothing queued", st()["status"] == "complete" and st()["catchup_status"] is None)
    sw = open(os.path.join(H.ROOT, "src/fetchers/sweep.ts")).read()
    check("C8 permanent sweep limits unchanged", all(x in sw for x in ("SWEEP_RETRY_REQUEST_LIMIT = 40", "SWEEP_MAX_RETRIES_PER_PAGE = 3", "SWEEP_STREAK_PAUSE_MS = 15 * 60 * 1000", "SWEEP_PAGE_REST_MS = 30 * 60 * 1000", "SWEEP_LAST_TICK_LOCAL_MIN")) and "sweep: { first: 30, last: 3 * 60 + 55" in open(os.path.join(H.ROOT, "src/schedule.ts")).read())   # hard stop 03:55 America/Denver since 2026-11-13 (was 10:55 UTC)

if __name__ == "__main__":
    try:
        H.setup()
        only = sys.argv[1:]
        for f in (c1_queue_on_window_end, c2_catchup_completes_unfinished_only, c3_unattempted_pages_after_pause, c4_hard_failures_not_queued,
                  c5_no_headroom_skipped, c6_catchup_hard_stop, c7_idle_and_previous_day, c8_nightly_unchanged):
            if not only or f.__name__.split("_")[0] in only or f.__name__ in only: f()
    finally:
        H.cleanup()
    print(f"\n{H.passes} passed, {len(H.fails)} failed" + (": " + "; ".join(H.fails) if H.fails else ""))
    sys.exit(1 if H.fails else 0)
