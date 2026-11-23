#!/usr/bin/env python3
"""Simulated tests for the nightly-sweep transient-5xx / timeout retry (src/fetchers/sweep.ts). ZERO real DABS requests: everything runs
against scripts/mock-dabs.py (port 9911) + `wrangler dev --local` (port 8788) with a throwaway D1/KV persist dir
(/tmp/ur-sweep-test). Needs .dev.vars pointing at the local mock (DABS_BASE_URL=http://127.0.0.1:9911/dyn, FETCHER_ENABLED=true,
DABS_TEST_MIN_GAP_MS=300). The admin token is read from .dev.vars into memory only and never printed.

Run (Node 22 on PATH):  python3 scripts/test-sweep-retry.py        # exits non-zero on any failure
Mock catalog: 199 in-stock items -> 5 pages (start 0, 48, 96, 144, 192). Each scenario first restores a baseline with a clean
sweep, then changes items 110-119 (only on page start=96) and removes item 199 (a vanish-to-zero candidate), so we can see
whether a failed page / incomplete sweep wrote anything, marked anything out of stock, or advanced freshness."""
import json, os, shutil, signal, subprocess, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERSIST = "/tmp/ur-sweep-test"
BASE = "http://127.0.0.1:8788"
MOCK = "http://127.0.0.1:9911"
RETRY_DELAY_MS = 2500
REQ_TIMEOUT_MS = 1500   # mock-only DABS_TEST_REQUEST_TIMEOUT_MS; mock "sleep" pages stall 2500 ms
SLOW = "sleep:2500"
NPX = ["npx", "wrangler"]
procs, fails, passes = [], [], 0

def env_val(k):
    for line in open(os.path.join(ROOT, ".dev.vars")):
        if line.startswith(k + "="): return line.strip().split("=", 1)[1]
    raise SystemExit(f"{k} missing in .dev.vars")
TOKEN = env_val("ADMIN_TOKEN")
assert env_val("DABS_BASE_URL").startswith("http://127.0.0.1:9911"), "refusing to run: .dev.vars does not point at the local mock"

def sh(args): return subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
def d1(sql):
    r = sh(NPX + ["d1", "execute", "utah-remedy-db", "--local", "--persist-to", PERSIST, "--json", "--command", sql])
    try: out = json.loads(r.stdout)
    except ValueError: raise SystemExit(f"d1 failed: {r.stdout[-400:]} {r.stderr[-400:]}")
    return out[0]["results"] if out else []
def row(sql):
    r = d1(sql); return r[0] if r else None
def kv_get(key):
    return sh(NPX + ["kv", "key", "get", key, "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST, "--text"]).stdout.strip()
def kv_del(key):
    sh(NPX + ["kv", "key", "delete", key, "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST])
def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  PASS {name}")
    else: fails.append(name); print(f"  FAIL {name} {detail}")

def start_mock():
    for n, p in list(procs):
        if n == "mock": p.terminate(); p.wait(); procs.remove((n, p))
    p = subprocess.Popen([sys.executable, "scripts/mock-dabs.py", "9911"], cwd=ROOT); procs.append(("mock", p)); time.sleep(0.6)
def start_wrangler(last_tick="0", pause_ms=None, rest_ms=None):
    stop_wrangler()
    extra = ["--var", f"DABS_TEST_SWEEP_PAUSE_MS:{pause_ms}"] if pause_ms else []
    if rest_ms: extra += ["--var", f"DABS_TEST_SWEEP_REST_MS:{rest_ms}"]   # mock-only override of the 30 min page rest
    p = subprocess.Popen(NPX + ["dev", "--port", "8788", "--test-scheduled", "--persist-to", PERSIST, "--var", f"DABS_TEST_RETRY_DELAY_MS:{RETRY_DELAY_MS}",
                                "--var", f"DABS_TEST_LAST_TICK:{last_tick}", "--var", f"DABS_TEST_REQUEST_TIMEOUT_MS:{REQ_TIMEOUT_MS}"] + extra, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    procs.append(("wrangler", p))
    for _ in range(90):
        try: urllib.request.urlopen(BASE + "/health", timeout=3); return
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
    for n, p in list(procs):
        if n == "mock": p.terminate(); p.wait(); procs.remove((n, p))
    stop_wrangler()

def post(body):
    req = urllib.request.Request(BASE + "/internal/fetch/dabs", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)
    except urllib.error.HTTPError as e: return {"error": e.code, "body": e.read().decode()[:200]}
def tick(): return post({"sweepTick": True})
def page_hits(start): return json.load(urllib.request.urlopen(MOCK + "/__stats"))["page"].get(str(start), 0)

def prods(changed, n_items=200):
    out = []
    for i in range(n_items):
        st = 5 + i % 11 + (3 if changed and 110 <= i <= 119 else 0)
        if changed and i == 199: continue
        out.append({"sku": f"{900000+i}", "name": f"MOCK PRODUCT {i:04d} 750ml", "wh": 10 + i % 7, "st": st, "oo": 0})
    return out
def mock_set(changed=True, page_mode=None, fail_at=None, fail_kind=None, n_items=200):
    json.dump({"scenario": "good", "products": prods(changed, n_items), "page_mode": page_mode or {}, "fail_at_start": fail_at, "fail_kind": fail_kind},
              open("/tmp/mock-dabs-state.json", "w"))
SKU = lambda i: f"{900000+i}"

def reset_day():
    d1("DELETE FROM sweep_state")
    d1("UPDATE fetch_budget SET dabs_requests = 0, runs = 0, exhausted_reason = NULL")
    kv_del("dabs:v1:backoff_until"); d1("DELETE FROM fetch_lock")
def baseline():
    """Clean sweep of the unchanged catalog (200 items), then a fresh day for the scenario."""
    reset_day(); start_mock(); mock_set(changed=False)
    r = tick()
    assert r.get("sweep_status") == "complete", f"baseline sweep not complete: {r}"
    reset_day(); start_mock()
def state(): return row("SELECT status, pages_done, next_start, total_last, error, retry_json, retried, recovered, retry_requests, transient_errors, vanished_applied, completed_at, rest_cycles, page_failures_json FROM sweep_state")
def resting(s): return [p for p in json.loads(s["retry_json"] or "{}").get("pending", []) if p.get("rest")]
def health_sweep(): return (json.load(urllib.request.urlopen(BASE + "/health")).get("fetcher") or {}).get("last_sweep") or {}
def maxid(): return row("SELECT COALESCE(MAX(id), 0) m FROM fetch_log")["m"]
def inv(i): return row(f"SELECT store_total_qty q, observed_at o, inferred FROM inventory_latest WHERE sku='{SKU(i)}' AND store_key=''")
def page96_untouched(base):
    return all(inv(i)["q"] == base[i]["q"] and inv(i)["o"] == base[i]["o"] for i in range(110, 120))
def snap(): return {i: inv(i) for i in list(range(110, 120)) + [199]}
def last_ok(): 
    try: return json.loads(kv_get("dabs:v1:status") or "{}").get("last_ok_at")
    except ValueError: return None
def backoff_set():
    v = kv_get("dabs:v1:backoff_until"); return v.isdigit() and int(v) > time.time() * 1000
def backoff_min():
    """Minutes of backoff remaining (0 if none)."""
    v = kv_get("dabs:v1:backoff_until"); return max(0.0, (int(v) - time.time() * 1000) / 60000) if v.isdigit() else 0.0
def is_15min(): m = backoff_min(); return 13.5 <= m <= 15.05
def is_1h(): m = backoff_min(); return 58 <= m <= 60.05

def setup():
    shutil.rmtree(PERSIST, ignore_errors=True)
    r = sh(NPX + ["d1", "migrations", "apply", "utah-remedy-db", "--local", "--persist-to", PERSIST]); assert r.returncode == 0, r.stdout[-500:] + r.stderr[-500:]
    start_mock(); start_wrangler()
    baseline(); print("setup ok; baseline sweep complete")

def t1_single_522_recovers():
    print("T1: single 522 on one page, then recovered on retry")
    baseline(); b = snap(); ok0 = last_ok(); mock_set(page_mode={"96": "fail:522:1"})
    r = tick(); s = state()
    check("T1 tick1 does not end the sweep (progress, still running)", r.get("action") == "progress" and s["status"] == "running", f"{r} {s}")
    check("T1 no 1 h backoff", not backoff_set())
    check("T1 page 96 queued for retry, later pages fetched", '"start":96' in (s["retry_json"] or "") and s["pages_done"] == 4 and s["transient_errors"] == 1, str(s))
    check("T1 fail closed meanwhile: page-96 items untouched, no vanish, freshness not advanced", page96_untouched(b) and inv(199)["q"] > 0 and s["vanished_applied"] is None and last_ok() == ok0)
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    r = tick(); s = state()
    check("T1 tick2 retry succeeds -> complete", r.get("sweep_status") == "complete" and s["status"] == "complete", f"{r} {s}")
    check("T1 counters retried=1 recovered=1 retry_requests=1", (s["retried"], s["recovered"], s["retry_requests"]) == (1, 1, 1), str(s))
    check("T1 page-96 items now updated (+3)", all(inv(i)["q"] == b[i]["q"] + 3 for i in range(110, 120)))
    check("T1 vanish-to-zero applied only after complete (item 199 -> 0)", s["vanished_applied"] == 1 and inv(199)["q"] == 0, str(inv(199)))
    check("T1 freshness (last_ok_at) advanced on complete", last_ok() != ok0)
    check("T1 mock saw page 96 twice", page_hits(96) == 2, str(page_hits(96)))

def t2_three_retries_then_rest():
    print("T2: page keeps failing -> 1 try + 3 retries, then the page RESTS 30 min (sweep not failed), nothing partial advanced")
    baseline(); b = snap(); ok0 = last_ok(); m0 = maxid(); mock_set(page_mode={"96": "fail:522:*"})
    tick()
    for _ in range(3):
        wait(); tick()
    s = state(); rest = resting(s)
    check("T2 after 3 retries: sweep still running (not failed), page 96 resting once, due ~30 min later",
          s["status"] == "running" and s["error"] is None and len(rest) == 1 and rest[0]["start"] == 96 and rest[0]["rest"] == 1 and rest[0]["n"] == 4
          and 29 <= (rest[0]["due"] - time.time() * 1000) / 60000 <= 30.05 and s["rest_cycles"] == 1, str(s))
    check("T2 counters retried=3 transient_errors=4 retry_requests=3 recovered=0", (s["retried"], s["transient_errors"], s["retry_requests"], s["recovered"]) == (3, 4, 3, 0), str(s))
    check("T2 mock saw page 96 exactly 4 times; other pages fetched", page_hits(96) == 4 and s["pages_done"] == 4 and page_hits(192) == 1, str(page_hits(96)))
    check("T2 page_rested event logged", row(f"SELECT COUNT(*) n FROM fetch_log WHERE kind='sweep' AND status='page_rested' AND instr(error, 'start=96 used 3 retries') = 1 AND instr(error, 'rest 1: next try in 30 min') > 0 AND id > {m0}")["n"] == 1)
    r = tick()
    check("T2 resting page not due -> 'waiting' (no run, no request)", r.get("action") == "waiting" and page_hits(96) == 4, str(r))
    check("T2 page-96 items: counts + observed_at unchanged", page96_untouched(b))
    check("T2 no out-of-stock marks (item 199 still in stock, vanish not run)", inv(199)["q"] > 0 and not inv(199)["inferred"] and s["vanished_applied"] is None, str(inv(199)))
    check("T2 freshness (last_ok_at) not advanced", last_ok() == ok0)
    check("T2 no 1 h backoff, no pause", not backoff_set())
    # response times of the failed page: fetch_log.response_ms on every failed attempt + per-page record in sweep_state / /health
    lr = d1(f"SELECT response_ms FROM fetch_log WHERE kind='sweep_page' AND query LIKE 'start=96%' AND status='http_error' AND id > {m0}")
    check("T2 fetch_log.response_ms set on all 4 failed attempts", len(lr) == 4 and all(x["response_ms"] is not None and 0 <= x["response_ms"] < 1500 for x in lr), str(lr))
    f = json.loads(s["page_failures_json"] or "{}").get("96") or {}
    check("T2 page_failures_json: fails=4 rests=1 last_status 'http_error 522', 4 response times", f.get("fails") == 4 and f.get("rests") == 1 and f.get("last_status") == "http_error 522" and len(f.get("ms", [])) == 4 and f.get("max_ms") is not None, str(f))
    h = health_sweep()
    check("T2 /health sweep shows failed_pages + pages_resting + rest_cycles + page_rest_min 30 + request_limit_per_day 40",
          any(x["start"] == 96 and x["fails"] == 4 for x in h.get("failed_pages", [])) and [x["start"] for x in h.get("pages_resting", [])] == [96]
          and h.get("rest_cycles") == 1 and h.get("retry_limits", {}).get("page_rest_min") == 30
          and h.get("retry_limits", {}).get("request_limit_per_day") == 40 and h.get("retry_limits", {}).get("max_per_page") == 3, str(h)[:600])

def t3_distinct_streak_pause():
    print("T3: 3 different pages in a row hit 5xx -> 15 min pause (was 1 h)")
    baseline(); b = snap(); mock_set(page_mode={"48": "fail:522:*", "96": "fail:503:*", "144": "fail:524:*"})
    r = tick(); s = state()
    check("T3 tick stopped after 3rd distinct page, detail says 15 min pause", r.get("action") == "stopped" and "distinct pages" in r.get("detail", "") and "15 min pause" in r.get("detail", ""), str(r))
    check("T3 backoff set to ~15 min (not 1 h)", backoff_set() and is_15min(), f"{backoff_min():.2f} min")
    check("T3 streak reset when the pause starts (retry_json streak empty)", json.loads(s["retry_json"]).get("streak") == [], str(s["retry_json"]))
    check("T3 3 pages pending, sweep still running (not complete), page 192 not fetched", s["status"] == "running" and s["retry_json"].count('"start"') == 3 and page_hits(192) == 0, str(s))
    check("T3 nothing written for the failed pages, no vanish", page96_untouched(b) and inv(199)["q"] > 0)
    check("T3 next tick blocked by backoff", tick().get("action") == "backoff")

def t4_hard_errors():
    print("T4: 429 / 501 / 403 / bad shape keep the old behavior (sweep failed at once, no retry)")
    for code, kind, backoff in (("429", None, True), ("501", None, True), ("403", None, False), (None, "badshape", False)):
        baseline(); b = snap()
        if code: mock_set(page_mode={"96": f"fail:{code}:*"})
        else: mock_set(fail_at=96, fail_kind=kind)
        label = code or kind
        r = tick(); s = state()
        check(f"T4 {label}: sweep failed immediately, no retry queued", s["status"] == "failed" and s["retried"] == 0 and '"start"' not in (s["retry_json"] or ""), f"{r} {s}")
        check(f"T4 {label}: 1 h backoff {'set' if backoff else 'not set'} (unchanged)", backoff_set() == backoff and (not backoff or is_1h()), f"{backoff_min():.2f} min")
        check(f"T4 {label}: page 96 requested once, nothing written, no vanish", page_hits(96) == 1 and page96_untouched(b) and inv(199)["q"] > 0)

def t5_retry_cap():
    print("T5: global sweep retry cap (40 requests/day; was 20 until 2026-10-29)")
    baseline(); b = snap(); mock_set(page_mode={"96": "fail:522:*"})
    tick(); d1("UPDATE sweep_state SET retry_requests = 40")
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    r = tick(); s = state()
    check("T5 cap reached -> sweep failed (retry_limit), no retry request sent", s["status"] == "failed" and "retry_limit" in (s["error"] or "") and page_hits(96) == 1, f"{r} {s}")
    check("T5 retry_limit event logged", row("SELECT COUNT(*) n FROM fetch_log WHERE kind='sweep' AND status='retry_limit'")["n"] >= 1)
    check("T5 nothing written for the failed page, no vanish", page96_untouched(b) and inv(199)["q"] > 0)
    baseline(); mock_set(page_mode={"96": "fail:522:*"})
    tick(); d1("UPDATE sweep_state SET retry_requests = 39")
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5); tick(); s = state()
    check("T5b last allowed retry is sent, then cap -> failed, retry_requests never > 40", s["status"] == "failed" and s["retry_requests"] == 40 and page_hits(96) == 2, str(s))
    # c) the old 20 cap no longer stops the sweep: with 20 already used, the next retry is still sent and the sweep keeps running
    baseline(); b = snap(); m0 = maxid(); mock_set(page_mode={"96": "fail:522:*"})
    tick(); d1("UPDATE sweep_state SET retry_requests = 20")
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5); r = tick(); s = state()
    check("T5c past the old 20 cap: retry 21 sent, sweep still running (no retry_limit), page re-queued", s["status"] == "running" and s["error"] is None and s["retry_requests"] == 21 and page_hits(96) == 2 and '"start":96' in (s["retry_json"] or "").replace(" ", ""), f"{r} {s}")
    check("T5c no retry_limit event, nothing written for the failed page, no vanish", row(f"SELECT COUNT(*) n FROM fetch_log WHERE kind='sweep' AND status='retry_limit' AND id > {m0}")["n"] == 0 and page96_untouched(b) and inv(199)["q"] > 0)

def t6_ceiling_before_retry():
    print("T6: daily request cap checked before every retry")
    baseline(); mock_set(page_mode={"96": "fail:522:1"})
    tick(); d1("UPDATE fetch_budget SET dabs_requests = 700")
    time.sleep(RETRY_DELAY_MS / 1000 + 0.5)
    r = tick(); s = state(); used = row("SELECT dabs_requests n FROM fetch_budget")["n"]
    check("T6 retry not sent at the 700 cap", r.get("action") == "budget_exhausted" and page_hits(96) == 1 and used == 700, f"{r} {used}")
    check("T6 sweep not complete; retry still pending", s["status"] == "running" and '"start":96' in (s["retry_json"] or ""), str(s))

def t7_window_end():
    print("T7: last tick of the window with pages unresolved -> failed; clean sweeps unaffected")
    start_wrangler(last_tick="1")
    baseline(); b = snap(); ok0 = last_ok(); mock_set(page_mode={"96": "fail:522:1"})
    r = tick(); s = state()
    check("T7a pending retry at the last tick -> sweep failed (window_ended), not complete", s["status"] == "failed" and "window_ended" in (s["error"] or ""), f"{r} {s}")
    check("T7a nothing partial advanced (page 96 untouched, no vanish, last_ok_at same)", page96_untouched(b) and inv(199)["q"] > 0 and last_ok() == ok0)
    baseline(); mock_set(page_mode={"48": "fail:522:*", "96": "fail:522:*", "144": "fail:522:*"})
    r = tick(); s = state()
    check("T7b streak pause on the last tick -> failed (window_ended)", r.get("action") == "stopped" and s["status"] == "failed", f"{r} {s}")
    baseline(); mock_set()
    r = tick(); s = state()
    check("T7c clean sweep on the last tick still completes", s["status"] == "complete", f"{r} {s}")
    start_wrangler(last_tick="0")

def used(): return row("SELECT dabs_requests n FROM fetch_budget")["n"]
def wait(): time.sleep(RETRY_DELAY_MS / 1000 + 0.5)

def t8_single_timeout_recovers():
    print("T8: single timeout on one page, then recovered on retry")
    baseline(); b = snap(); ok0 = last_ok(); mock_set(page_mode={"96": SLOW + ":1"})
    r = tick(); s = state()
    check("T8 timeout does not end the sweep (progress, running, page 96 queued)", r.get("action") == "progress" and s["status"] == "running" and '"start":96' in (s["retry_json"] or ""), f"{r} {s}")
    check("T8 fetch_log shows TimeoutError for start=96", row("SELECT COUNT(*) n FROM fetch_log WHERE kind='sweep_page' AND status='network_error' AND error LIKE '%TimeoutError%'")["n"] == 1)
    check("T8 timed-out attempt counted against the daily ceiling (5 requests used)", used() == 5, str(used()))
    check("T8 no backoff; fail closed meanwhile (page 96 untouched, no vanish, freshness same)", not backoff_set() and page96_untouched(b) and inv(199)["q"] > 0 and last_ok() == ok0)
    wait(); r = tick(); s = state()
    check("T8 retry succeeds -> complete, retried=1 recovered=1 retry_requests=1", s["status"] == "complete" and (s["retried"], s["recovered"], s["retry_requests"]) == (1, 1, 1), f"{r} {s}")
    check("T8 page-96 items updated and vanish applied only now", all(inv(i)["q"] == b[i]["q"] + 3 for i in range(110, 120)) and inv(199)["q"] == 0 and last_ok() != ok0)

def t9_timeout_page0_recovers():
    print("T9: timeout on page 0 (like 2026-10-25) recovers")
    baseline(); b = snap(); mock_set(page_mode={"0": SLOW + ":1"})
    r = tick(); s = state()
    check("T9 page 0 timeout -> sweep continues with page 48.., page 0 queued", s["status"] == "running" and '"start":0' in (s["retry_json"] or "") and s["pages_done"] == 4, f"{r} {s}")
    wait(); r = tick(); s = state()
    check("T9 retry of page 0 succeeds -> complete", s["status"] == "complete" and s["recovered"] == 1 and page_hits(0) == 2, f"{r} {s}")
    check("T9 data correct after recovery (+3 on page 96 items, 199 vanished)", all(inv(i)["q"] == b[i]["q"] + 3 for i in range(110, 120)) and inv(199)["q"] == 0)

def t10_mixed_streak_pause():
    print("T10: timeout + 5xx + timeout on 3 distinct pages in a row -> 15 min pause")
    baseline(); b = snap(); mock_set(page_mode={"48": SLOW + ":*", "96": "fail:522:*", "144": SLOW + ":*"})
    r = tick(); s = state()
    check("T10 stopped after the 3rd distinct page, backoff set", r.get("action") == "stopped" and "5xx/timeout" in r.get("detail", "") and backoff_set() and is_15min(), f"{r} {backoff_min():.2f} min")
    check("T10 3 pages pending, still running, page 192 not fetched, nothing written", s["status"] == "running" and s["retry_json"].count('"start"') == 3 and page_hits(192) == 0 and page96_untouched(b) and inv(199)["q"] > 0, str(s))

def t14_short_pause_then_resume():
    print("T14: after the (shortened) streak pause the queued retries run; streak restarts so it re-pauses only after 3 more")
    start_wrangler(pause_ms=4000)   # mock-only override of the 15 min pause
    # a) outage clears: the 3 paused pages recover after the pause and the sweep completes
    baseline(); b = snap(); ok0 = last_ok(); mock_set(page_mode={"48": "fail:522:1", "96": "fail:503:1", "144": SLOW + ":1"})
    r = tick()
    check("T14a tick1 paused after 3 distinct pages", r.get("action") == "stopped" and backoff_set(), str(r))
    check("T14a next tick inside the pause is blocked", tick().get("action") == "backoff")
    check("T14a fail closed during the pause (page 96 untouched, no vanish, freshness same)", page96_untouched(b) and inv(199)["q"] > 0 and last_ok() == ok0)
    time.sleep(4.5); r = tick(); s = state()
    check("T14a after the pause: retries run, page 192 fetched, sweep complete", s["status"] == "complete" and (s["retried"], s["recovered"]) == (3, 3) and page_hits(192) == 1, f"{r} {s}")
    check("T14a data correct (+3 on page 96 items, 199 vanished, freshness advanced)", all(inv(i)["q"] == b[i]["q"] + 3 for i in range(110, 120)) and inv(199)["q"] == 0 and last_ok() != ok0)
    # b) outage persists: each post-pause tick retries all 3 pages before pausing again (streak reset), and it stays bounded
    baseline(); b = snap(); ok0 = last_ok(); mock_set(page_mode={"48": "fail:522:*", "96": "fail:522:*", "144": "fail:524:*"})
    tick(); time.sleep(4.5); r = tick()
    hits = page_hits(48) + page_hits(96) + page_hits(144)
    check("T14b 2nd cycle: all 3 pages retried once before the next pause (6 hits, not 4)", r.get("action") == "stopped" and hits == 6, f"{r} hits={hits}")
    for _ in range(3):
        time.sleep(4.5); tick()
    s = state(); hits = page_hits(48) + page_hits(96) + page_hits(144)
    check("T14b bounded: after 3 retries/page all 3 pages rest (12 hits, retry_requests 9 <= 40), sweep not failed", s["status"] == "running" and s["error"] is None and hits == 12 and s["retry_requests"] == 9 and sorted(p["start"] for p in resting(s)) == [48, 96, 144] and s["rest_cycles"] == 3, f"{s} hits={hits}")
    check("T14b resting pages don't block: page 192 fetched after the last pause", page_hits(192) == 1 and s["next_start"] >= 199, f"{page_hits(192)} {s}")
    r = tick()
    check("T14b all remaining pages resting -> 'waiting', nothing sent", r.get("action") == "waiting" and page_hits(48) + page_hits(96) + page_hits(144) == 12, str(r))
    check("T14b fail closed: nothing written, no vanish, freshness not advanced", page96_untouched(b) and inv(199)["q"] > 0 and s["vanished_applied"] is None and last_ok() == ok0)
    start_wrangler(last_tick="0")

def sched(cron, hh, mm):
    """Fire the real scheduled() handler (cron allowlist + window logic) with scheduledTime = 2027-01-05 (MST) hh:mm UTC."""
    import calendar, urllib.parse
    ms = calendar.timegm((2027, 1, 5, hh, mm, 0)) * 1000   # fixed MST date (day 5): the local-time gate (2026-11-13) reads scheduledTime in America/Denver
    r = json.load(urllib.request.urlopen(BASE + "/cdn-cgi/handler/scheduled?format=json&cron=" + urllib.parse.quote(cron) + f"&time={ms}", timeout=120))
    assert r.get("outcome") == "ok", r
def runs(): return row("SELECT runs n FROM fetch_budget")["n"]
def all_hits(): return sum(json.load(urllib.request.urlopen(MOCK + "/__stats"))["page"].values())
def sched_at(cron, iso):
    """Fire scheduled() at an exact UTC instant ('2027-07-15T06:30'), for the America/Denver gate / DST tests."""
    import calendar, urllib.parse
    ms = calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M")) * 1000
    r = json.load(urllib.request.urlopen(BASE + "/cdn-cgi/handler/scheduled?format=json&cron=" + urllib.parse.quote(cron) + f"&time={ms}", timeout=120))
    assert r.get("outcome") == "ok", r

def t15_schedule_config():
    print("T15: schedule config (pinned to America/Denver 2026-11-13): sweep 00:30-03:55, per-store 04:00-10:55, catalog 11:30, catch-up 13:00-15:55 local; MST UTC ticks below")
    import re
    wj = open(os.path.join(ROOT, "wrangler.jsonc")).read(); ix = open(os.path.join(ROOT, "src/index.ts")).read()
    sw = open(os.path.join(ROOT, "src/fetchers/sweep.ts")).read(); ps = open(os.path.join(ROOT, "src/fetchers/perstore.ts")).read()
    crons = json.loads(re.search(r'"crons":\s*(\[[^\]]*\])', wj).group(1))
    want = {"30-55/5 6 * * *": "sweep", "*/5 7-10 * * *": "sweep", "*/5 10-17 * * *": "perstore", "30 17,18 2-8 * *": "catalog", "*/5 19-22 * * *": "catchup"}   # local-time pinned 2026-11-13 (t80u)
    check("T15 wrangler crons", sorted(crons) == sorted(want), str(crons))
    exp = dict(re.findall(r'^\s*"([^"]+)":\s*"(sweep|catalog|perstore|catchup)"', ix, re.M))
    check("T15 EXPECTED_CRONS matches wrangler", exp == want, str(exp))
    sc = open(os.path.join(ROOT, "src/schedule.ts")).read()
    check("T15 sweep hard stop 03:55 America/Denver (local window 00:30-03:55), pause 15 min", "sweep: { first: 30, last: 3 * 60 + 55" in sc and "SWEEP_LAST_TICK_LOCAL_MIN" in sw and "SWEEP_STREAK_PAUSE_MS = 15 * 60 * 1000" in sw)
    check("T15 per-store last tick 10:55 America/Denver (local window 04:00-10:55)", "perstore: { first: 4 * 60, last: 10 * 60 + 55" in sc and "PERSTORE_LAST_TICK_LOCAL_MIN" in ps)
    # window math: 42 sweep ticks 07:30..10:55, 84 per-store ticks 11:00..17:55, catalog 18:30; no overlap; same Utah day in MDT and MST
    sweep_t = [h * 60 + m for h in range(7, 11) for m in range(0, 60, 5) if h * 60 + m >= 450]
    ps_t = [h * 60 + m for h in range(11, 18) for m in range(0, 60, 5)]
    check("T15 42 sweep ticks, last 10:55 < first per-store 11:00; 84 per-store ticks, last 17:55 < catalog 18:30",
          len(sweep_t) == 42 and sweep_t[-1] == 655 and ps_t[0] == 660 and len(ps_t) == 84 and ps_t[-1] == 1075 < 1110)
    check("T15 whole schedule on one Utah day in MST (UTC-7) and MDT (UTC-6)", all(0 < t - off * 60 < 1440 for t in (sweep_t[0], 1110) for off in (6, 7)))
    h = json.load(urllib.request.urlopen(BASE + "/health"))
    check("T15 /health schedule lists the new crons", sorted((h.get("fetcher") or {}).get("schedule") or []) == sorted(want), str((h.get("fetcher") or {}).get("schedule")))

def t16_no_run_charge_when_idle():
    print("T16: ticks that can't send a request (retry not due / paused) charge no run; complete sweep -> no-op, no second sweep")
    baseline(); mock_set(page_mode={"96": "fail:522:1"})
    tick(); r = tick(); s = state()   # 2nd tick right away (retry due 2.5 s later); after tick 1: runs 1, requests 5 (5 pages)
    check("T16a only a not-yet-due retry left -> 'waiting', no run, no request", r.get("action") == "waiting" and runs() == 1 and used() == 5 and s["status"] == "running", f"{r} runs={runs()} used={used()}")
    r0 = 1
    wait(); r = tick()
    check("T16a due retry then runs (1 run) and completes", state()["status"] == "complete" and runs() == r0 + 1, f"{r} runs={runs()}")
    r1, u1, h1 = runs(), used(), all_hits()
    rs = [tick() for _ in range(3)]
    check("T16b complete -> later ticks noop: no run, no request, no lock", all(x.get("action") == "noop" for x in rs) and runs() == r1 and used() == u1 and all_hits() == h1 and row("SELECT COUNT(*) n FROM fetch_lock")["n"] == 0, str(rs))
    baseline(); mock_set(page_mode={"48": "fail:522:1", "96": "fail:522:1", "144": "fail:522:1"})
    tick(); r0, u0 = runs(), used()
    rs = [tick() for _ in range(2)]
    check("T16c paused (15 min) -> backoff ticks charge no run and send nothing", all(x.get("action") == "backoff" for x in rs) and runs() == r0 and used() == u0, f"{rs} runs {runs()} vs {r0}")
    d1("DELETE FROM fetch_budget")   # first tick of a new day lands in a pause: budget row is still created, nothing exhausted
    r = tick(); b = row("SELECT runs, exhausted_reason FROM fetch_budget")
    check("T16c backoff on a day with no budget row: row opened, runs 0, not exhausted", r.get("action") == "backoff" and b and b["runs"] == 0 and b["exhausted_reason"] is None, f"{r} {b}")

def t17_real_schedule():
    print("T17: real scheduled() ticks (MST date): resume across the window, hard stop at 10:55 UTC = 03:55 MST only, retired crons rejected")
    baseline(); mock_set(page_mode={"96": "fail:522:*"})
    sched("*/5 7-10 * * *", 7, 30); s = state()
    check("T17 07:30 tick runs the sweep, page 96 queued", s and s["status"] == "running" and '"start":96' in (s["retry_json"] or ""), str(s))
    wait(); sched("*/5 7-10 * * *", 9, 0); s = state()
    check("T17 09:00 tick resumes (retry 1 sent, still running)", s["status"] == "running" and s["retried"] == 1, str(s))
    sched("*/5 7-10 * * *", 10, 50); s = state()
    check("T17 10:50 tick is not the hard stop (still running)", s["status"] == "running", str(s))
    sched("*/5 7-10 * * *", 10, 55); s = state()
    check("T17 10:55 tick = hard stop -> failed window_ended, no vanish", s["status"] == "failed" and "window_ended" in (s["error"] or "") and s["vanished_applied"] is None and inv(199)["q"] > 0, str(s))
    reset_day(); start_mock(); mock_set()
    sched("*/5 9 * * *", 9, 0); sched("*/5 10-12 * * *", 10, 0); sched("30 13 2-8 * *", 13, 30); sched("30 14 2-8 * *", 14, 30)
    sched("30-55/5 7 * * *", 7, 30); sched("*/5 8-10 * * *", 9, 0); sched("*/5 11-17 * * *", 11, 0); sched("30 18 2-8 * *", 18, 30); sched("*/5 20-22 * * *", 20, 0)
    check("T17 retired crons (*/5 9, */5 10-12, 30 13 2-8, 30 14 2-8 and the pre-2026-11-13 UTC set) rejected: no sweep row, no request", row("SELECT COUNT(*) n FROM sweep_state")["n"] == 0 and all_hits() == 0)
    baseline(); mock_set()
    sched("*/5 7-10 * * *", 7, 55); s = state()
    check("T17 clean run from the :30-:55 cron completes", s["status"] == "complete", str(s))
    # unfinished sweep with no 5xx at the hard stop (here: runs cap reached) -> closed failed too, nothing sent
    from zoneinfo import ZoneInfo; import datetime
    day = datetime.datetime.now(ZoneInfo("America/Denver")).strftime("%Y-%m-%d")
    reset_day(); start_mock(); mock_set()
    d1(f"INSERT INTO sweep_state (day, status, next_start, pages_done, seen, started_at, updated_at) VALUES ('{day}', 'running', 96, 2, '', '{day}T08:00:00Z', '{day}T08:00:00Z')")
    d1("UPDATE fetch_budget SET runs = 60")
    sched("*/5 7-10 * * *", 10, 55); s = state()
    check("T17 hard stop closes an unfinished sweep without 5xx (runs cap hit) as failed, no request", s["status"] == "failed" and "window_ended" in (s["error"] or "") and all_hits() == 0, str(s))
    reset_day()

def t11_timeout_three_retries_rest():
    print("T11: page keeps timing out -> 3 retries, then the page rests (not failed), no writes; timeout response times logged")
    baseline(); b = snap(); ok0 = last_ok(); m0 = maxid(); mock_set(page_mode={"96": SLOW + ":*"})
    tick()
    for _ in range(3):
        wait(); tick()
    s = state(); rest = resting(s)
    check("T11 after 3 retries: running, page 96 resting (rest 1), no error", s["status"] == "running" and s["error"] is None and [p["start"] for p in rest] == [96] and s["rest_cycles"] == 1, str(s))
    check("T11 4 attempts, retry_requests=3, all counted in the daily budget (5 + 3 = 8)", page_hits(96) == 4 and s["retry_requests"] == 3 and used() == 8, f"{page_hits(96)} {s['retry_requests']} {used()}")
    f = json.loads(s["page_failures_json"] or "{}").get("96") or {}
    check("T11 timeout response times ~1500 ms (the request timeout) recorded, status network_error",
          f.get("fails") == 4 and f.get("last_status") == "network_error" and all(x is not None and 1400 <= x <= 2600 for x in f.get("ms", [])), str(f))
    lr = d1(f"SELECT response_ms FROM fetch_log WHERE kind='sweep_page' AND query LIKE 'start=96%' AND status='network_error' AND id > {m0}")
    check("T11 fetch_log.response_ms ~1500 on each timed-out attempt", len(lr) == 4 and all(1400 <= (x["response_ms"] or 0) <= 2600 for x in lr), str(lr))
    check("T11 no writes, no out-of-stock marks, no freshness advance, no backoff", page96_untouched(b) and inv(199)["q"] > 0 and s["vanished_applied"] is None and last_ok() == ok0 and not backoff_set())

def t12_timeout_cap():
    print("T12: timeouts share the 40-request sweep retry cap")
    baseline(); b = snap(); mock_set(page_mode={"96": SLOW + ":*"})
    tick(); d1("UPDATE sweep_state SET retry_requests = 39")
    wait(); tick(); s = state()
    check("T12 last allowed retry sent (times out), then cap -> failed, retry_requests = 40", s["status"] == "failed" and "retry_limit" in (s["error"] or "") and s["retry_requests"] == 40 and page_hits(96) == 2, str(s))
    check("T12 nothing written, no vanish", page96_untouched(b) and inv(199)["q"] > 0)

def t13_other_network_error():
    print("T13: non-timeout network error (connection dropped, no response) keeps the old behavior")
    baseline(); b = snap(); mock_set(page_mode={"96": "drop:*"})
    r = tick(); s = state()
    check("T13 sweep failed immediately, no retry queued, no backoff", s["status"] == "failed" and s["retried"] == 0 and '"start"' not in (s["retry_json"] or "") and not backoff_set(), f"{r} {s}")
    check("T13 error is network_error but not TimeoutError", "network_error" in (s["error"] or "") and "TimeoutError" not in (s["error"] or ""), str(s["error"]))
    check("T13 nothing written, no vanish", page96_untouched(b) and inv(199)["q"] > 0)

def t18_rest_nonblocking():
    print("T18: one page rests while the others continue; recovers after the (shortened) rest; persistent outage bounded by the 40 cap / hard stop")
    start_wrangler(rest_ms=60000)   # mock-only override of the 30 min page rest (60 s: longer than a slow 12-request tick)
    # a) 2000-item catalog = 42 pages, ~4 ticks of 12 requests. Page 48 fails its first try + 3 retries (one per tick), rests in tick 4
    #    while the main cursor keeps going in that same tick, then succeeds after the rest -> sweep complete.
    reset_day(); start_mock(); mock_set(changed=False, n_items=2000, page_mode={"48": "fail:522:4"})
    rs = [tick()]
    for _ in range(3):
        wait(); rs.append(tick())
    s = state(); rest = resting(s)
    check("T18a page 48 rested after 1 try + 3 retries, sweep running, no error", s["status"] == "running" and s["error"] is None and [p["start"] for p in rest] == [48] and page_hits(48) == 4 and s["rest_cycles"] == 1, f"{rs[-1]} {s}")
    rid = row("SELECT MAX(id) id FROM fetch_log WHERE kind='sweep' AND status='page_rested'")["id"]
    after = row(f"SELECT COUNT(*) n FROM fetch_log WHERE kind='sweep_page' AND status='ok' AND query NOT LIKE '%retry%' AND id > {rid}")["n"]
    check("T18a NON-BLOCKING: main pages fetched in the same tick right after the rest started (all 42 pages but 48 done)", after >= 5 and s["pages_done"] == 41 and s["next_start"] >= 2000, f"after={after} {s}")
    r = tick()
    check("T18a only the resting page left -> 'waiting' (no run charged)", r.get("action") == "waiting" and page_hits(48) == 4, str(r))
    left = (rest[0]["due"] - time.time() * 1000) / 1000 if rest else 0
    time.sleep(max(0, left) + 1); r = tick(); s = state()
    check("T18a post-rest attempt succeeds -> sweep complete; retried=4 recovered=1 retry_requests=4", s["status"] == "complete" and (s["retried"], s["recovered"], s["retry_requests"]) == (4, 1, 4) and page_hits(48) == 5, f"{r} {s}")
    lq = row("SELECT query FROM fetch_log WHERE kind='sweep_page' AND query LIKE 'start=48;retry=4%'")
    check("T18a post-rest attempt logged as start=48;retry=4;rest=1", lq and lq["query"] == "start=48;retry=4;rest=1", str(lq))
    check("T18a total requests = 42 pages + 4 retries (<= pages + 40)", all_hits() == 46 and used() == 46, f"{all_hits()} {used()}")
    # b) persistent outage on one page: rest after rest until the 40 retry requests are used -> failed (retry_limit), never more.
    #    It must keep going past the old 20 cap (rested page re-queued and retried) and only stop at 40.
    start_wrangler(rest_ms=6000)
    reset_day(); start_mock(); mock_set(page_mode={"96": "fail:522:*"})
    tick(); n = 0; past20 = None
    while state()["status"] == "running" and n < 80:
        time.sleep(6.3 if resting(state()) else RETRY_DELAY_MS / 1000 + 0.4); tick(); n += 1
        st = state()
        if past20 is None and st["retry_requests"] > 20: past20 = (st["status"], st["retry_requests"], st["rest_cycles"], len(resting(st)))
    s = state(); f = json.loads(s["page_failures_json"] or "{}").get("96") or {}
    check("T18b past the old 20 cap the sweep is still running and the page is still resting/re-queued (no retry_limit at 20)", past20 is not None and past20[0] == "running" and past20[1] == 21 and past20[2] == 19 and past20[3] == 1, str(past20))
    check("T18b persistent outage ends failed at the 40-request cap (retry_limit)", s["status"] == "failed" and "retry_limit" in (s["error"] or "") and "limit 40" in (s["error"] or "") and s["retry_requests"] == 40, str(s))
    check("T18b worst case: 1 + 40 hits on page 96, total = 5 pages + 40 retries, daily ceiling charged the same", page_hits(96) == 41 and all_hits() == 45 and used() == 45, f"{page_hits(96)} {all_hits()} {used()}")
    check("T18b 37 rest cycles, post-rest attempts never triggered a pause", s["rest_cycles"] == 37 and f.get("rests") == 37 and f.get("fails") == 41 and not backoff_set(), f"{s['rest_cycles']} {f}")
    check("T18b fail closed: no vanish, nothing marked out of stock", s["vanished_applied"] is None and inv(199)["q"] > 0)
    r = tick()
    check("T18b day stays failed (noop)", r.get("action") == "noop", str(r))
    # c) hard stop while a page rests -> failed window_ended, error names the resting page
    start_wrangler()   # default 30 min rest
    reset_day(); start_mock(); mock_set(page_mode={"96": "fail:522:*"})
    tick()
    for _ in range(3):
        wait(); tick()
    check("T18c page 96 resting before the hard stop", [p["start"] for p in resting(state())] == [96])
    sched("*/5 7-10 * * *", 10, 55); s = state()
    check("T18c 10:55 UTC hard stop -> failed window_ended, names the resting page, no vanish", s["status"] == "failed" and "window_ended" in (s["error"] or "") and "resting: start=96 x1" in (s["error"] or "") and s["vanished_applied"] is None and page_hits(96) == 4, str(s))
    reset_day(); start_wrangler()

def snapshot():
    return (row("SELECT COUNT(*) n FROM sweep_state")["n"], row("SELECT COUNT(*) n FROM perstore_state")["n"], row("SELECT COUNT(*) n FROM fetch_log")["n"],
            row("SELECT COUNT(*) n FROM fetch_budget")["n"], (row("SELECT runs FROM fetch_budget") or {}).get("runs"), row("SELECT COUNT(*) n FROM fetch_lock")["n"], all_hits())

def t19_local_time_gate():
    print("T19: America/Denver gate (2026-11-13, t80u): out-of-window ticks are pure no-ops; MDT/MST/DST-night ticks act at local times")
    reset_day(); start_mock(); mock_set()
    s0 = snapshot()
    for cron, iso, why in (("30-55/5 6 * * *", "2027-01-15T06:30", "23:30 MST"), ("*/5 7-10 * * *", "2027-01-15T07:25", "00:25 MST"),
                           ("*/5 7-10 * * *", "2027-07-15T10:00", "04:00 MDT"), ("*/5 7-10 * * *", "2027-03-14T10:00", "04:00 MDT, spring-forward day"),
                           ("*/5 10-17 * * *", "2027-01-15T10:30", "03:30 MST"), ("*/5 10-17 * * *", "2027-07-15T17:00", "11:00 MDT"),
                           ("30 17,18 2-8 * *", "2027-01-05T17:30", "10:30 MST"), ("30 17,18 2-8 * *", "2027-07-05T18:30", "12:30 MDT"),
                           ("*/5 19-22 * * *", "2027-01-15T19:55", "12:55 MST"), ("*/5 19-22 * * *", "2027-07-15T22:00", "16:00 MDT")):
        sched_at(cron, iso)
        s1 = snapshot()
        check(f"T19 {cron} at {iso} UTC ({why}) = no-op: no row, no log, no budget/run, no lock, no request", s1 == s0, f"{s0} -> {s1}")
    sched_at("30-55/5 6 * * *", "2027-07-15T06:30"); s = state()
    check("T19 Jul 15 06:30 UTC (00:30 MDT) runs the sweep", s is not None and s["status"] in ("running", "complete") and all_hits() > 0, str(s))
    baseline(); mock_set(page_mode={"96": "fail:522:*"})
    sched_at("*/5 7-10 * * *", "2027-03-14T07:30"); s = state()
    check("T19 Mar 14 2027 07:30 UTC (00:30 MST) runs, page 96 queued", s["status"] == "running" and '"start":96' in (s["retry_json"] or ""), str(s))
    sched_at("*/5 7-10 * * *", "2027-03-14T09:50"); s = state()
    check("T19 Mar 14 09:50 UTC (03:50 MDT) is not the hard stop", s["status"] == "running", str(s))
    sched_at("*/5 7-10 * * *", "2027-03-14T09:55"); s = state()
    check("T19 Mar 14 09:55 UTC (03:55 MDT) = hard stop -> failed window_ended", s["status"] == "failed" and "window_ended" in (s["error"] or ""), str(s))
    baseline(); mock_set(page_mode={"96": "fail:522:*"})
    sched_at("*/5 7-10 * * *", "2027-11-07T07:30"); s1 = state()   # 01:30 MDT
    r1 = runs()
    wait(); sched_at("*/5 7-10 * * *", "2027-11-07T08:30"); s2 = state()   # 01:30 MST (repeated hour)
    check("T19 Nov 7 2027 repeated 01:30 (MDT then MST): same row continues (retry 1 sent), not restarted, 1 run",
          s1["status"] == "running" and s2["status"] == "running" and s2["retried"] == 1 and s2["pages_done"] == s1["pages_done"] and runs() == r1 + 1 and row("SELECT COUNT(*) n FROM sweep_state")["n"] == 1, f"{s1} {s2} runs={runs()}")
    sched_at("*/5 7-10 * * *", "2027-11-07T09:55"); s = state()   # 02:55 MST
    check("T19 Nov 7 09:55 UTC (02:55 MST) is not the hard stop", s["status"] == "running", str(s))
    sched_at("*/5 7-10 * * *", "2027-11-07T10:55"); s = state()   # 03:55 MST
    check("T19 Nov 7 10:55 UTC (03:55 MST) = hard stop -> failed window_ended", s["status"] == "failed" and "window_ended" in (s["error"] or ""), str(s))
    reset_day()

if __name__ == "__main__":
    try:
        setup()
        only = sys.argv[1:]   # optional: run only the named tests, e.g. t18_rest_nonblocking (setup always runs)
        for f in (t1_single_522_recovers, t2_three_retries_then_rest, t3_distinct_streak_pause, t4_hard_errors, t5_retry_cap, t6_ceiling_before_retry, t7_window_end,
                  t8_single_timeout_recovers, t9_timeout_page0_recovers, t10_mixed_streak_pause, t11_timeout_three_retries_rest, t12_timeout_cap, t13_other_network_error,
                  t14_short_pause_then_resume, t15_schedule_config, t16_no_run_charge_when_idle, t17_real_schedule, t18_rest_nonblocking, t19_local_time_gate):
            if not only or f.__name__ in only: f()
    finally:
        cleanup()
    print(f"\n{passes} passed, {len(fails)} failed" + (": " + "; ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)
