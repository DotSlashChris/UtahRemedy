#!/usr/bin/env python3
"""Per-store suite: the one-time per-store pass that may follow a completed same-day sweep catch-up (src/fetchers/catchup.ts,
owner-approved 2026-11-13). ZERO real DABS requests: reuses scripts/test-perstore-retry.py's harness (mock on 9911, wrangler dev
on 8788, /tmp/ur-retry-test). Run as its OWN job, never alongside the sweep suite.

Run:  python3 scripts/test-perstore-catchup.py [p1 p2 ...]"""
import importlib.util, json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("psr", os.path.join(HERE, "test-perstore-retry.py")); H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
check, d1, row, sched, reset_day, start_mock, mock_set, mock_stats, SKU = H.check, H.d1, H.row, H.sched, H.reset_day, H.start_mock, H.mock_set, H.mock_stats, H.SKU
CU = "*/5 19-22 * * *"   # local-time pinned 2026-11-13 (was */5 20-22); sched() uses an MST date, so 20:00-22:55 UTC = 1:00-3:55 PM
def used(): return row("SELECT dabs_requests n FROM fetch_budget")["n"]
def ps(): return row("SELECT status, total, ok, failed, catchup, requests, error, retry_json FROM perstore_state")
def cu(): return row("SELECT status, catchup_status, catchup_perstore, catchup_perstore_note FROM sweep_state ORDER BY day DESC LIMIT 1")
def detail_total(): return sum(mock_stats()["detail"].values())
def health_cu(): return (json.load(urllib.request.urlopen(H.BASE + "/health")).get("fetcher") or {}).get("sweep_catchup") or {}

def arrange(requests_used=1, perstore_skipped=True, catchup="complete"):
    """Day where the nightly sweep failed, per-store was skipped at 11:00 UTC, and the catch-up sweep then completed."""
    reset_day(requests_used); start_mock(); mock_set()
    if perstore_skipped:
        d1("INSERT INTO perstore_state (day, status, error, started_at, updated_at) SELECT day, 'skipped', 'nightly sweep not complete (failed)', 'x', 'x' FROM sweep_state ORDER BY day DESC LIMIT 1")
    d1(f"UPDATE sweep_state SET catchup_status = {repr(catchup) if catchup else 'NULL'}, catchup_perstore = NULL, catchup_perstore_note = NULL, catchup_started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 minute'), catchup_base_pages = pages_done, catchup_base_retry = retry_requests, catchup_base_transients = transient_errors, catchup_base_requests = 0, catchup_end_requests = 0")

def p1_follow_on_pass():
    print("P1: catch-up sweep complete + per-store skipped -> one normal per-store pass in the catch-up window")
    arrange(); u0 = used()
    sched(CU, 20, 0); s, c = ps(), cu()
    check("P1 skipped row replaced by a running catch-up pass (catchup=1)", s and s["status"] in ("running", "complete") and s["catchup"] == 1 and c["catchup_perstore"] in ("running", "done"), f"{s} {c}")
    check("P1 one tick = at most 6 SKUs / 12 requests (normal per-tick limit)", used() - u0 <= 12 and used() > u0, f"{used()} {u0}")
    for mm in (5, 10, 15):
        if ps()["status"] != "running": break
        sched(CU, 20, mm)
    s, c = ps(), cu()
    check("P1 pass complete: 8 SKUs ok, 2 requests each", s["status"] == "complete" and s["ok"] == 8 and s["requests"] == 16 and used() - u0 == 16, f"{s} {used()}")
    check("P1 catchup_perstore done", c["catchup_perstore"] == "done" and "ended complete" in (c["catchup_perstore_note"] or ""), str(c))
    t = health_cu().get("today") or {}
    check("P1 /health today reports per-store catch-up fields", t.get("perstore_status") == "complete" and t.get("perstore_ok") == 8 and t.get("perstore_requests") == 16, str(t))
    n = detail_total(); sched(CU, 21, 0); sched(CU, 22, 55)
    check("P1 later catch-up ticks: no second pass, no requests", detail_total() == n and ps()["status"] == "complete", f"{detail_total()} {n}")

def p2_not_needed_when_perstore_ran():
    print("P2: per-store already ran in the normal window -> not_needed, 0 requests")
    arrange(perstore_skipped=False)
    d1("INSERT INTO perstore_state (day, status, started_at, updated_at) SELECT day, 'complete', 'x', 'x' FROM sweep_state ORDER BY day DESC LIMIT 1")
    u0 = used(); sched(CU, 20, 0)
    check("P2 not_needed, no requests, row untouched", cu()["catchup_perstore"] == "not_needed" and used() == u0 and ps()["catchup"] == 0 and ps()["status"] == "complete", str(cu()))

def p3_no_budget():
    print("P3: requests + 2 would pass min(500, cap) -> per-store catch-up skipped, 0 requests, skipped row kept")
    arrange(requests_used=499); sched(CU, 20, 0)
    check("P3 skipped (no budget), skipped row kept", cu()["catchup_perstore"] == "skipped" and ps()["status"] == "skipped" and used() == 499, f"{cu()} {ps()}")
    arrange(requests_used=490); sched(CU, 20, 0); sched(CU, 20, 5)
    check("P3 mid-pass ceiling: never past 500", used() <= 500 and ps()["ok"] <= 5, f"{used()} {ps()}")

def p4_hard_stop():
    print("P4: per-store catch-up still has retries at the 22:55 UTC hard stop -> window_ended")
    arrange(); mock_set({SKU(7): "fail:522:*"})
    sched(CU, 20, 0); sched(CU, 22, 55); s = ps()
    check("P4 closed window_ended at 22:55 UTC (not complete), failing SKU not written", s["status"] == "window_ended" and "window ended" in (s["error"] or "") and H.verified(7) == 0, str(s))
    check("P4 catchup_perstore done (ended window_ended)", cu()["catchup_perstore"] == "done" and "window_ended" in (cu()["catchup_perstore_note"] or ""), str(cu()))

def p5_no_pass_unless_sweep_complete():
    print("P5: catch-up sweep failed/skipped/none -> no per-store pass")
    for c in ("failed", "skipped", None):
        arrange(catchup=c); u0 = used(); sched(CU, 20, 0)
        check(f"P5 catchup={c}: per-store stays skipped, 0 requests", ps()["status"] == "skipped" and used() == u0, f"{ps()} {cu()}")

def p6_normal_window_unchanged():
    print("P6: normal per-store window: an 11:00 UTC tick on a sweep-failed day still skips (behavior unchanged)")
    reset_day(); start_mock(); mock_set()
    d1("UPDATE sweep_state SET status = 'failed'"); u0 = used(); sched("*/5 10-17 * * *", 11, 0)
    check("P6 skipped at 11:00 UTC, 0 requests", ps()["status"] == "skipped" and used() == u0, str(ps()))
    d1("UPDATE sweep_state SET status = 'complete'")

if __name__ == "__main__":
    try:
        H.setup()
        for f in (p1_follow_on_pass, p2_not_needed_when_perstore_ran, p3_no_budget, p4_hard_stop, p5_no_pass_unless_sweep_complete, p6_normal_window_unchanged):
            if len(sys.argv) > 1 and f.__name__.split("_")[0] not in sys.argv[1:]: continue
            f()
    finally:
        H.cleanup()
    print(f"\n{H.passes} passed, {len(H.fails)} failed" + (": " + "; ".join(H.fails) if H.fails else ""))
    sys.exit(1 if H.fails else 0)
