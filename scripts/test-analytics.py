#!/usr/bin/env python3
"""Local test for anonymous visit counting (src/analytics.ts). ZERO real DABS or Cloudflare API calls: `wrangler dev --local`
(port 8788) with a throwaway persist dir (/tmp/ur-analytics-test), a one-product / one-store fixture and
ANALYTICS_TEST_LOG=1, which (only while .dev.vars points DABS_BASE_URL at the local mock) makes the Worker console.log every
Analytics Engine data point as "[ae-test] {...}". The admin token is read from .dev.vars into memory only and never printed.

Checks: gate_pass on a successful gate POST (not on under-21); one `visit` per gated HTML GET, including Cache API HITs;
category + SKU; nothing for public pages, /api/, HEAD, redirects/404s or ungated requests; the data point never contains the
IP, User-Agent, birthdate or cookie; the id is 16 hex and differs per UA; no D1 writes; the only new KV keys are today's and tomorrow's salt;
/internal/stats is 404 without the token. Run (Node 22 on PATH):  python3 scripts/test-analytics.py"""
import json, os, re, shutil, subprocess, sys, time, urllib.request, urllib.error, urllib.parse, datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERSIST = "/tmp/ur-analytics-test"
LOG = "/tmp/ur-analytics-test.log"
BASE = "http://127.0.0.1:8788"
NPX = ["npx", "wrangler"]
UA1 = "UR-Analytics-Test-UA/9.9 (zqxwv-unique-1)"
UA2 = "UR-Analytics-Test-UA/9.9 (zqxwv-unique-2)"
IP = "203.0.113.77"
BIRTH = ("1980", "03", "14")
fails, passes = [], 0

def env_val(k):
    for line in open(os.path.join(ROOT, ".dev.vars")):
        if line.startswith(k + "="): return line.strip().split("=", 1)[1]
    raise SystemExit(f"{k} missing in .dev.vars")
TOKEN = env_val("ADMIN_TOKEN")
assert env_val("DABS_BASE_URL").startswith("http://127.0.0.1:9911"), "refusing to run: .dev.vars does not point at the local mock"

def sh(args, **kw): return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, **kw)
def d1(sql):
    r = sh(NPX + ["d1", "execute", "utah-remedy-db", "--local", "--persist-to", PERSIST, "--json", "--command", sql])
    out = json.loads(r.stdout); return out[0]["results"] if out else []
def kv_keys():
    r = sh(NPX + ["kv", "key", "list", "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST])
    return {k["name"] for k in json.loads(r.stdout)}
def kv_get(k):
    return sh(NPX + ["kv", "key", "get", k, "--binding", "UTAH_REMEDY_CACHE", "--local", "--persist-to", PERSIST, "--text"]).stdout.strip()
def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  PASS {name}")
    else: fails.append(name); print(f"  FAIL {name} {detail}")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def req(path, method="GET", ua=UA1, cookie=None, data=None, headers=None):
    h = {"User-Agent": ua, "CF-Connecting-IP": IP, **(headers or {})}
    if cookie: h["Cookie"] = cookie
    r = urllib.request.Request(BASE + path, method=method, headers=h, data=data)
    try: resp = opener.open(r, timeout=20)
    except urllib.error.HTTPError as e: resp = e
    return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")

def points():
    out = []
    for line in open(LOG, errors="replace"):
        m = re.search(r"\[ae-test\] (\{.*\})", line)
        if m: out.append(json.loads(m.group(1)))
    return out

def table_counts():
    tabs = [r["name"] for r in d1("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'")]
    return {t: d1(f"SELECT count(*) AS n FROM \"{t}\"")[0]["n"] for t in tabs}

def main():
    shutil.rmtree(PERSIST, ignore_errors=True)
    r = sh(NPX + ["d1", "migrations", "apply", "utah-remedy-db", "--local", "--persist-to", PERSIST]); assert r.returncode == 0, r.stderr[-500:]
    d1("INSERT INTO products (sku, name, category) VALUES ('012345','TEST BOURBON SMALL BATCH','WHISKEY - BOURBON & TENNESSEE')")
    d1("INSERT INTO stores (id, name, city) VALUES ('0001','STORE 1 TEST','SALT LAKE CITY')")
    sku, store = "012345", "0001"
    logf = open(LOG, "w")
    p = subprocess.Popen(NPX + ["dev", "--port", "8788", "--persist-to", PERSIST, "--var", "ANALYTICS_TEST_LOG:1"], cwd=ROOT,
                         stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        for _ in range(90):
            try: urllib.request.urlopen(BASE + "/health", timeout=3); break
            except Exception: time.sleep(1)
        else: raise SystemExit("wrangler dev did not start")
        before_d1, before_kv = table_counts(), kv_keys()

        print("gate")
        form = urllib.parse.urlencode({"year": BIRTH[0], "month": BIRTH[1], "day": BIRTH[2], "affirm": "yes", "next": f"/product/{sku}"}).encode()
        st, h, _ = req("/gate", "POST", data=form, headers={"Content-Type": "application/x-www-form-urlencoded"})
        check("gate POST 303 + age cookie", st == 303 and "ur_age21=1" in h.get("Set-Cookie", ""), f"{st} {h.get('Set-Cookie')}")
        young = urllib.parse.urlencode({"year": str(datetime.date.today().year - 10), "month": "01", "day": "01", "affirm": "yes"}).encode()
        st, _, _ = req("/gate", "POST", ua=UA2, data=young, headers={"Content-Type": "application/x-www-form-urlencoded"})
        check("under-21 POST still blocked", st == 303)
        C = "ur_age21=1"
        print("pages")
        st1, h1, _ = req(f"/product/{sku}", cookie=C)
        st2, h2, _ = req(f"/product/{sku}", cookie=C)
        check("product 200 MISS then HIT", st1 == 200 and st2 == 200 and h1.get("X-UR-Cache") == "MISS" and h2.get("X-UR-Cache") == "HIT", f"{st1} {h1.get('X-UR-Cache')} {st2} {h2.get('X-UR-Cache')}")
        check("search 200", req("/search?q=bourbon", cookie=C)[0] == 200)
        check("stores 200", req("/stores", cookie=C)[0] == 200)
        check("store page 200", req(f"/stores/{store}", cookie=C)[0] == 200)
        check("home 200", req("/", cookie=C)[0] == 200)
        check("product other UA 200", req(f"/product/{sku}", ua=UA2, cookie=C)[0] == 200)
        # Not counted:
        check("ungated product -> 302", req(f"/product/{sku}")[0] == 302)
        req("/terms", cookie=C); req("/privacy", cookie=C); req("/gate", cookie=C); req("/assets/style.css", cookie=C)
        req(f"/api/product/{sku}", cookie=C); req(f"/product/{sku}", "HEAD", cookie=C); req("/product/999999", cookie=C)
        req("/no-such-page", cookie=C); req("/health")
        check("/internal/stats 404 without token", req("/internal/stats")[0] == 404)
        check("/internal/stats 404 wrong token", req("/internal/stats", headers={"Authorization": "Bearer " + "x" * 40})[0] == 404)
        st, _, body = req("/internal/stats", headers={"Authorization": f"Bearer {TOKEN}"})
        check("/internal/stats with token reaches handler (503: no CF_ANALYTICS_TOKEN locally)", st == 503 and "CF_ANALYTICS_TOKEN" in body, f"{st}")
        time.sleep(3)

        pts = points()
        gates = [x for x in pts if x["blobs"][0] == "gate_pass"]
        visits = [x for x in pts if x["blobs"][0] == "visit"]
        check("exactly 1 gate_pass", len(gates) == 1, str(len(gates)))
        cats = sorted((x["blobs"][1], x["blobs"][2]) for x in visits)
        exp = sorted([("product", sku)] * 3 + [("search", ""), ("store", ""), ("store", ""), ("home", "")])
        check("visits = 3 product (incl. HIT) + search + 2 store + home, nothing else", cats == exp, f"{cats} vs {exp}")
        today = datetime.datetime.now(ZoneInfo("America/Denver")).strftime("%Y-%m-%d")
        check("blob4 = Utah day", all(x["blobs"][3] == today for x in pts))
        check("shape: 1 index, 4 blobs, doubles [1]", all(len(x["indexes"]) == 1 and len(x["blobs"]) == 4 and x["doubles"] == [1] for x in pts))
        ids = {x["indexes"][0] for x in pts}
        check("ids are 16 hex", all(re.fullmatch(r"[0-9a-f]{16}", i) for i in ids))
        check("2 distinct ids (UA1, UA2)", len(ids) == 2, str(len(ids)))
        ua1_ids = {x["indexes"][0] for x in pts if x["blobs"][1] != "product"} | {gates[0]["indexes"][0]} if gates else set()
        check("same visitor -> same id across gate + pages", len(ua1_ids) == 1)
        blob = json.dumps(pts)
        bad = [s for s in [UA1, UA2, "zqxwv", IP, "127.0.0.1", BIRTH[0], f"{BIRTH[0]}-{BIRTH[1]}", "ur_age21", "ur_under21", TOKEN] if s in blob]
        check("no IP / UA / birthdate / cookie in data points", not bad, str(len(bad)))

        after_d1, after_kv = table_counts(), kv_keys()
        check("no D1 writes", before_d1 == after_d1, str({k: (before_d1.get(k), v) for k, v in after_d1.items() if before_d1.get(k) != v}))
        new = after_kv - before_kv
        salt_keys = [k for k in after_kv if k.startswith("analytics:")]
        tomorrow = (datetime.datetime.now(ZoneInfo("America/Denver")) + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        check("salt keys = today + pre-created tomorrow only", sorted(salt_keys) == sorted([f"analytics:v1:salt:{today}", f"analytics:v1:salt:{tomorrow}"]), str(salt_keys))
        check("no other new analytics-related KV keys", all(not k.startswith("analytics:") or k in salt_keys for k in new), str(new))
        salts = [kv_get(k) for k in salt_keys]
        check("salts are 32 random bytes (64 hex) and differ", all(re.fullmatch(r"[0-9a-f]{64}", x) for x in salts) and len(set(salts)) == len(salts))
        vals = "".join(kv_get(k) for k in new)
        check("no IP / UA in any new KV value", not any(s in vals for s in [UA1, UA2, IP]))
        errs = [l for l in open(LOG, errors="replace") if "[analytics] dropped" in l]
        check("no dropped analytics events", not errs, errs[:1])
    finally:
        os.killpg(p.pid, 15); p.wait(); logf.close()
    print(f"\n{passes} passed, {len(fails)} failed" + (f": {fails}" if fails else ""))
    sys.exit(1 if fails else 0)

main()
