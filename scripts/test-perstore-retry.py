#!/usr/bin/env python3
"""Simulated tests for the per-store transient-5xx retry logic (src/fetchers/perstore.ts). ZERO real DABS requests:
everything runs against scripts/mock-dabs.py (port 9911) + `wrangler dev --local` (port 8788) with a throwaway local D1/KV
persist dir (/tmp/ur-retry-test). Needs .dev.vars (ADMIN_TOKEN, DABS_BASE_URL=http://127.0.0.1:9911/dyn, FETCHER_ENABLED=true,
DABS_TEST_MIN_GAP_MS=300). The admin token is read from .dev.vars into memory only and never printed.

Run (Node 22 on PATH):  python3 scripts/test-perstore-retry.py        # exits non-zero on any failure
Scenarios: single 522 then success on retry; same SKU failing 4x (1 try + 3 retries) -> failed, no writes; global retry limit;
403 / 429 / other-5xx keep the old hard behavior (429 / 501 = 1 h backoff); 3 distinct SKUs in a row -> 15 min pause with the
streak reset; ceiling respected (first tries and retries); stale 'running' row closed; window end closes the row (backoff active /
retries pending); S10: after the (mock-shortened) streak pause the next tick resumes and a single new 5xx does not re-pause,
while a 429 still sets the full 1 h backoff.
2026-10-30 (owner-approved, same as the sweep): S11 our request timeout -> requeued and retried (fail closed meanwhile); S12 mixed
5xx/timeouts (and 3 timeouts alone) -> 15 min pause, never the 3-consecutive-failures stop; S13 timeout retries count toward the 3/SKU
and 50/day limits; S14 + S9 ticks that only wait (retries not due) or sit out a pause charge no run, ticks that send still charge.
2026-10-31 (owner-approved): S15 retry order "fresh first, at most 1 retry between fresh SKUs": after a pause with 3 persistently
failing SKUs due and fresh SKUs left, fresh SKUs are checked with <= 1 retry between them (no back-to-back re-pause with zero fresh
progress); retries still run once the queue is drained; limits and fail-closed hold.
2026-11-01 (owner-approved): S9 uses the widened window cron */5 11-15 (last tick 15:55 UTC); 12:55, 13:55 and 14:30 ticks no
longer close the row, only 15:55 does; the retired */5 11-13 (and */5 10-12) crons are rejected. S16 checks the schedule config.
2026-11-02 (owner-approved missing-store rule 'prev_day_same_stores'): S17 accepted when the same stores (or a superset) were absent
the previous Utah day: listed stores written, absent stores qty 0 inferred with a reason, freshness advanced; S18 held when absent for
the first time (no record, or only an older-day record); S19 held when the previous-day set lacks one of today's absent stores; S20
held on qty mismatch above/below even with a previous-day record; S21 held on duplicates; S22 zero-store list with statewide 0 and the
same store absent the previous day -> accepted. Every one: no retry spent, request counts unchanged (2/SKU), /health counters.
2026-11-03 (owner-approved option C): S23 catalog cron paused (KV catalog:v1:auto) at its new slot 30 18 2-8; S9 window */5 11-17
(last tick 17:55 UTC; 15:55 no longer closes the row; retired 11-15 rejected); S16 schedule config; re-pause rule: S10 pause -> first
request after it is a successful probe -> normal running (a later single 5xx does not re-pause); S24 pause -> first request fails
(503) -> immediate re-pause, counted like any transient failure, then a successful probe resumes; S25 the probe is a retry (queue
drained): its failure re-pauses, charges the retry budget and the SKU's retry counter; S26 a 429 as the first request after a pause
still gives the 1 h backoff and ends probe mode.
2026-11-05 (owner-approved auto-prune): S28 unlocked popular SKUs with stock in every public (non-club) DABS store are
removed from perstore_popular at queue build; locked never; N-1 of N does not prune; club-only stock does not satisfy;
zero public stores is a no-op; /health shows auto_prune_rule=all_public_stores and public_stores; caps unchanged.
Timeout scenarios use the mock-only DABS_TEST_REQUEST_TIMEOUT_MS=1500 and the mock's detail_mode sleep/pdsleep stalls."""
import json, os, shutil, signal, subprocess, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERSIST = "/tmp/ur-retry-test"
BASE = "http://127.0.0.1:8788"
MOCK = "http://127.0.0.1:9911"
RETRY_DELAY_MS = 2500
NPX = ["npx", "wrangler"]
procs, fails, passes = [], [], 0

def env_val(k):
    for line in open(os.path.join(ROOT, ".dev.vars")):
        if line.startswith(k + "="): return line.strip().split("=", 1)[1]
    raise SystemExit(f"{k} missing in .dev.vars")
TOKEN = env_val("ADMIN_TOKEN")
assert env_val("DABS_BASE_URL").startswith("http://127.0.0.1:9911"), "refusing to run: .dev.vars does not point at the local mock"

def sh(args, **kw):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, **kw)

def d1(sql):
    r = sh(NPX + ["d1", "execute", "utah-remedy-db", "--local", "--persist-to", PERSIST, "--json", "--command", sql])
    try: out = json.loads(r.stdout)
    except ValueError: raise SystemExit(f"d1 failed: {r.stdout[-400:]} {r.stderr[-400:]}")
    if isinstance(out, dict): raise SystemExit(f"d1 error: {str(out)[:400]}")
    return out[0]["results"] if out else []

def row(sql): 
    r = d1(sql); return r[0] if r else None

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  PASS {name}")
    else: fails.append(name); print(f"  FAIL {name} {detail}")

def start_mock():
    stop_mock()
    p = subprocess.Popen([sys.executable, "scripts/mock-dabs.py", "9911"], cwd=ROOT); procs.append(("mock", p)); time.sleep(0.6)
def stop_mock():
    for n, p in list(procs):
        if n == "mock": p.terminate(); p.wait(); procs.remove((n, p))
def start_wrangler(extra=(), retry_delay_ms=RETRY_DELAY_MS):
    stop_wrangler()
    p = subprocess.Popen(NPX + ["dev", "--port", "8788", "--test-scheduled", "--persist-to", PERSIST, "--var", f"DABS_TEST_RETRY_DELAY_MS:{retry_delay_ms}", *extra],
                         cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    procs.append(("wrangler", p))
    for _ in range(90):
        try:
            urllib.request.urlopen(BASE + "/health", timeout=3); return
        except Exception: time.sleep(1)
    raise SystemExit("wrangler dev did not start")
def stop_wrangler():
    for n, p in list(procs):
        if n == "wrangler":
            try: os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            p.wait(); procs.remove((n, p))
    time.sleep(1)
def cleanup():
    stop_mock(); stop_wrangler()

def post(body):
    req = urllib.request.Request(BASE + "/internal/fetch/dabs", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)
    except urllib.error.HTTPError as e: return {"error": e.code, "body": e.read().decode()[:200]}
def tick(**kw): return post({"perstoreTick": True, **kw})
def mock_stats(): return json.load(urllib.request.urlopen(MOCK + "/__stats"))

def mock_set(modes=None, n=8):
    prods = [{"sku": f"{900000+i}", "name": f"MOCK PRODUCT {i:04d} 750ml", "wh": 10 + i % 7, "st": 5 + i % 11, "oo": 0, "status": "A  Allocated"} for i in range(n)]
    json.dump({"scenario": "good", "products": prods, "detail_mode": modes or {}}, open("/tmp/mock-dabs-state.json", "w"))
ORDER = []   # real queue order, discovered in setup(); SKU(i) = i-th SKU the per-store pass will process
SKU = lambda i: ORDER[i] if ORDER else f"{900000+i}"

def reset_day(requests_used=1):
    """Fresh per-store day: new queue, retry state cleared, KV backoff cleared, request counter = sweep's (or given)."""
    d1("DELETE FROM perstore_state")
    d1("DELETE FROM inventory_latest WHERE store_key <> ''")   # forget per-store rows so 'verified' reflects only this scenario
    d1(f"UPDATE fetch_budget SET dabs_requests = {requests_used}, runs = 0")
    sh(NPX + ["kv", "key", "delete", "dabs:v1:backoff_until", "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST])
    d1("DELETE FROM fetch_lock")
    d1("DELETE FROM perstore_missing")
def state(): return row("SELECT status, total, next_idx, ok, failed, skipped, retried, recovered, retry_requests, transient_errors, consecutive_failures, requests, error, retry_json, completed_at FROM perstore_state")
def verified(i): return row(f"SELECT COUNT(*) n FROM inventory_latest WHERE sku='{SKU(i)}' AND store_key<>'' AND verified_at IS NOT NULL")["n"]
def backoff_left_ms():
    """Remaining DABS backoff in ms (0 if none)."""
    r = sh(NPX + ["kv", "key", "get", "dabs:v1:backoff_until", "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST, "--text"])
    v = r.stdout.strip()
    return max(0, int(v) - int(time.time() * 1000)) if v.isdigit() else 0
def backoff_set(): return backoff_left_ms() > 0
def runs(): return row("SELECT runs n FROM fetch_budget")["n"]
def statewide(i): return row(f"SELECT store_total_qty q FROM inventory_latest WHERE sku='{SKU(i)}' AND store_key=''")["q"]
TIMEOUT = ("--var", "DABS_TEST_REQUEST_TIMEOUT_MS:1500")   # mock-only; the mock stalls 2500 ms
MIN = 60_000
def to_end(max_ticks=8):
    for _ in range(max_ticks):
        r = tick()
        if r.get("status") not in ("running", None) or r.get("action") in ("stopped", "backoff"): return r
        time.sleep(0.5)
    return r

def setup():
    shutil.rmtree(PERSIST, ignore_errors=True)
    r = sh(NPX + ["d1", "migrations", "apply", "utah-remedy-db", "--local", "--persist-to", PERSIST]); assert r.returncode == 0, r.stdout[-500:] + r.stderr[-500:]
    start_mock(); mock_set(); start_wrangler()
    for _ in range(6):
        post({"sweepTick": True})
        sw = row("SELECT status FROM sweep_state ORDER BY day DESC LIMIT 1")
        if sw and sw["status"] == "complete": break
    sw = row("SELECT status FROM sweep_state ORDER BY day DESC LIMIT 1")
    assert sw and sw["status"] == "complete", f"sweep did not complete: {sw}"
    reset_day(); tick()
    ORDER.extend(row("SELECT queue q FROM perstore_state")["q"].split(","))
    assert len(ORDER) == 8, ORDER
    print("queue order:", ",".join(ORDER))
    print("setup ok; sweep complete; sweep requests:", row("SELECT dabs_requests n FROM fetch_budget")["n"])

def s1_single_522_then_success():
    print("S1: single 522 then success on retry")
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:1"})
    r1 = tick(); s = state()
    check("S1 tick1 does not pause (no stopped/backoff action)", r1.get("action") == "progress", str(r1))
    check("S1 no global backoff set", not backoff_set())
    check("S1 SKU 1 not counted failed, queued for retry", s["failed"] == 0 and '"n":1' in (s["retry_json"] or "") and s["transient_errors"] == 1, str(s))
    check("S1 fail closed: SKU 1 has no verified stores yet", verified(1) == 0)
    check("S1 other SKUs verified", verified(0) > 0 and verified(2) > 0)
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    r2 = to_end(); s = state()
    check("S1 row finished 'complete'", s["status"] == "complete" and s["completed_at"], str(s))
    check("S1 counts ok=8 failed=0 retried=1 recovered=1 skipped=0", (s["ok"], s["failed"], s["retried"], s["recovered"], s["skipped"]) == (8, 0, 1, 1, 0), str(s))
    check("S1 retry cost 2 requests (full retry), counted", s["retry_requests"] == 2, str(s))
    check("S1 SKU 1 verified after retry", verified(1) > 0)
    st = mock_stats(); check("S1 mock saw 2 GetDetailUrl for SKU 1 (try + retry)", st["detail"].get(SKU(1)) == 2, str(st["detail"]))

def s2_three_retries_then_failed():
    print("S2: same SKU keeps failing -> 1 try + 3 retries, then failed, no writes")
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*"})
    tick(); time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    for _ in range(6):
        tick(); time.sleep(RETRY_DELAY_MS / 1000 + 0.3)
        if state()["status"] != "running": break
    s = state()
    check("S2 row complete (failed SKU does not block the day)", s["status"] == "complete", str(s))
    check("S2 ok=7 failed=1 retried=3", (s["ok"], s["failed"], s["retried"]) == (7, 1, 3), str(s))
    check("S2 transient_errors=4 (1 try + 3 retries), retry_requests=3", (s["transient_errors"], s["retry_requests"]) == (4, 3), str(s))
    check("S2 no data written for the failed SKU", verified(1) == 0)
    check("S2 no backoff", not backoff_set())
    check("S2 mock saw exactly 4 requests for SKU 1", mock_stats()["detail"].get(SKU(1)) == 4, str(mock_stats()["detail"]))
    check("S2 no sold-out marks: SKU 1 statewide qty untouched", row(f"SELECT store_total_qty q FROM inventory_latest WHERE sku='{SKU(1)}' AND store_key=''")["q"] > 0)

def s3_global_retry_limit():
    print("S3: global daily retry limit reached")
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*"})
    tick()
    d1("UPDATE perstore_state SET retry_requests = 49")          # 1 request left < 2 needed for a full retry
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    to_end(); s = state()
    check("S3 pending retry failed for the day, no retry request sent", mock_stats()["detail"].get(SKU(1)) == 1, str(mock_stats()["detail"]))
    check("S3 row complete, failed=1 retried=0 ok=7", (s["status"], s["failed"], s["retried"], s["ok"]) == ("complete", 1, 0, 7), str(s))
    check("S3 retry_requests never above limit", s["retry_requests"] <= 50, str(s))
    check("S3 retry_limit event logged", row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='retry_limit'")["n"] >= 1)
    check("S3 no data written for the failed SKU", verified(1) == 0)

def s4_hard_errors():
    print("S4: 429 / 403 / unlisted 5xx keep the old hard behavior")
    for code, hard_backoff in (("429", True), ("403", False), ("501", True)):
        reset_day(); start_mock(); mock_set({SKU(1): f"fail:{code}:*"})
        r = tick(); s = state()
        check(f"S4 {code}: tick stops, SKU failed immediately (no retry queued)", r.get("action") == "stopped" and s["failed"] == 1 and s["retried"] == 0 and '"n"' not in (s["retry_json"] or ""), f"{r} {s}")
        left = backoff_left_ms()
        check(f"S4 {code}: backoff {'set, full 1 h' if hard_backoff else 'not set (unchanged behavior)'}", (55 * MIN < left <= 60 * MIN) if hard_backoff else left == 0, f"left={left}")
        check(f"S4 {code}: SKU 1 not verified", verified(1) == 0)
        if hard_backoff:
            r2 = tick(); check(f"S4 {code}: next tick blocked by backoff", r2.get("action") == "backoff", str(r2))
        check(f"S4 {code}: SKU requested once only", mock_stats()["detail"].get(SKU(1)) == 1)

def s5_distinct_streak():
    print("S5: 3 distinct SKUs in a row hit 5xx (522/503/500 mixed) -> 15 min pause, streak reset")
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "fail:503:*", SKU(3): "pdfail:500:*"})
    r = tick(); s = state()
    check("S5 tick stopped after 3rd distinct SKU, '15 min pause'", r.get("action") == "stopped" and "distinct SKUs" in r.get("detail", "") and "15 min pause" in r.get("detail", ""), str(r))
    left = backoff_left_ms()
    check("S5 pause is 15 min (not 1 h)", 13 * MIN < left <= 15 * MIN, f"left={left}")
    rj = json.loads(s["retry_json"] or "{}")
    check("S5 streak reset when the pause starts", rj.get("streak") == [], str(rj))
    check("S5 3 SKUs pending retry, none failed, SKU 4+ untouched", len(rj.get("pending", [])) == 3 and s["failed"] == 0 and s["next_idx"] == 4, str(s))
    check("S5 no data written for the 3 SKUs", verified(1) == verified(2) == verified(3) == 0 and verified(0) > 0)
    check("S5 'paused' event logged", row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='paused'")["n"] >= 1)
    r2 = tick(); check("S5 next tick blocked by the pause", r2.get("action") == "backoff", str(r2))
    st = mock_stats()["detail"]
    check("S5 no requests during the pause (each failed SKU hit once, SKU 4 never)", st.get(SKU(1)) == st.get(SKU(2)) == st.get(SKU(3)) == 1 and not st.get(SKU(4)), str(st))
    h = json.load(urllib.request.urlopen(BASE + "/health"))
    lim = h.get("fetcher", {}).get("perstore", {}).get("limits", {})
    check("S5 /health perstore.limits.streak_pause_min = 15, other limits unchanged",
          (lim.get("streak_pause_min"), lim.get("streak_pause"), lim.get("retry_max_per_sku"), lim.get("retry_request_limit_per_day"), lim.get("retry_delay_min"), lim.get("day_request_ceiling")) == (15, 3, 3, 50, 15, 500), str(lim))

def s6_ceiling():
    print("S6: ceiling respected (first tries and retries)")
    reset_day(494); start_mock(); mock_set()
    r = tick(); s = state(); used = row("SELECT dabs_requests n FROM fetch_budget")["n"]
    check("S6a capped at <= 500 requests", used <= 500 and s["status"] == "capped", f"{used} {s}")
    check("S6a ok+failed+skipped = total", s["ok"] + s["failed"] + s["skipped"] == s["total"], str(s))
    reset_day(498); start_mock(); mock_set({SKU(0): "fail:522:*"})
    tick(); time.sleep(RETRY_DELAY_MS / 1000 + 0.5); tick(); s = state(); used = row("SELECT dabs_requests n FROM fetch_budget")["n"]
    check("S6b retry path cannot push past 500", used <= 500, f"{used} {s}")
    check("S6b row capped with skipped counted (ok+failed+skipped=total)", s["status"] == "capped" and s["ok"] + s["failed"] + s["skipped"] == s["total"], str(s))

def s7_stale_row():
    print("S7: stale 'running' row from an earlier day is closed")
    reset_day()
    d1("INSERT INTO perstore_state (day, status, queue, total, next_idx, ok, started_at, updated_at) VALUES ('2000-01-01','running','a,b,c',3,1,1,'2000-01-01T10:00:00Z','2000-01-01T11:00:00Z')")
    tick(); s = row("SELECT status, skipped, ok, completed_at FROM perstore_state WHERE day='2000-01-01'")
    check("S7 stale row expired with skipped=2", s["status"] == "expired" and s["skipped"] == 2 and s["completed_at"], str(s))

def s8_window_end():
    print("S8: last tick of the window closes the row")
    start_wrangler(("--var", "DABS_TEST_LAST_TICK:1"))
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "fail:522:*", SKU(3): "fail:522:*"})
    r = tick(); s = state()      # streak pause during the last tick -> row closed as window_ended right away
    check("S8a pause on last tick closes row 'window_ended' with counts", s["status"] == "window_ended" and s["skipped"] > 0 and s["ok"] + s["failed"] + s["skipped"] == s["total"], f"{r} {s}")
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "fail:522:*", SKU(3): "fail:522:*"})
    r = tick()                    # pauses, row closed
    d1("UPDATE perstore_state SET status='running', completed_at=NULL, skipped=0")   # simulate the old bug state: running row + backoff active
    r2 = tick(); s = state()
    check("S8b backoff active at window end -> row closed (was 'running' forever)", r2.get("action") == "backoff" and s["status"] == "window_ended", f"{r2} {s}")
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:1"})
    r = tick(); s = state()       # SKU 1 pending (not yet due) when the last tick ends
    check("S8c retry pending at last tick -> window_ended, skipped counts pending", s["status"] == "window_ended" and s["skipped"] >= 1 and s["ok"] + s["failed"] + s["skipped"] == s["total"], f"{r} {s}")
    check("S8c nothing written for the pending SKU", verified(1) == 0)

def sched(cron, hh, mm):
    """Fire the real scheduled() handler with scheduledTime = 2027-01-05 (MST) hh:mm UTC (cron allowlist + window-end logic)."""
    import calendar, urllib.parse
    ms = calendar.timegm((2027, 1, 5, hh, mm, 0)) * 1000   # fixed MST date (day 5): the local-time gate (2026-11-13) reads scheduledTime in America/Denver
    r = json.load(urllib.request.urlopen(BASE + "/cdn-cgi/handler/scheduled?format=json&cron=" + urllib.parse.quote(cron) + f"&time={ms}", timeout=120))
    assert r.get("outcome") == "ok", r
def sched_at(cron, iso):
    """Fire scheduled() at an exact UTC instant ('2027-07-15T06:30'), for the America/Denver gate / DST tests."""
    import calendar, urllib.parse
    ms = calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M")) * 1000
    r = json.load(urllib.request.urlopen(BASE + "/cdn-cgi/handler/scheduled?format=json&cron=" + urllib.parse.quote(cron) + f"&time={ms}", timeout=120))
    assert r.get("outcome") == "ok", r

def s9_new_window():
    print("S9: real scheduled ticks in the widened window 11:00-17:55 UTC (window_ended only at 17:55; retired 10-12, 11-13, 11-15 crons rejected)")
    start_wrangler(retry_delay_ms=600000)   # SKU 1's retry stays not-due for the whole scenario
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*"})
    sched("*/5 10-12 * * *", 10, 0)
    check("S9 retired cron */5 10-12 rejected (no per-store row)", row("SELECT COUNT(*) n FROM perstore_state")["n"] == 0)
    sched("*/5 11-13 * * *", 11, 0); sched("*/5 11-13 * * *", 13, 55)
    check("S9 retired cron */5 11-13 rejected (no per-store row, no request)", row("SELECT COUNT(*) n FROM perstore_state")["n"] == 0 and not mock_stats()["detail"], str(mock_stats()))
    sched("*/5 11-15 * * *", 11, 0); sched("*/5 11-15 * * *", 15, 55); sched("*/5 11-17 * * *", 11, 0)
    check("S9 retired crons */5 11-15 (until 2026-11-03) and */5 11-17 (until 2026-11-13) rejected (no per-store row, no request)", row("SELECT COUNT(*) n FROM perstore_state")["n"] == 0 and not mock_stats()["detail"], str(mock_stats()))
    W = "*/5 10-17 * * *"
    sched(W, 11, 0); s = state()
    check("S9 11:00 tick runs per-store (sweep complete), row running", s and s["status"] == "running" and s["requests"] > 0, str(s))
    check("S9 11:00 tick (sent requests) charged 1 run", runs() == 1, str(runs()))
    sched(W, 12, 55); s = state()
    check("S9 12:55 (window end before 2026-10-27) does not close the row", s["status"] == "running", str(s))
    check("S9 12:55 tick finished the queue (sent requests) and charged 1 run", s["next_idx"] == 8 and runs() == 2, f"{s} runs={runs()}")
    sched(W, 13, 55); s = state()
    check("S9 13:55 (old last tick, until 2026-11-01) no longer closes the row", s["status"] == "running", str(s))
    check("S9 13:55 waiting tick (only a not-due retry left) charged no run", runs() == 2, str(runs()))
    sched(W, 15, 55); s = state()
    check("S9 15:55 (old last tick, until 2026-11-03) no longer closes the row", s["status"] == "running", str(s))
    sched(W, 16, 30); s = state()
    check("S9 16:30 (old catalog slot, now inside the window) does not close the row", s["status"] == "running", str(s))
    sched(W, 17, 50); s = state()
    check("S9 17:50 tick does not close the row", s["status"] == "running", str(s))
    check("S9 15:55-17:50 waiting ticks charged no run", runs() == 2, str(runs()))
    sched(W, 17, 55); s = state()
    check("S9 17:55 waiting tick charged no run either", runs() == 2, str(runs()))
    check("S9 17:55 tick = window end -> window_ended (SKU 1 retry pending), counts add up", s["status"] == "window_ended" and s["skipped"] >= 1 and s["ok"] + s["failed"] + s["skipped"] == s["total"], str(s))
    check("S9 nothing written for the pending SKU", verified(1) == 0)
    st0 = mock_stats(); sched(W, 17, 55)
    check("S9 tick after window_ended is a no-op (no request)", mock_stats() == st0 and state()["status"] == "window_ended")
    start_wrangler()

def paused_n(): return row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='paused'")["n"]
PAUSE4 = ("--var", "DABS_TEST_PERSTORE_PAUSE_MS:4000")   # mock-only pause override (15 min in production)

def s10_pause_resume():
    print("S10: pause, then the first request SUCCEEDS -> normal running (probe ends; a later single 5xx does not re-pause)")
    start_wrangler(PAUSE4, retry_delay_ms=600000)   # retries stay not-due
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "fail:522:*", SKU(3): "fail:504:*", SKU(5): "fail:503:*"})
    p0 = paused_n()
    r = tick(); rj = json.loads(state()["retry_json"] or "{}")
    check("S10 tick 1 pauses after 3 distinct SKUs, probe armed", r.get("action") == "stopped" and "distinct SKUs" in r.get("detail", "") and rj.get("probe") is True, f"{r} {rj}")
    r = tick(); check("S10 tick during the pause sends nothing", r.get("action") == "backoff" and SKU(4) not in mock_stats()["detail"], str(r))
    time.sleep(4.5)
    r = tick(); s = state(); rj = json.loads(s["retry_json"] or "{}")
    check("S10 first request after the pause (fresh SKU 4) succeeds -> probe off", verified(4) > 0 and rj.get("probe") is False, str(rj))
    check("S10 a later single 503 (SKU 5) does not re-pause, the tick carries on", r.get("action") != "stopped" and not backoff_set(), str(r))
    check("S10 SKUs 4, 6, 7 checked, 4 SKUs pending retry", s["next_idx"] == 8 and len(rj.get("pending", [])) == 4 and verified(6) > 0 and verified(7) > 0, str(s))
    check("S10 nothing written for SKUs 1-3 and 5", verified(1) == verified(2) == verified(3) == verified(5) == 0)
    check("S10 exactly one 'paused' event", paused_n() == p0 + 1)
    start_wrangler()

def resync_order():
    """The queue is ordered by statewide qty, which S17-S22 change; re-read the real queue so SKU(i) = i-th SKU processed."""
    reset_day(); start_mock(); mock_set(); tick()
    ORDER[:] = row("SELECT queue q FROM perstore_state")["q"].split(",")

def s24_repause():
    print("S24: pause, then the first request FAILS (503) -> immediate 15 min-style re-pause; then a successful probe resumes")
    start_wrangler(PAUSE4, retry_delay_ms=600000)
    resync_order()
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "fail:522:*", SKU(3): "fail:504:*", SKU(4): "fail:503:*"})
    p0 = paused_n(); r0 = runs()
    tick(); s1 = state()
    time.sleep(4.5)
    r = tick(); rmid = tick()   # the second tick is sent at once: D1 checks below take longer than the 4 s mock pause
    s = state(); rj = json.loads(s["retry_json"] or "{}"); st = mock_stats()["detail"]
    check("S24 first request after the pause is fresh SKU 4 and its 503 re-pauses at once", r.get("action") == "stopped" and "re-pause" in r.get("detail", "") and backoff_set(), str(r))
    check("S24 re-pause stopped the tick: SKU 5 never requested, SKU 4 once", st.get(SKU(4)) == 1 and not st.get(SKU(5)), str(st))
    p4 = [p for p in rj.get("pending", []) if p["sku"] == SKU(4)]
    check("S24 failed probe counted like any transient failure: SKU 4 requeued n=1, transient_errors+1, failed=0, consec 0",
          len(p4) == 1 and p4[0]["n"] == 1 and s["transient_errors"] == s1["transient_errors"] + 1 and (s["failed"], s["consecutive_failures"]) == (0, 0) and s["retry_requests"] == 0, str(s))
    check("S24 probe stays armed, streak empty, row running, 2 'paused' events", rj.get("probe") is True and rj.get("streak") == [] and s["status"] == "running" and paused_n() == p0 + 2, f"{rj} {s}")
    lg = row("SELECT error FROM fetch_log WHERE kind='perstore' AND status='paused' ORDER BY id DESC LIMIT 1")
    check("S24 'paused' event names the re-pause", "first request after a pause failed" in (lg["error"] or ""), str(lg))
    check("S24 nothing written for SKU 4", verified(4) == 0)
    check("S24 tick during the re-pause: backoff, no request", rmid.get("action") == "backoff" and st.get(SKU(5)) is None, str(rmid))
    runs_before = runs()
    time.sleep(4.5)
    r = tick(); s = state(); rj = json.loads(s["retry_json"] or "{}")
    check("S24 after the re-pause: fresh SKU 5 succeeds, probe off, queue finished, 4 pending", verified(5) > 0 and rj.get("probe") is False and s["next_idx"] == 8 and len(rj.get("pending", [])) == 4, f"{r} {s}")
    check("S24 runs: 3 ticks that sent requests charged 3, pause ticks none", runs() == r0 + 3 and runs_before == r0 + 2, f"{r0}->{runs_before}->{runs()}")
    start_wrangler()

def s25_repause_retry_probe():
    print("S25: the probe is a due retry (queue drained): its failure re-pauses, charges the retry budget and the SKU's retry count")
    start_wrangler(PAUSE4)   # retries due 2.5 s after failing; pause 4 s
    resync_order()
    reset_day(); start_mock(); mock_set({SKU(5): "fail:522:*", SKU(6): "fail:503:*", SKU(7): "fail:504:*"})
    r = tick(); s = state()
    if s["next_idx"] < 8 or r.get("action") != "stopped":
        r = tick(); s = state()
    rj = json.loads(s["retry_json"] or "{}")
    check("S25 queue drained, paused after SKUs 5-7, probe armed", r.get("action") == "stopped" and s["next_idx"] == 8 and rj.get("probe") is True and len(rj["pending"]) == 3, f"{r} {s}")
    time.sleep(4.5)
    st0 = mock_stats()["detail"]
    r = tick(); s2 = state(); rj = json.loads(s2["retry_json"] or "{}"); st = mock_stats()["detail"]
    sent = sum(st.get(k, 0) - st0.get(k, 0) for k in st)
    check("S25 exactly one retry sent, it failed -> re-pause", r.get("action") == "stopped" and "re-pause" in r.get("detail", "") and sent == 1, f"{r} sent={sent}")
    check("S25 that retry counted: retried 1, retry_requests 1, its pending n=2", s2["retried"] == 1 and s2["retry_requests"] == 1 and sorted(p["n"] for p in rj["pending"]) == [1, 1, 2], f"{s2} {rj}")
    check("S25 probe still armed, nothing written", rj.get("probe") is True and verified(5) == verified(6) == verified(7) == 0)
    start_wrangler()

def s26_429_after_pause():
    print("S26: a 429 as the first request after a pause still gives the 1 h backoff (probe ends)")
    start_wrangler(PAUSE4, retry_delay_ms=600000)
    resync_order()
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "fail:522:*", SKU(3): "fail:504:*", SKU(4): "fail:429:*"})
    tick(); time.sleep(4.5)
    r = tick(); left = backoff_left_ms(); s = state(); rj = json.loads(s["retry_json"] or "{}")
    check("S26 429 after the pause -> stopped, full 1 h backoff (not the 15 min re-pause)", r.get("action") == "stopped" and "re-pause" not in r.get("detail", "") and 55 * MIN < left <= 60 * MIN, f"{r} left={left}")
    check("S26 probe off after the 429, SKU 4 not requeued as transient, not verified", rj.get("probe") is False and all(p["sku"] != SKU(4) for p in rj["pending"]) and verified(4) == 0, str(rj))
    check("S26 429 SKU requested once", mock_stats()["detail"].get(SKU(4)) == 1)
    reset_day(); start_mock(); mock_set({SKU(1): "fail:429:*"})
    r = tick(); left = backoff_left_ms()
    check("S26 429 in normal running (pause override active) still sets the full 1 h backoff", r.get("action") == "stopped" and 55 * MIN < left <= 60 * MIN, f"{r} left={left}")
    lim = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher", {}).get("perstore", {}).get("limits", {})
    check("S26 /health repause_rule active, other limits unchanged",
          lim.get("repause_rule") == "first_transient_after_pause" and lim.get("repause_min") == 15 and (lim.get("streak_pause"), lim.get("streak_pause_min"), lim.get("retry_max_per_sku"),
          lim.get("retry_request_limit_per_day"), lim.get("retry_delay_min"), lim.get("day_request_ceiling"), lim.get("requests_per_sku")) == (3, 15, 3, 50, 15, 500, 2), str(lim))
    start_wrangler()

def s11_timeout_retry():
    print("S11: our request timeout -> requeued (not failed), nothing written, then retried and recovered")
    start_wrangler(TIMEOUT)
    reset_day(); start_mock(); mock_set({SKU(1): "sleep:2500:1"})
    r = tick(); s = state(); rj = json.loads(s["retry_json"] or "{}")
    check("S11 tick carries on after the timeout (no stop, no backoff)", r.get("action") == "progress" and not backoff_set(), str(r))
    check("S11 timeout counted transient, requeued n=1, not failed, no consecutive failure",
          (s["failed"], s["transient_errors"], s["consecutive_failures"]) == (0, 1, 0) and [p["n"] for p in rj.get("pending", [])] == [1], str(s))
    lg = row(f"SELECT status, error FROM fetch_log WHERE kind='perstore_detail' AND query LIKE 'sku={SKU(1)};%' ORDER BY id DESC LIMIT 1")
    check("S11 fetch_log: network_error TimeoutError, retry 1/3 queued", lg and lg["status"] == "network_error" and "TimeoutError" in (lg["error"] or "") and "retry 1/3 queued" in lg["error"], str(lg))
    check("S11 fail closed: nothing written for the timed-out SKU, statewide qty untouched", verified(1) == 0 and statewide(1) > 0)
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    to_end(); s = state()
    check("S11 retry succeeded: complete, ok=8 failed=0 retried=1 recovered=1", (s["status"], s["ok"], s["failed"], s["retried"], s["recovered"]) == ("complete", 8, 0, 1, 1), str(s))
    check("S11 SKU verified after the retry; mock saw 2 GetDetailUrl", verified(1) > 0 and mock_stats()["detail"].get(SKU(1)) == 2, str(mock_stats()["detail"]))
    start_wrangler()

def s12_timeout_streak():
    print("S12: 522 + 2 timeouts (GetDetailUrl / ProductDetail) on 3 distinct SKUs -> 15 min pause; 3 timeouts alone never fail the day")
    start_wrangler(TIMEOUT)
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:*", SKU(2): "sleep:2500:*", SKU(3): "pdsleep:2500:*"})
    r = tick(); s = state(); rj = json.loads(s["retry_json"] or "{}")
    check("S12 stopped with '15 min pause' after the 3rd distinct SKU", r.get("action") == "stopped" and "15 min pause" in r.get("detail", ""), str(r))
    left = backoff_left_ms(); check("S12 pause is 15 min", 13 * MIN < left <= 15 * MIN, f"left={left}")
    check("S12 streak reset, 3 pending, failed=0, consecutive_failures=0, row still running",
          rj.get("streak") == [] and len(rj.get("pending", [])) == 3 and (s["failed"], s["consecutive_failures"], s["status"]) == (0, 0, "running"), str(s))
    check("S12 fail closed: nothing written for SKUs 1-3, statewide qty untouched", verified(1) == verified(2) == verified(3) == 0 and statewide(2) > 0 and statewide(3) > 0)
    runs0, st0 = runs(), mock_stats()
    r = tick()
    check("S12 tick during the pause: backoff, no run charged, no requests", r.get("action") == "backoff" and runs() == runs0 and mock_stats() == st0, f"{r} runs {runs0}->{runs()}")
    reset_day(); start_mock(); mock_set({SKU(1): "sleep:2500:*", SKU(2): "sleep:2500:*", SKU(3): "sleep:2500:*"})
    r = tick(); s = state()
    check("S12b 3 timeouts in a row -> 15 min pause, NOT the 3-consecutive-failures stop", r.get("action") == "stopped" and "15 min pause" in r.get("detail", "")
          and s["status"] == "running" and (s["failed"], s["consecutive_failures"]) == (0, 0), f"{r} {s}")
    start_wrangler()

def s13_timeout_limits():
    print("S13: timeout retries count toward the 3/SKU and 50/day retry limits")
    start_wrangler(TIMEOUT)
    reset_day(); start_mock(); mock_set({SKU(1): "sleep:2500:*"})
    tick(); time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    for _ in range(8):
        tick(); time.sleep(RETRY_DELAY_MS / 1000 + 0.3)
        if state()["status"] != "running": break
    s = state()
    check("S13a timing out every time: 1 try + 3 retries, then failed; day complete", (s["status"], s["ok"], s["failed"], s["retried"], s["transient_errors"]) == ("complete", 7, 1, 3, 4), str(s))
    check("S13a timed-out retry requests counted (3 x 1 request)", s["retry_requests"] == 3, str(s))
    check("S13a mock saw exactly 4 GetDetailUrl for SKU 1; nothing written", mock_stats()["detail"].get(SKU(1)) == 4 and verified(1) == 0 and statewide(1) > 0)
    reset_day(); start_mock(); mock_set({SKU(1): "sleep:2500:*"})
    tick(); d1("UPDATE perstore_state SET retry_requests = 48")
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5); tick(); s = state()
    check("S13b a timed-out retry is charged to the 50/day limit (48 -> 49)", s["retry_requests"] == 49 and s["retried"] == 1, str(s))
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5); to_end(); s = state()
    check("S13b limit reached: no further retry sent, SKU failed for the day, retry_requests <= 50",
          mock_stats()["detail"].get(SKU(1)) == 2 and s["failed"] == 1 and s["retry_requests"] <= 50 and s["status"] == "complete", f"{s} {mock_stats()['detail']}")
    check("S13b retry_limit event logged; nothing written", row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='retry_limit'")["n"] >= 1 and verified(1) == 0)
    start_wrangler()

def s14_runs():
    print("S14: waiting ticks (only not-due retries) charge no run; ticks that send still charge; /health flags")
    start_wrangler(retry_delay_ms=600000)
    reset_day(); start_mock(); mock_set({SKU(1): "fail:522:1"})
    r = tick(); check("S14 tick 1 sends requests and charges 1 run", runs() == 1 and r.get("action") == "progress", f"{r} runs={runs()}")
    r = tick(); s = state()
    check("S14 tick 2 sends the rest of the queue and charges 1 run", runs() == 2 and s["next_idx"] == 8, f"{r} {s} runs={runs()}")
    st0 = mock_stats()
    r2 = tick(); r3 = tick()
    check("S14 ticks 2-3 only wait: action 'waiting', no run charged, no requests", r2.get("action") == r3.get("action") == "waiting" and runs() == 2 and mock_stats() == st0, f"{r2} {r3} runs={runs()}")
    rj = json.loads(state()["retry_json"]); [p.update(due=0) for p in rj["pending"]]
    d1("UPDATE perstore_state SET retry_json = '" + json.dumps(rj) + "'")
    r4 = tick(); s = state()
    check("S14 retry due -> tick sends, charges a run, SKU recovered, day complete", runs() == 3 and s["status"] == "complete" and s["recovered"] == 1 and verified(1) > 0, f"{r4} {s} runs={runs()}")
    lim = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher", {}).get("perstore", {}).get("limits", {})
    check("S14 /health: timeout_retryable true, paused_or_waiting_ticks_charge_run false, limits unchanged",
          lim.get("timeout_retryable") is True and lim.get("paused_or_waiting_ticks_charge_run") is False
          and (lim.get("streak_pause_min"), lim.get("retry_max_per_sku"), lim.get("retry_request_limit_per_day"), lim.get("day_request_ceiling")) == (15, 3, 50, 500), str(lim))
    start_wrangler()

def attempts(since_id=0):
    """Per-store SKU attempts in order: [(sku, is_retry)]."""
    rs = d1(f"SELECT query FROM fetch_log WHERE kind='perstore_detail' AND id > {since_id} ORDER BY id")
    out = []
    for r in rs:
        kv = dict(x.split("=", 1) for x in r["query"].split(";") if "=" in x)
        out.append((kv.get("sku"), "retry" in kv))
    return out

def s15_fresh_first():
    print("S15: after a pause, fresh SKUs go first with <= 1 retry between them; retries resume once the queue is drained")
    start_wrangler(("--var", "DABS_TEST_PERSTORE_PAUSE_MS:4000"))   # retries due 2.5 s after failing; pause 4 s
    reset_day(); start_mock(); mock_set({SKU(0): "fail:522:*", SKU(1): "fail:503:*", SKU(2): "fail:522:*"})
    id0 = row("SELECT COALESCE(MAX(id),0) n FROM fetch_log")["n"]
    paused0 = row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='paused'")["n"]
    r = tick(); s = state()
    check("S15 tick 1: 3 persistent failures -> 15 min-style pause, 5 fresh SKUs left", r.get("action") == "stopped" and s["next_idx"] == 3, f"{r} {s}")
    time.sleep(4.5)                                   # pause over, all 3 retries due
    id1 = row("SELECT COALESCE(MAX(id),0) n FROM fetch_log WHERE kind='perstore_detail'")["n"]
    r = tick(); s = state(); a = attempts(id1)
    check("S15 first attempt after the pause is a fresh SKU", a and a[0][1] is False, str(a))
    check("S15 tick 2 makes fresh progress and does NOT re-pause (fresh successes break the streak)",
          r.get("action") != "stopped" and not backoff_set() and s["next_idx"] >= 6 and verified(3) > 0 and verified(4) > 0, f"{r} {s}")
    while True:                                       # finish the day; pauses after the queue is drained are allowed (retries as before)
        if state()["status"] != "running": break
        time.sleep(4.5); tick()
        if row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore_detail'")["n"] > 200: break
    s = state(); a = attempts(id0)
    last_fresh = max(i for i, (_, rt) in enumerate(a) if not rt)
    pairs = [i for i in range(1, last_fresh) if a[i][1] and a[i - 1][1]]
    check("S15 while fresh SKUs remained, never 2 retries back to back", not pairs, str(a))
    fresh_order = [k for k, rt in a if not rt]
    check("S15 every fresh SKU tried exactly once, in queue order", fresh_order == ORDER, str(fresh_order))
    check("S15 retries still ran after the queue was drained", any(rt for _, rt in a[last_fresh + 1:]), str(a))
    paused_before_drain = row(f"SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='paused' AND id > {id0} AND id < (SELECT id FROM fetch_log WHERE kind='perstore_detail' AND query LIKE 'sku={ORDER[-1]};%' AND id > {id0} ORDER BY id LIMIT 1)")["n"]
    check("S15 only the one pause before the queue was drained (no back-to-back pauses with zero fresh progress)", paused_before_drain == 1, str(paused_before_drain))
    check("S15 day complete: ok=5 failed=3 retried=9 (3/SKU), retry_requests=9 <= 50", (s["status"], s["ok"], s["failed"], s["retried"], s["retry_requests"]) == ("complete", 5, 3, 9, 9), str(s))
    st = mock_stats()["detail"]
    check("S15 each failing SKU requested exactly 4 times (1 try + 3 retries)", st.get(SKU(0)) == st.get(SKU(1)) == st.get(SKU(2)) == 4, str(st))
    check("S15 fail closed: nothing written for the 3 failing SKUs, statewide qty untouched", verified(0) == verified(1) == verified(2) == 0 and statewide(0) > 0 and statewide(1) > 0)
    used = row("SELECT dabs_requests n FROM fetch_budget")["n"]
    check("S15 requests within limits: <= 500/day, per-store total = 5x2 fresh + 12 failed attempts", used <= 500 and s["requests"] == 5 * 2 + 12, f"used={used} {s}")
    lim = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher", {}).get("perstore", {}).get("limits", {})
    check("S15 /health retry_order = fresh_first_max1_interleave, limits unchanged",
          lim.get("retry_order") == "fresh_first_max1_interleave" and (lim.get("streak_pause"), lim.get("streak_pause_min"), lim.get("retry_max_per_sku"), lim.get("retry_request_limit_per_day"), lim.get("retry_delay_min"), lim.get("day_request_ceiling")) == (3, 15, 3, 50, 15, 500), str(lim))
    start_wrangler()

def s16_schedule_config():
    print("S16: per-store window config (pinned to America/Denver 2026-11-13): */5 10-17 UTC acting 04:00-10:55 local, last tick 10:55 local; catalog 30 17,18 2-8; retry cap 50 (2026-11-10), other caps unchanged")
    import re, datetime
    from zoneinfo import ZoneInfo
    wj = open(os.path.join(ROOT, "wrangler.jsonc")).read(); ix = open(os.path.join(ROOT, "src/index.ts")).read()
    ps = open(os.path.join(ROOT, "src/fetchers/perstore.ts")).read()
    want = {"30-55/5 6 * * *": "sweep", "*/5 7-10 * * *": "sweep", "*/5 10-17 * * *": "perstore", "30 17,18 2-8 * *": "catalog", "*/5 19-22 * * *": "catchup"}   # local-time pinned 2026-11-13 (t80u)
    crons = json.loads(re.search(r'"crons":\s*(\[[^\]]*\])', wj).group(1))
    check("S16 wrangler crons", sorted(crons) == sorted(want), str(crons))
    exp = dict(re.findall(r'^\s*"([^"]+)":\s*"(sweep|catalog|perstore|catchup)"', ix, re.M))
    check("S16 EXPECTED_CRONS matches wrangler", exp == want, str(exp))
    sc = open(os.path.join(ROOT, "src/schedule.ts")).read()
    check("S16 per-store last tick 10:55 America/Denver (local window 04:00-10:55, pinned 2026-11-13)", "perstore: { first: 4 * 60, last: 10 * 60 + 55" in sc and "PERSTORE_LAST_TICK_LOCAL_MIN" in ps)
    check("S16 per-store retry cap 50, other caps unchanged in perstore.ts", all(x in ps for x in ("PERSTORE_DAY_REQUEST_CEILING = 500", "PERSTORE_RETRY_REQUEST_LIMIT = 50", "PERSTORE_MAX_RETRIES_PER_SKU = 3",
          "REQUESTS_PER_SKU = 2", "PERSTORE_RETRY_DELAY_MS = 15 * 60 * 1000", "PERSTORE_STREAK_PAUSE_MS = 15 * 60 * 1000", 'PERSTORE_RETRY_ORDER = "fresh_first_max1_interleave"')))
    ps_t = [h * 60 + m for h in range(11, 18) for m in range(0, 60, 5)]
    check("S16 84 per-store ticks 11:00..17:55, after sweep 10:55, before catalog 18:30", len(ps_t) == 84 and ps_t[0] == 660 and ps_t[-1] == 1075 < 1110 and ps_t[0] > 655)
    # catalog day gating: 18:30 UTC on UTC days 2..8 is the same America/Denver day (and month) in MST and MDT
    ok = True
    for y, mo in ((2026, 11), (2026, 12), (2027, 3), (2027, 4), (2027, 7)):
        for d in range(2, 9):
            loc = datetime.datetime(y, mo, d, 18, 30, tzinfo=datetime.timezone.utc).astimezone(ZoneInfo("America/Denver"))
            ok = ok and (loc.year, loc.month, loc.day) == (y, mo, d) and loc.hour in (11, 12)
    check("S16 catalog 18:30 UTC = 11:30 MST / 12:30 MDT, same Utah day/month as the cron day (days 2-8)", ok)
    h = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher") or {}
    check("S16 /health schedule lists the new crons", sorted(h.get("schedule") or []) == sorted(want), str(h.get("schedule")))
    lim = (h.get("perstore") or {}).get("limits", {})
    check("S16 /health per-store retry cap 50, other limits unchanged", lim.get("retry_order") == "fresh_first_max1_interleave" and (lim.get("streak_pause_min"), lim.get("retry_max_per_sku"),
          lim.get("retry_request_limit_per_day"), lim.get("retry_delay_min"), lim.get("day_request_ceiling"), lim.get("requests_per_sku")) == (15, 3, 50, 15, 500, 2), str(lim))
    b = h.get("budget") or {}
    if not b.get("drop_day"):
        check("S16 /health daily caps unchanged (700 requests, 60 runs)", (b.get("dabs_requests") or {}).get("cap") == 700 and (b.get("runs") or {}).get("cap") == 60, str(b))
    # retired catalog slot 14:30 is rejected (it is inside the per-store window now): logged, no catalog row, no request
    n0 = row("SELECT COUNT(*) n FROM fetch_log WHERE kind='cron' AND status='rejected_cron'")["n"]
    st0 = mock_stats()
    sched("30 14 2-8 * *", 14, 30); sched("30 16 2-8 * *", 16, 30)
    check("S16 retired catalog crons 30 14 2-8 and 30 16 2-8 rejected (logged, no DABS request)",
          row("SELECT COUNT(*) n FROM fetch_log WHERE kind='cron' AND status='rejected_cron'")["n"] == n0 + 2 and mock_stats() == st0)

# ---------------- 2026-11-02 missing-store rule ----------------
import datetime as _dt
from zoneinfo import ZoneInfo as _ZI
OLD = "2026-10-01T00:00:00.000Z"
def mt_day(back=0): return (_dt.datetime.now(_ZI("America/Denver")).date() - _dt.timedelta(days=back)).isoformat()
def seed(i, stocks):
    """Per-store rows we 'hold' for SKU(i) (old verified_at, so any freshness advance is visible)."""
    d1(f"DELETE FROM inventory_latest WHERE sku='{SKU(i)}' AND store_key<>''")
    vals = ",".join(f"('{SKU(i)}','{k}',{q},'{OLD}',0,'{OLD}')" for k, q in stocks.items())
    d1(f"INSERT INTO inventory_latest (sku, store_key, quantity, observed_at, inferred, verified_at) VALUES {vals}")
def prev_missing(i, stores, back=1):
    d1(f"INSERT INTO perstore_missing (sku, day, stores_json, outcome, source, recorded_at) VALUES ('{SKU(i)}','{mt_day(back)}','{json.dumps(stores)}','held','test','{OLD}')")
def srow(i, k): return row(f"SELECT quantity q, inferred, inferred_reason r, verified_at v FROM inventory_latest WHERE sku='{SKU(i)}' AND store_key='{k}'")
def flog(i): return row(f"SELECT status, category, error FROM fetch_log WHERE kind='perstore_detail' AND query LIKE 'sku={SKU(i)};%' ORDER BY id DESC LIMIT 1")
def cats(): return (json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher") or {}).get("perstore") or {}
def today_rec(i): return row(f"SELECT stores_json s, outcome FROM perstore_missing WHERE sku='{SKU(i)}' AND day='{mt_day()}'")
def common(tag, i, s):
    """No retry spent on incomplete answers, request volume unchanged (2 per SKU), 1 detail request for the SKU."""
    check(f"{tag} no retry spent, nothing pending", s["retried"] == 0 and s["retry_requests"] == 0 and '"n"' not in (s["retry_json"] or ""), str(s))
    check(f"{tag} requests unchanged: 8 SKUs x 2 = 16", s["requests"] == 16, str(s))
    st = mock_stats(); check(f"{tag} SKU requested once (GetDetailUrl + ProductDetail)", st["detail"].get(SKU(i)) == 1 and st["pd"].get(SKU(i)) == 1, str(st))
def held_untouched(tag, i, stocks):
    rows = d1(f"SELECT store_key k, quantity q, inferred, verified_at v FROM inventory_latest WHERE sku='{SKU(i)}' AND store_key<>'' ORDER BY store_key")
    check(f"{tag} fail closed: held rows unchanged, nothing zeroed, no freshness advanced",
          {r["k"]: r["q"] for r in rows} == stocks and all(r["v"] == OLD and r["inferred"] == 0 for r in rows), str(rows))

def s17_accept_prev_day():
    print("S17: same stores absent previous Utah day (superset) -> accepted; listed written, absent zeroed + inferred")
    reset_day(); start_mock(); mock_set({SKU(1): "drop1"})
    st1 = statewide(1); seed(1, {"0001": st1 - 1, "0002": 1}); prev_missing(1, ["0001", "0004"])
    to_end(); s = state()
    check("S17 day complete ok=8 failed=0", (s["status"], s["ok"], s["failed"]) == ("complete", 8, 0), str(s))
    a, b = srow(1, "0001"), srow(1, "0002")
    check("S17 listed store written (0002 qty = statewide, fresh)", b["q"] == st1 and b["v"] > OLD and b["inferred"] == 0, str(b))
    check("S17 absent store 0001 qty 0, inferred=1 with reason, freshness advanced", a["q"] == 0 and a["inferred"] == 1 and "absent from the DABS store list" in (a["r"] or "") and a["v"] > OLD, str(a))
    check("S17 inferred snapshot row written", row(f"SELECT COUNT(*) n FROM inventory_snapshots WHERE sku='{SKU(1)}' AND store_id='0001' AND quantity=0 AND inferred=1")["n"] == 1)
    rec = today_rec(1); check("S17 today's absent set recorded (accepted_inferred)", rec and json.loads(rec["s"]) == ["0001"] and rec["outcome"] == "accepted_inferred", str(rec))
    f = flog(1); check("S17 fetch_log ok / missing_store_accepted_inferred", f["status"] == "ok" and f["category"] == "missing_store_accepted_inferred", str(f))
    common("S17", 1, s)
    p = cats(); c = p.get("categories") or {}
    check("S17 /health rule + counters", p.get("missing_store_accept") == "prev_day_same_stores" and c.get("accepted_inferred") == 1 and c.get("inferred_stores") == 1
          and c.get("held_first_day_missing") == 0 and c.get("ok") == 7, str(c))
    req = urllib.request.Request(BASE + f"/product/{SKU(1)}", headers={"Cookie": "ur_age21=1"})
    html = urllib.request.urlopen(req).read().decode()
    check("S17 product page notes the inferred out-of-stock store", "inferred out of stock" in html)
    # a later clean list clears the inferred flag
    reset_day(); seed(1, {"0001": 0, "0002": st1}); d1(f"UPDATE inventory_latest SET inferred=1, inferred_reason='x' WHERE sku='{SKU(1)}' AND store_key='0001'")
    start_mock(); mock_set(); to_end(); a = srow(1, "0001")
    check("S17 next clean list clears inferred on 0001", a["inferred"] == 0 and a["r"] is None and a["q"] == st1 - 1, str(a))

def s18_first_day_held():
    print("S18: store absent for the first time (no previous-day record; an older-day record does not count) -> held")
    for tag, rec in (("S18a", None), ("S18b", 2)):
        reset_day(); start_mock(); mock_set({SKU(1): "drop1"})
        stocks = {"0001": statewide(1) - 1, "0002": 1}; seed(1, stocks)
        if rec: prev_missing(1, ["0001"], back=rec)
        to_end(); s = state()
        check(f"{tag} ok=7 failed=1", (s["ok"], s["failed"]) == (7, 1), str(s))
        held_untouched(tag, 1, stocks)
        r = today_rec(1); check(f"{tag} today's absent set recorded as held", r and json.loads(r["s"]) == ["0001"] and r["outcome"] == "held", str(r))
        f = flog(1); check(f"{tag} fetch_log incomplete / missing_store_held", f["status"] == "incomplete" and f["category"] == "missing_store_held" and "held:" in (f["error"] or ""), str(f))
        common(tag, 1, s)
        c = cats().get("categories") or {}
        check(f"{tag} /health held_first_day_missing=1, accepted_inferred=0", c.get("held_first_day_missing") == 1 and c.get("accepted_inferred") == 0, str(c))
    # the chain continues: tomorrow (simulated by moving today's record back one day) the same store set is accepted
    d1(f"UPDATE perstore_missing SET day='{mt_day(1)}' WHERE sku='{SKU(1)}' AND day='{mt_day()}'")
    d1("DELETE FROM perstore_state"); d1("UPDATE fetch_budget SET dabs_requests = 1, runs = 0"); d1("DELETE FROM fetch_lock")
    start_mock(); mock_set({SKU(1): "drop1"}); to_end()
    a = srow(1, "0001"); check("S18 next day with the same absent store -> accepted (inferred 0)", a["q"] == 0 and a["inferred"] == 1, str(a))

def s19_prev_lacks_one():
    print("S19: previous-day set lacks one of today's absent stores -> held")
    reset_day(); start_mock(); mock_set({SKU(1): "drop12"})
    stocks = {"0001": statewide(1) - 1, "0002": 1}; seed(1, stocks); prev_missing(1, ["0001"])
    to_end(); s = state()
    check("S19 ok=7 failed=1", (s["ok"], s["failed"]) == (7, 1), str(s))
    held_untouched("S19", 1, stocks)
    f = flog(1); check("S19 held, names the first-time store 0002", f["category"] == "missing_store_held" and "first time: 0002" in (f["error"] or ""), str(f))
    r = today_rec(1); check("S19 today's set recorded [0001, 0002]", r and json.loads(r["s"]) == ["0001", "0002"], str(r))
    common("S19", 1, s)

def s20_qty_mismatch():
    print("S20: qty mismatch above/below with a previous-day record -> held, nothing recorded as missing")
    for mode, d in (("drop1above", "above"), ("drop1below", "below")):
        reset_day(); start_mock(); mock_set({SKU(1): mode})
        stocks = {"0001": statewide(1) - 1, "0002": 1}; seed(1, stocks); prev_missing(1, ["0001"])
        to_end(); s = state(); tag = f"S20 {d}"
        check(f"{tag} ok=7 failed=1", (s["ok"], s["failed"]) == (7, 1), str(s))
        held_untouched(tag, 1, stocks)
        f = flog(1); check(f"{tag} fetch_log category qty_mismatch_{d}", f["status"] == "incomplete" and f["category"] == f"qty_mismatch_{d}", str(f))
        check(f"{tag} no absent-set record for today", today_rec(1) is None)
        c = cats().get("categories") or {}
        check(f"{tag} /health qty_mismatch_{d}=1, accepted 0", c.get(f"qty_mismatch_{d}") == 1 and c.get("qty_mismatch") == 1 and c.get("accepted_inferred") == 0, str(c))
        common(tag, 1, s)

def s21_duplicates():
    print("S21: duplicate store row (with a previous-day record) -> held")
    reset_day(); start_mock(); mock_set({SKU(1): "dup"})
    stocks = {"0001": statewide(1) - 1, "0002": 1}; seed(1, stocks); prev_missing(1, ["0001"])
    to_end(); s = state()
    check("S21 ok=7 failed=1", (s["ok"], s["failed"]) == (7, 1), str(s))
    held_untouched("S21", 1, stocks)
    f = flog(1); check("S21 fetch_log category duplicate", f["status"] == "incomplete" and f["category"] == "duplicate", str(f))
    check("S21 /health dup_parse=1", (cats().get("categories") or {}).get("dup_parse") == 1)
    common("S21", 1, s)

def s22_zero_store_list():
    print("S22: zero-store list, statewide 0, same store absent previous day -> accepted")
    reset_day(); start_mock(); mock_set({SKU(1): "nostores"})
    d1(f"UPDATE inventory_latest SET store_total_qty = 0 WHERE sku='{SKU(1)}' AND store_key=''")
    seed(1, {"0003": 4}); prev_missing(1, ["0003"])
    to_end(); s = state()
    check("S22 ok=8 failed=0", (s["ok"], s["failed"]) == (8, 0), str(s))
    a = srow(1, "0003"); check("S22 store 0003 qty 0 inferred, fresh", a["q"] == 0 and a["inferred"] == 1 and a["v"] > OLD, str(a))
    f = flog(1); check("S22 fetch_log ok / missing_store_accepted_inferred", f["status"] == "ok" and f["category"] == "missing_store_accepted_inferred", str(f))
    common("S22", 1, s)
    # same zero-store list without the previous-day record: held under the missing-store rule alone, but since 2026-11-22 (t102u)
    # today's complete sweep saying statewide 0 accepts it under the empty-list rule (S29 covers the rejections)
    reset_day(); start_mock(); mock_set({SKU(1): "nostores"})
    d1(f"UPDATE inventory_latest SET store_total_qty = 0 WHERE sku='{SKU(1)}' AND store_key=''")
    seed(1, {"0003": 4}); to_end(); s = state()
    a = srow(1, "0003"); f = flog(1)
    check("S22 no-record -> empty_accepted (2026-11-22 rule): 0003 qty 0, observed, fresh; ok=8", s["ok"] == 8 and a["q"] == 0 and a["inferred"] == 0 and a["v"] > OLD
          and f["category"] == "empty_accepted", f"{s} {a} {f}")

def s29_empty_list_rule():
    """2026-11-22 (owner-approved t102u): empty store list accepted ONLY with today's complete sweep saying statewide 0."""
    print("S29: empty-list rule: accepted case + rejections (sweep incomplete / statewide > 0 / prior-day sweep / degraded / changed after sweep / not clean)")
    day = mt_day()
    sw0 = row(f"SELECT status, degraded, vanish_skipped, completed_at FROM sweep_state WHERE day='{day}'")
    assert sw0 and sw0["status"] == "complete", sw0
    stocks = {"0003": 4, "0005": 2}
    def run(mode="nostores", statewide_qty=0, before_tick=None, prev=None):
        reset_day(); start_mock(); mock_set({SKU(1): mode})
        d1(f"UPDATE inventory_latest SET store_total_qty = {statewide_qty} WHERE sku='{SKU(1)}' AND store_key=''")
        seed(1, stocks)
        if prev: prev_missing(1, prev)
        snaps0 = row(f"SELECT COUNT(*) n FROM inventory_snapshots WHERE sku='{SKU(1)}' AND store_id IS NOT NULL")["n"]
        r = tick(maxSkus=1)                        # SKU(0) only: the day's queue is built while today's sweep is complete
        assert r.get("skus") == 1, r
        if before_tick: before_tick()
        to_end(); return state(), snaps0
    def restore():
        d1(f"UPDATE sweep_state SET day='{day}' WHERE day='{mt_day(1)}' AND completed_at='{sw0['completed_at']}'")
        d1(f"UPDATE sweep_state SET status='complete', degraded=NULL, vanish_skipped=NULL, completed_at='{sw0['completed_at']}' WHERE day='{day}'")
    def held(tag, s, snaps0, cat="missing_store_held", why=None):
        check(f"{tag} ok=7 failed=1", (s["ok"], s["failed"]) == (7, 1), str(s))
        held_untouched(tag, 1, stocks)
        f = flog(1); check(f"{tag} fetch_log incomplete / {cat}" + (f" naming '{why}'" if why else ""), f["status"] == "incomplete" and f["category"] == cat and (why is None or why in (f["error"] or "")), str(f))
        check(f"{tag} no snapshot written", row(f"SELECT COUNT(*) n FROM inventory_snapshots WHERE sku='{SKU(1)}' AND store_id IS NOT NULL")["n"] == snaps0)
        r = today_rec(1); check(f"{tag} not recorded as empty_accepted", r is None or r["outcome"] == "held", str(r))
        check(f"{tag} /health empty_accepted=0", (cats().get("categories") or {}).get("empty_accepted") == 0)
        common(tag, 1, s)

    # accepted
    s, snaps0 = run()
    check("S29a ok=8 failed=0", (s["ok"], s["failed"]) == (8, 0), str(s))
    rows = {k: srow(1, k) for k in stocks}
    check("S29a every held store -> qty 0, observed (inferred 0, no reason), verified now", all(r["q"] == 0 and r["inferred"] == 0 and r["r"] is None and r["v"] > OLD for r in rows.values()), str(rows))
    new = d1(f"SELECT store_id k, quantity q, inferred FROM inventory_snapshots WHERE sku='{SKU(1)}' AND store_id IS NOT NULL ORDER BY id DESC LIMIT {max(0, row(f"SELECT COUNT(*) n FROM inventory_snapshots WHERE sku='{SKU(1)}' AND store_id IS NOT NULL")['n'] - snaps0)}")
    check("S29a exactly one new snapshot per zeroed store (qty 0, not inferred)", sorted((r["k"], r["q"], r["inferred"]) for r in new) == [("0003", 0, 0), ("0005", 0, 0)], str(new))
    f = flog(1); check("S29a fetch_log ok / empty_accepted, logged as 'empty-accepted'", f["status"] == "ok" and f["category"] == "empty_accepted" and (f["error"] or "").startswith("empty-accepted:") and "0003,0005" in f["error"], str(f))
    r = today_rec(1); check("S29a perstore_missing outcome empty_accepted", r and r["outcome"] == "empty_accepted" and json.loads(r["s"]) == ["0003", "0005"], str(r))
    p = cats(); c = p.get("categories") or {}
    check("S29a /health rule + empty_accepted=1, ok excludes it, accepted_inferred=0", p.get("empty_list_accept") == "complete_sweep_today_statewide_0" and c.get("empty_accepted") == 1
          and c.get("ok") == 7 and c.get("accepted_inferred") == 0 and c.get("held_first_day_missing") == 0, str(c))
    common("S29a", 1, s)
    check("S29a statewide row untouched (still 0)", statewide(1) == 0)
    # the missing-store rule still wins when it applies (unchanged: inferred zeros, not empty_accepted)
    s, _ = run(prev=["0003", "0005"])
    f = flog(1); check("S29a2 previous-day record present -> missing-store rule as before (accepted_inferred)", f["category"] == "missing_store_accepted_inferred" and srow(1, "0003")["inferred"] == 1, str(f))

    # rejected: today's sweep not complete (status flips mid-day, e.g. catch-up re-opened it)
    try:
        s, sn = run(before_tick=lambda: d1(f"UPDATE sweep_state SET status='running' WHERE day='{day}'"))
        held("S29b sweep incomplete", s, sn, why="not complete")
    finally: restore()
    # rejected: the sweep says statewide > 0 (the list then also fails the sum check)
    s, sn = run(statewide_qty=3)
    held("S29c sweep statewide 3", s, sn, cat="qty_mismatch_below")
    # rejected: only a prior day's complete sweep (today's row gone)
    try:
        s, sn = run(before_tick=lambda: d1(f"UPDATE sweep_state SET day='{mt_day(1)}' WHERE day='{day}'"))
        held("S29d sweep from a prior day", s, sn, why=f"no nightly sweep for {day}")
    finally: restore()
    # rejected: today's sweep complete but degraded / vanish skipped
    try:
        s, sn = run(before_tick=lambda: d1(f"UPDATE sweep_state SET degraded='total drifted', vanish_skipped='degraded: total drifted' WHERE day='{day}'"))
        held("S29e sweep degraded", s, sn, why="degraded")
    finally: restore()
    # rejected: product row written after the sweep completed (not the sweep's value)
    try:
        s, sn = run(before_tick=lambda: d1(f"UPDATE inventory_latest SET observed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds') WHERE sku='{SKU(1)}' AND store_key=''"))
        held("S29f product row changed after the sweep", s, sn, why="changed after the nightly sweep")
    finally: restore()
    # rejected: response not clean (unparseable page) -> parse failure, nothing written
    s, sn = run(mode="badshape")
    check("S29g bad shape ok=7 failed=1", (s["ok"], s["failed"]) == (7, 1), str(s))
    held_untouched("S29g bad shape", 1, stocks)
    f = flog(1); check("S29g fetch_log parse failure, not empty_accepted", f["category"] == "parse", str(f))
    check("S29g nothing recorded for today", today_rec(1) is None)
    # rejected: non-empty clean list (rows at 0 qty are not 'empty')
    s, sn = run(mode="short")
    f = flog(1); check("S29h non-empty list never empty_accepted", f["category"] != "empty_accepted" and srow(1, "0005")["q"] == 2, str(f))
    # rejected: transient 522 -> retry queued, nothing written
    s, sn = run(mode="http500")
    f = flog(1); check("S29i HTTP 5xx -> not empty_accepted, nothing written", f["category"] != "empty_accepted" and srow(1, "0003")["q"] == 4 and srow(1, "0003")["v"] == OLD, str(f))
    reset_day()

def s23_catalog_pause():
    """2026-11-03 (owner-approved): catalog-only pause of the AUTOMATIC monthly import (KV catalog:v1:auto, default paused).
    Safety: a 'complete' row for this Utah month is inserted first, so even a broken flag can only reach the no-request
    'already complete' no-op; the catalog page is never fetched (the mock run has no DABS_CATALOG_URL)."""
    print("S23: catalog cron paused by default (no request, no lock, no run); 'on' lets it through; admin path, per-store untouched")
    period = _dt.datetime.now(_ZI("America/Denver")).strftime("%Y-%m")
    d1("DELETE FROM catalog_import")
    d1(f"INSERT INTO catalog_import (period, status, attempts, started_at, updated_at) VALUES ('{period}', 'complete', 1, '{OLD}', '{OLD}')")
    kv = lambda *a: sh(NPX + ["kv", "key", *a, "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST])
    kv("delete", "catalog:v1:auto")
    paused = lambda: row("SELECT COUNT(*) n FROM fetch_log WHERE kind='catalog' AND status='paused'")["n"]
    p0, st0, r0, b0 = paused(), mock_stats(), runs(), row("SELECT dabs_requests n FROM fetch_budget")["n"]
    h = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher") or {}
    check("S23 /health catalog_auto_import paused by default (key absent)", (h.get("catalog_auto_import") or {}).get("state") == "paused", str(h.get("catalog_auto_import")))
    sched("30 17,18 2-8 * *", 18, 30)
    check("S23 paused cron tick logs 'paused', no DABS request, no run, no budget request, no lock",
          paused() == p0 + 1 and mock_stats() == st0 and runs() == r0 and row("SELECT dabs_requests n FROM fetch_budget")["n"] == b0
          and row("SELECT COUNT(*) n FROM fetch_lock WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')")["n"] == 0)
    kv("put", "catalog:v1:auto", "off"); sched("30 17,18 2-8 * *", 18, 30)
    check("S23 any value other than 'on' stays paused", paused() == p0 + 2 and mock_stats() == st0)
    kv("put", "catalog:v1:auto", "on")
    h = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher") or {}
    check("S23 /health shows 'on' after re-enable", (h.get("catalog_auto_import") or {}).get("state") == "on")
    sched("30 17,18 2-8 * *", 18, 30)
    check("S23 'on' -> cron reaches the normal gating (complete month no-op), no paused log, no request", paused() == p0 + 2 and mock_stats() == st0)
    r = post({"catalogImport": True})
    check("S23 admin catalogImport not affected by the cron pause (normal 'already complete' no-op)", r.get("action") == "noop", str(r))
    kv("delete", "catalog:v1:auto")
    r = post({"catalogImport": True})
    check("S23 admin catalogImport still uses normal gating while paused", r.get("action") == "noop", str(r))
    d1("DELETE FROM catalog_import")
    # per-store unaffected by the catalog flag: the same per-store day with the flag absent (paused) and 'on' gives the
    # identical result (compared, not hard-coded, so leftovers from earlier scenarios, e.g. S22's statewide 0, don't matter)
    key = lambda x: (x["status"], x["total"], x["ok"], x["failed"], x["skipped"], x["retried"], x["retry_requests"], x["requests"])
    reset_day(); start_mock(); mock_set(); to_end(); s_paused = state()
    kv("put", "catalog:v1:auto", "on")
    reset_day(); start_mock(); mock_set(); to_end(); s_on = state()
    kv("delete", "catalog:v1:auto")
    check("S23 per-store day identical with catalog paused and on (complete, 16 requests, no retries)",
          key(s_paused) == key(s_on) and s_paused["status"] == "complete" and s_paused["requests"] == 16 and s_paused["retry_requests"] == 0,
          f"{s_paused} vs {s_on}")

def s27_popular_stalest_first():
    """2026-11-04 (owner-approved option D): popular part of the queue = stalest first (never-updated first, then oldest
    last good per-store update = fetch_log perstore_detail status 'ok' incl. missing_store_accepted_inferred), ties ->
    statewide qty DESC, then SKU. B1 part unchanged and first. Queue-only check: the ceiling is pre-filled so no requests."""
    print("S27: popular fetch order = stalest first; B1 unchanged and first")
    kv = lambda *a: sh(NPX + ["kv", "key", *a, "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST])
    P = {  # sku: (statewide qty, rank)  -- ranks deliberately NOT in the expected order
        "800001": (5, 1), "800002": (9, 2), "800003": (1, 3), "800004": (50, 4), "800005": (50, 5),
        "800006": (80, 6), "800007": (1, 7), "800008": (3, 8), "800009": (0, 9)}
    ts = "2026-11-01T00:00:00.000Z"
    d1("INSERT OR REPLACE INTO products (sku, name, status) VALUES " + ",".join(f"('{k}','Pop {k}','G')" for k in P))
    d1("INSERT OR REPLACE INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at) VALUES "
       + ",".join(f"('{k}','',{v[0]},{v[0]},0,'{ts}')" for k, v in P.items()))
    d1("INSERT OR REPLACE INTO perstore_popular (sku, rank, locked, source, added_at, updated_at) VALUES "
       + ",".join(f"('{k}',{v[1]},1,'admin','{ts}','{ts}')" for k, v in P.items()) + f",('{SKU(0)}',0,1,'admin','{ts}','{ts}')")
    logs = [  # (sku, started_at, status, category)
        ("800003", "2026-11-01T12:00:00.000Z", "ok", None), ("800003", "2026-11-04T12:00:00.000Z", "failed", "transient_exhausted"),
        ("800004", "2026-11-03T12:00:00.000Z", "ok", None), ("800005", "2026-11-03T12:00:00.000Z", "ok", None),
        ("800006", "2026-11-03T12:00:00.000Z", "ok", None), ("800006", "2026-10-01T12:00:00.000Z", "ok", None),
        ("800007", "2026-10-01T12:00:00.000Z", "failed", "http_error"),
        ("800008", "2026-11-02T12:00:00.000Z", "ok", "missing_store_accepted_inferred")]
    d1("INSERT INTO fetch_log (source, kind, query, started_at, status, category) VALUES "
       + ",".join(f"('dabs','perstore_detail','sku={k};list=popular','{t}','{st}',{('NULL' if c is None else repr(c))})" for k, t, st, c in logs))
    try:
        kv("put", "perstore:v1:popular", "on")
        reset_day(requests_used=499); tick()
        st = row("SELECT queue q, b1_total b, popular_total p, popular_note n FROM perstore_state")
        q = st["q"].split(","); b1, pop = q[:st["b"]], q[st["b"]:]
        exp_b1 = [r["sku"] for r in d1("SELECT p.sku FROM products p JOIN inventory_latest l ON l.sku=p.sku AND l.store_key='' WHERE p.status='A' "
                  "AND (COALESCE(l.store_total_qty,0)>0 OR COALESCE(l.quantity,0)>0 OR COALESCE(l.on_order_qty,0)>0) ORDER BY COALESCE(l.store_total_qty,0) DESC, p.sku")]
        check("S27 B1 part unchanged (statewide qty DESC, SKU) and comes first", b1 == exp_b1 and len(b1) == 8, f"{b1} vs {exp_b1}")
        check("S27 B1 SKU in popular list deduped, zero-qty popular skipped", SKU(0) not in pop and "800009" not in pop and "already in B1 1" in st["n"], st["n"])
        mine = [x for x in pop if x.startswith("8000")]
        exp = ["800002", "800001", "800007", "800003", "800008", "800006", "800004", "800005"]
        check("S27 popular order stalest first: never-updated, then oldest last good, ties qty DESC then SKU", mine == exp, f"{mine}")
        check("S27 never-updated (incl. only-failed history) come first of all", mine[:3] == ["800002", "800001", "800007"], str(mine))
        check("S27 newest log row decides (failed rows ignored; accepted_inferred counts as good)", mine.index("800003") < mine.index("800008") < mine.index("800006"), str(mine))
        check("S27 tie on last good -> higher statewide qty, then SKU", mine[-3:] == ["800006", "800004", "800005"], str(mine))
        h = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher", {}).get("perstore", {})
        check("S27 /health fetcher.perstore.popular_order = stalest_first", h.get("popular_order") == "stalest_first", str(h.get("popular_order")))
        lim = h.get("limits", {})
        check("S27 caps: retry 50, 3/SKU, 2 req/SKU, ceiling 500", (lim.get("retry_request_limit_per_day"), lim.get("retry_max_per_sku"), lim.get("requests_per_sku"), lim.get("day_request_ceiling")) == (50, 3, 2, 500), str(lim))
    finally:
        kv("delete", "perstore:v1:popular")
        d1("DELETE FROM fetch_log WHERE query LIKE 'sku=8000%'")
        d1("UPDATE perstore_popular SET locked = 0 WHERE sku IN (" + ",".join(f"'{k}'" for k in [*P, SKU(0)]) + ")")   # trigger keeps locked rows
        d1("DELETE FROM perstore_popular WHERE sku IN (" + ",".join(f"'{k}'" for k in [*P, SKU(0)]) + ")")
        d1("DELETE FROM inventory_latest WHERE sku LIKE '8000%'"); d1("DELETE FROM products WHERE sku LIKE '8000%'")
        reset_day()

def s28_popular_auto_prune_all_public():
    """2026-11-05 (owner-approved): unlocked popular SKUs with qty>0 in EVERY public (non-club) store are auto-removed
    from perstore_popular when the daily popular queue is built. Locked rows stay. Club stores don't count. Zero
    public stores -> no-op. Queue-only (ceiling pre-filled); zero DABS requests."""
    print("S28: popular auto-prune when stocked in all public DABS stores")
    import re as _re
    kv = lambda *a: sh(NPX + ["kv", "key", *a, "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST])
    ts = "2026-11-05T00:00:00.000Z"
    club_re = _re.compile(r"club store|licensed operations only", _re.I)
    fixture_pubs = [f"8{i:03d}" for i in range(1, 6)]   # 8001..8005
    fixture_clubs = ["8091", "8092"]
    d1("INSERT OR REPLACE INTO stores (id,name,address,city,phone,lat,lng,updated_at) VALUES "
       + ",".join(f"('{s}','State Store #{s}','1 Main','SLC',NULL,NULL,NULL,'{ts}')" for s in fixture_pubs)
       + ","
       + ",".join(f"('{s}','State Store #{s} (Club store for licensed operations only)','1 Club','SLC',NULL,NULL,NULL,'{ts}')" for s in fixture_clubs))

    def public_ids():
        return [r["id"] for r in d1("SELECT id, name FROM stores") if not club_re.search(r["name"] or "")]

    def listed():
        return {r["sku"] for r in d1("SELECT sku FROM perstore_popular WHERE sku LIKE '8100%'")}

    def seed_per_store_stock(pubs, have):
        """Must run AFTER reset_day (which deletes inventory_latest WHERE store_key <> '')."""
        inv = []
        for s in pubs: inv.append(f"('810001','{s}',1,NULL,NULL,'{ts}',0)")
        for s in have: inv.append(f"('810002','{s}',1,NULL,NULL,'{ts}',0)")
        for s in pubs: inv.append(f"('810003','{s}',1,NULL,NULL,'{ts}',0)")
        for s in fixture_clubs: inv.append(f"('810004','{s}',5,NULL,NULL,'{ts}',0)")
        for s in have: inv.append(f"('810005','{s}',1,NULL,NULL,'{ts}',0)")
        d1("INSERT OR REPLACE INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at, inferred) VALUES "
           + ",".join(inv))

    pubs = public_ids()
    assert len(pubs) >= 5, f"need >=5 public stores for S28, got {len(pubs)}"
    miss = pubs[-1]
    have = pubs[:-1]
    skus = ["810001", "810002", "810003", "810004", "810005"]
    d1("INSERT OR REPLACE INTO products (sku, name, status) VALUES "
       + ",".join(f"('{k}','AutoPrune {k}','L')" for k in skus))
    d1("INSERT OR REPLACE INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at) VALUES "
       + ",".join(f"('{k}','',10,10,0,'{ts}')" for k in skus))
    d1("INSERT OR REPLACE INTO perstore_popular (sku, rank, locked, source, note, added_at, updated_at) VALUES "
       f"('810001',1,0,'admin','prune me','{ts}','{ts}'),"
       f"('810002',2,0,'admin','keep N-1','{ts}','{ts}'),"
       f"('810003',3,1,'admin','locked keep','{ts}','{ts}'),"
       f"('810004',4,0,'admin','club only','{ts}','{ts}'),"
       f"('810005',5,0,'admin','zero-public edge','{ts}','{ts}')")
    store_snap = d1("SELECT id,name,address,city,phone,lat,lng,updated_at FROM stores")

    try:
        kv("put", "perstore:v1:popular", "on")
        before_ev = row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='popular_auto_pruned'")["n"]
        n_pub = len(pubs)
        reset_day(requests_used=499)
        seed_per_store_stock(pubs, have)   # after reset_day — it wipes per-store inventory
        tick()
        st = row("SELECT queue q, b1_total b, popular_total p, popular_note n FROM perstore_state")
        q = (st["q"] or "").split(",") if st and st["q"] else []
        pop = q[st["b"]:] if st else []
        left = listed()
        check("S28 prune when stock in all public stores (810001 gone)", "810001" not in left, str(left))
        check("S28 do not prune at N-1 of N (810002 kept)", "810002" in left, f"left={left} miss={miss} n_pub={n_pub}")
        check("S28 do not prune locked (810003 kept)", "810003" in left, str(left))
        check("S28 club stock alone does not satisfy (810004 kept)", "810004" in left, str(left))
        check("S28 pruned SKU excluded from today's popular fetch list", "810001" not in pop, str(pop))
        check("S28 kept SKUs still in today's popular fetch list",
              all(x in pop for x in ("810002", "810003", "810004", "810005")), str(pop))
        check("S28 popular_note mentions auto-pruned", "auto-pruned" in (st["n"] or "") and "auto-pruned 0" not in (st["n"] or ""), str(st.get("n")))
        ev = row("SELECT error e FROM fetch_log WHERE kind='perstore' AND status='popular_auto_pruned' ORDER BY id DESC LIMIT 1")
        check("S28 popular_auto_pruned event logged with 810001",
              ev and "810001" in (ev["e"] or "") and "all_public_stores" in (ev["e"] or ""), str(ev))
        check("S28 exactly one new auto-prune event this run",
              row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='popular_auto_pruned'")["n"] == before_ev + 1)
        h = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher", {}).get("perstore", {})
        pop_h = h.get("popular") or {}
        check("S28 /health auto_prune_rule = all_public_stores", pop_h.get("auto_prune_rule") == "all_public_stores", str(pop_h))
        check("S28 /health public_stores matches live non-club count", int(pop_h.get("public_stores") if pop_h.get("public_stores") is not None else -1) == n_pub, f"{pop_h.get('public_stores')} vs {n_pub}")
        lap = pop_h.get("last_auto_prune") or {}
        check("S28 /health last_auto_prune lists 810001", "810001" in (lap.get("skus") or []), str(lap))
        lim = h.get("limits", {})
        check("S28 caps: retry 50, other limits unchanged", (lim.get("retry_request_limit_per_day"), lim.get("retry_max_per_sku"), lim.get("requests_per_sku"), lim.get("day_request_ceiling"), lim.get("b1_max_skus"), lim.get("popular_max_skus")) == (50, 3, 2, 500, 60, 100), str(lim))
        check("S28 popular_order still stalest_first", h.get("popular_order") == "stalest_first", str(h.get("popular_order")))

        # Zero public stores: keep only club stores in the table, then rebuild the queue.
        d1("DELETE FROM stores")
        d1("INSERT OR REPLACE INTO stores (id,name,address,city,phone,lat,lng,updated_at) VALUES "
           + ",".join(f"('{s}','State Store #{s} (Club store for licensed operations only)','1 Club','SLC',NULL,NULL,NULL,'{ts}')" for s in fixture_clubs))
        d1("INSERT OR REPLACE INTO perstore_popular (sku, rank, locked, source, note, added_at, updated_at) VALUES "
           f"('810001',1,0,'admin','should stay when no public','{ts}','{ts}')")
        before = listed()
        before_ev2 = row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='popular_auto_pruned'")["n"]
        assert len(public_ids()) == 0, public_ids()
        reset_day(requests_used=499)
        # Re-seed club-only stock so the club-only SKU path stays meaningful; public stock rows are irrelevant with 0 public stores.
        d1("INSERT OR REPLACE INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at, inferred) VALUES "
           + ",".join(f"('810001','{s}',1,NULL,NULL,'{ts}',0)" for s in fixture_clubs)
           + ","
           + ",".join(f"('810004','{s}',5,NULL,NULL,'{ts}',0)" for s in fixture_clubs))
        tick()
        after = listed()
        check("S28 zero public stores edge does nothing (810001 stays, no new prune event)",
              "810001" in after and after == before
              and row("SELECT COUNT(*) n FROM fetch_log WHERE kind='perstore' AND status='popular_auto_pruned'")["n"] == before_ev2,
              f"before={before} after={after}")
        h2 = json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher", {}).get("perstore", {}).get("popular") or {}
        check("S28 /health public_stores=0 when every store is club",
              (0 if h2.get("public_stores") is None else int(h2.get("public_stores"))) == 0, str(h2.get("public_stores")))
        check("S28 /health still exposes auto_prune_rule after zero-public pass", h2.get("auto_prune_rule") == "all_public_stores", str(h2))
    finally:
        kv("delete", "perstore:v1:popular")
        d1("DELETE FROM stores")
        if store_snap:
            def esc(v):
                if v is None: return "NULL"
                if isinstance(v, (int, float)): return str(v)
                return "'" + str(v).replace("'", "''") + "'"
            d1("INSERT OR REPLACE INTO stores (id,name,address,city,phone,lat,lng,updated_at) VALUES "
               + ",".join("(" + ",".join(esc(r[c]) for c in ("id","name","address","city","phone","lat","lng","updated_at")) + ")" for r in store_snap))
        d1("UPDATE perstore_popular SET locked = 0 WHERE sku LIKE '8100%'")
        d1("DELETE FROM perstore_popular WHERE sku LIKE '8100%'")
        d1("DELETE FROM inventory_latest WHERE sku LIKE '8100%'")
        d1("DELETE FROM products WHERE sku LIKE '8100%'")
        d1("DELETE FROM fetch_log WHERE status='popular_auto_pruned' AND IFNULL(error,'') LIKE '%8100%'")
        reset_day()


if __name__ == "__main__":
    try:
        setup()
        for f in (s1_single_522_then_success, s2_three_retries_then_failed, s3_global_retry_limit, s4_hard_errors, s5_distinct_streak, s6_ceiling, s7_stale_row, s8_window_end, s9_new_window, s10_pause_resume,
                  s11_timeout_retry, s12_timeout_streak, s13_timeout_limits, s14_runs, s15_fresh_first, s16_schedule_config,
                  s17_accept_prev_day, s18_first_day_held, s19_prev_lacks_one, s20_qty_mismatch, s21_duplicates, s22_zero_store_list, s23_catalog_pause, s24_repause, s25_repause_retry_probe, s26_429_after_pause, s27_popular_stalest_first, s28_popular_auto_prune_all_public, s29_empty_list_rule):
            if len(sys.argv) > 1 and f.__name__.split("_")[0] not in sys.argv[1:]: continue   # e.g. `... s15` runs one scenario
            f()
    finally:
        cleanup()
    print(f"\n{passes} passed, {len(fails)} failed" + (": " + "; ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)
