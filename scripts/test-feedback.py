#!/usr/bin/env python3
"""Local tests for the feedback form, bot endpoints, admin page and Tip-the-dev links/page (src/feedback.ts, src/tip.ts; 2026-11-12, extended 2026-11-16).
ZERO real DABS, Turnstile or email traffic: `wrangler dev --local` (port 8788) with a throwaway persist dir (/tmp/ur-feedback-test),
a local mock Turnstile siteverify (port 9912) and a throwaway bot token generated in memory and written only to a chmod-600 temp
env file (/tmp/ur-feedback-test.env, deleted afterwards). Mail goes to the local send_email simulator (nothing leaves the box).
Run (Node 22 on PATH):  python3 scripts/test-feedback.py [phase ...]     phases: a (default all), b, c
  a: tip link on (home + product), footer link everywhere, gate bypass for /feedback, spam layers in order, storage, notice,
     analytics untouched, bot auth, list/status/reply (+ idempotent), test-send (NOTIFY_TO only), admin page
  b: tip link off, email failure path (reply not marked, lock released, notice failure logged, test-send 502), quota reserve, caps
  c: intake not configured (no Turnstile) -> form renders, POST 503, nothing stored; /__ur 404 without the bot secret
  Owner admin password (ADMIN_OWNER_PASSWORD, t84u): a opens GET /__ur/admin only, refused on every API/POST endpoint;
     b unset / too short -> disabled; c no bot secret -> still 404 even with an owner password"""
import json, os, re, secrets, shutil, subprocess, sys, threading, time, urllib.request, urllib.error, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERSIST = "/tmp/ur-feedback-test"
ENVF = "/tmp/ur-feedback-test.env"
LOG = "/tmp/ur-feedback-test.log"
BASE = "http://127.0.0.1:8788"
NPX = ["npx", "wrangler"]
TOKEN = secrets.token_urlsafe(32)
OWNER_PW = secrets.token_urlsafe(18)   # throwaway owner admin password (in memory + chmod-600 temp env file only)
fails, passes = [], 0
TS_MODE = {"mode": "ok"}   # ok | down

class TS(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        q = urllib.parse.parse_qs(self.rfile.read(n).decode())
        if TS_MODE["mode"] == "down":
            self.send_response(500); self.end_headers(); return
        ok = q.get("response", [""])[0] == "pass-token" and q.get("secret", [""])[0] == "test-turnstile-secret"
        b = json.dumps({"success": ok}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  PASS {name}")
    else: fails.append(name); print(f"  FAIL {name} {detail}")

def sh(args, **kw): return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, **kw)
def d1(sql):
    r = sh(NPX + ["d1", "execute", "utah-remedy-db", "--local", "--persist-to", PERSIST, "--json", "--command", sql])
    try: out = json.loads(r.stdout)
    except ValueError: raise SystemExit(f"d1 failed: {r.stdout[-300:]} {r.stderr[-300:]}")
    return out[0]["results"] if out else []

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def req(path, method="GET", cookie=None, data=None, headers=None, ip="198.51.100.7"):
    h = {"User-Agent": "UR-Feedback-Test/1.0", "X-UR-Test-IP": ip, **(headers or {})}
    if cookie: h["Cookie"] = cookie
    r = urllib.request.Request(BASE + path, method=method, headers=h, data=data)
    try: resp = opener.open(r, timeout=30)
    except urllib.error.HTTPError as e: resp = e
    return resp.status, resp.headers, resp.read().decode("utf-8", "replace")
def bot(path, method="GET", body=None, token=TOKEN):
    h = {"Content-Type": "application/json"}
    if token is not None: h["X-UR-Feedback-Token"] = token
    st, hd, b = req(path, method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try: return st, json.loads(b)
    except ValueError: return st, {"_raw": b[:200]}

def get_form(cookie=None, ip="198.51.100.7"):
    st, h, body = req("/feedback", cookie=cookie, ip=ip)
    sc = h.get("Set-Cookie") or ""
    m = re.search(r"(__Host-ur_fb_csrf=[A-Za-z0-9_-]{22})", sc)
    ck = m.group(1) if m else cookie
    csrf = re.search(r'name="csrf" value="([^"]*)"', body); ft = re.search(r'name="ft" value="([^"]*)"', body)
    return st, h, body, ck, (csrf.group(1) if csrf else ""), (ft.group(1) if ft else "")

def submit(fields, wait=3.2, ip="198.51.100.7", ts="pass-token", tamper=None):
    st, h, body, ck, csrf, ft = get_form(ip=ip)
    time.sleep(wait)
    f = {"csrf": csrf, "ft": ft, "cf-turnstile-response": ts, "website": "", "category": "Other", "message": "hello", "city": "", "link": "", "email": ""}
    f.update(fields)
    if tamper: tamper(f)
    return req("/feedback", "POST", cookie=ck, ip=ip, data=urllib.parse.urlencode(f).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"})


THANKS = "Thanks for the feedback"
NOTICE_SNIP = "Counts come from public DABS data, can lag, and aren&rsquo;t guaranteed"
NOTICE_OPEN = "Independent service, not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services (DABS)."

def check_page_notice(label, body, has_tip=False, has_top_tip_link=False, has_disclaimer_nav=True):
    """Footer DABS notice is present once, after the heading, before the tip section (t92u)."""
    i_notice = body.find('class="page-notice"')
    i_snip = body.find(NOTICE_SNIP)
    i_open = body.find(NOTICE_OPEN)
    i_h1 = body.find("<h1")
    i_main_end = body.rfind("</main>")
    i_header_end = body.find("</header>")
    i_tip = body.find("tip-footer")
    check(f"{label}: footer DABS notice present once with unchanged wording",
          body.count(NOTICE_SNIP) == 1 and body.count('class="page-notice"') == 1 and i_notice != -1 and i_snip != -1 and i_open != -1,
          f"snip_count={body.count(NOTICE_SNIP)} notice_pos={i_notice}")
    check(f"{label}: notice at bottom of main, after header and heading (not at the top)",
          i_header_end != -1 and i_h1 != -1 and i_main_end != -1 and i_notice > i_header_end and i_notice > i_h1 and i_notice < i_main_end,
          f"header={i_header_end} h1={i_h1} notice={i_notice} main_end={i_main_end}")
    check(f"{label}: notice wording is inside page-notice",
          i_open > i_notice and i_snip > i_notice and i_open < i_main_end)
    if has_tip:
        check(f"{label}: notice appears before the tip section, tip stays last in main",
              i_tip != -1 and i_notice < i_tip < i_main_end and i_tip < body.find("site-footer"),
              f"notice={i_notice} tip={i_tip} main_end={i_main_end}")
    else:
        check(f"{label}: no tip section; notice still at bottom of main",
              i_tip == -1 and i_notice < i_main_end)
    if has_disclaimer_nav:
        i_disc = body.find('href="/disclaimer">Disclaimer</a>')
        check(f"{label}: top Disclaimer link stays in the header, above the footer notice",
              i_disc != -1 and i_disc < i_header_end < i_notice, f"disc={i_disc} header_end={i_header_end}")
    if has_top_tip_link:
        i_toplink = body.find('href="/tip">Tip the dev</a>')
        check(f"{label}: top Tip the dev link stays in the header, above the footer notice",
              i_toplink != -1 and i_toplink < i_header_end < i_notice, f"tip_link={i_toplink}")

def n_feedback(): return d1("SELECT COUNT(*) AS n FROM feedback")[0]["n"]
def n_spam(reason=None):
    return d1(f"SELECT COUNT(*) AS n FROM feedback_spam{' WHERE reason=' + repr(reason) if reason else ''}")[0]["n"]
def clear_hits(): d1("DELETE FROM feedback_hits")

wr = None
def start(extra_env, extra_args=()):
    global wr
    stop()
    with open(ENVF, "w") as fh: pass
    os.chmod(ENVF, 0o600)
    base = {"DABS_BASE_URL": "http://127.0.0.1:9911/dyn", "FETCHER_ENABLED": "false", "FEEDBACK_TEST_TURNSTILE_URL": "http://127.0.0.1:9912/siteverify"}
    base.update(extra_env)
    with open(ENVF, "w") as fh:
        for k, v in base.items():
            if v is not None: fh.write(f"{k}='{v}'\n")   # single quotes: no dotenv $-expansion
    logf = open(LOG, "a")
    wr = subprocess.Popen(NPX + ["dev", "--port", "8788", "--persist-to", PERSIST, "--env-file", ENVF, *extra_args], cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(90):
        try: urllib.request.urlopen(BASE + "/health", timeout=3); return
        except Exception: time.sleep(1)
    raise SystemExit("wrangler dev did not start")
def stop():
    global wr
    if wr and wr.poll() is None:
        os.killpg(wr.pid, 15)
        try: wr.wait(10)
        except Exception: os.killpg(wr.pid, 9)
    wr = None
    time.sleep(0.5)

FULL = {"TURNSTILE_SITE_KEY": "1x00000000000000000000AA", "TURNSTILE_SECRET": "test-turnstile-secret", "UR_FEEDBACK_BOT_TOKEN": TOKEN, "NOTIFY_TO": "owner@example.com"}

def phase_a():
    print("phase a: configured (Turnstile + bot secret + tip handle)")
    # Handle passed with --var (dotenv files expand "$"); a leading "$" must be accepted and stripped.
    start({**FULL, "ANALYTICS_TEST_LOG": "1", "ADMIN_OWNER_PASSWORD": OWNER_PW, "VENMO_HANDLE": "Quazar16"}, ("--var", "CASHAPP_HANDLE:$UtahRemedyTest"))
    C = "ur_age21=1"
    st, h, body = req("/", cookie=C)
    check("home: tip link to cash.app/$UtahRemedyTest", st == 200 and 'href="https://cash.app/$UtahRemedyTest"' in body and "Tip the dev" in body, str(st))
    check("home: Venmo profile link", 'href="https://www.venmo.com/u/Quazar16"' in body)
    check("home: tip link rel noopener + new tab", 'target="_blank" rel="noopener noreferrer external"' in body)
    check("home: tip section at bottom of main, after hero", "tip-footer" in body and body.find("tip-footer") > body.find("class=\"hero\"") > 0 and body.find("tip-footer") < body.find("site-footer"), str(body.find("tip-footer")))
    check("home: tip not inside hero", "tip-home" not in body and body.find("tip-footer") > body.find("</div></div>") )
    check("home: header Tip the dev link to /tip", 'href="/tip">Tip the dev</a>' in body and body.find('href="/tip">Tip the dev</a>') < body.find("tip-footer"))
    check("home: compact QR codes labeled Cash App and Venmo", 'aria-label="QR code for Cash App $UtahRemedyTest"' in body and 'aria-label="QR code for Venmo @Quazar16"' in body and "data-qr=\"https://cash.app/$UtahRemedyTest?qr=1\"" in body and "data-qr=\"https://www.paypal.com/qrcodes/venmocs/" in body)
    check("home: footer Feedback link", 'href="/feedback">Feedback</a>' in body)
    check("home: DABS disclaimer still injected", "not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services" in body)
    st, h, body = req("/product/012345", cookie=C)
    check("product page 200 with tip + footer link", st == 200 and "tip-footer" in body and 'href="/feedback">Feedback</a>' in body and 'href="/tip">Tip the dev</a>' in body, str(st))
    st, h, body2 = req("/product/012345", cookie=C)
    check("product cache HIT still gets tip (injected after cache)", h.get("X-UR-Cache") == "HIT" and "tip-footer" in body2 and 'href="https://www.venmo.com/u/Quazar16"' in body2, str(h.get("X-UR-Cache")))
    check("product page still gated", req("/product/012345")[0] == 302)
    st, _, body = req("/search?q=bourbon", cookie=C)
    check("search page: footer link and bottom tip", st == 200 and "/feedback" in body and "tip-footer" in body and 'href="/tip">Tip the dev</a>' in body)
    st, _, body = req("/stores", cookie=C)
    check("stores page: bottom tip", st == 200 and "tip-footer" in body, str(st))
    st, _, body = req("/terms")
    check("terms: footer link and bottom tip", st == 200 and 'href="/feedback"' in body and "cash.app" in body and "tip-footer" in body)
    st, _, body = req("/privacy")
    check("privacy: bottom tip + tips section", st == 200 and "tip-footer" in body and "no payment details" in body.lower())
    st, _, body = req("/gate")
    check("gate: footer link, no tip section or /tip nav", st == 200 and 'href="/feedback"' in body and "tip-footer" not in body and 'href="/tip"' not in body and "cash.app" not in body)
    st, _, body = req("/product/999999", cookie=C)
    check("product 404: no tip", st == 404 and "cash.app" not in body and "tip-footer" not in body, str(st))

    print(" /tip page")
    st, h, body = req("/tip")
    loc = (h.get("Location") or "")
    check("/tip is age-gated", st == 302 and "/gate" in loc and "next=%2Ftip" in loc, f"{st} {loc}")
    st, h, body = req("/tip", cookie=C)
    check("/tip 200 after age gate", st == 200, str(st))
    check("/tip title and meta description", "<title>Tip the dev — Utah Remedy</title>" in body and "Optional tips help cover the cost of running Utah Remedy" in body)
    check("/tip polite wording", "free tool I built independently" in body and "entirely optional" in body and "help cover hosting and data costs" in body and "There are no perks" in body and "nothing on the site changes" in body)
    check("/tip no urgency or feature promises", "limited time" not in body.lower() and "act now" not in body.lower() and "coming soon" not in body.lower() and "new feature" not in body.lower())
    check("/tip not affiliated with DABS", "not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services" in body)
    check("/tip Cash App + Venmo links and large QRs", 'href="https://cash.app/$UtahRemedyTest"' in body and 'href="https://www.venmo.com/u/Quazar16"' in body and "tip-method-cashapp" in body and "tip-method-venmo" in body and 'aria-label="QR code for Cash App $UtahRemedyTest"' in body and 'data-qr="https://cash.app/$UtahRemedyTest?qr=1"' in body and "https://www.paypal.com/qrcodes/venmocs/51db6324-8b39-48c1-b215-9ad07680ee72?created=1794872698" in body)
    check("/tip has header link, no compact bottom duplicate", 'href="/tip">Tip the dev</a>' in body and "tip-footer" not in body)
    check("/tip CSP unchanged (script-src 'none')", "script-src 'none'" in (h.get("Content-Security-Policy") or ""))

    print(" form")
    st, h, body, ck, csrf, ft = get_form()
    check("GET /feedback 200 without age cookie", st == 200, str(st))
    check("form fields", all(x in body for x in ['name="category"', 'name="message"', 'name="city"', 'name="link"', 'name="email"', 'name="website"', 'maxlength="2000"']))
    check("all 5 categories", all(f">{c}<" in body for c in ["Irrelevant alert", "Missed alert", "Suggest a source", "Bug", "Other"]))
    check("Turnstile widget + script", 'class="cf-turnstile' in body and "challenges.cloudflare.com/turnstile/v0/api.js" in body)
    check("CSP allows Turnstile only on /feedback", "script-src https://challenges.cloudflare.com" in (h.get("Content-Security-Policy") or ""))
    check("home CSP unchanged (script-src 'none')", "script-src 'none'" in (req("/", cookie=C)[1].get("Content-Security-Policy") or ""))
    check("CSRF cookie __Host-, HttpOnly, SameSite=Strict", ck and "HttpOnly" in (h.get("Set-Cookie") or "") and "SameSite=Strict" in (h.get("Set-Cookie") or ""))
    check("footer link + disclaimer on /feedback", 'href="/feedback">Feedback</a>' in body and "ur-disclaimer" in body)

    print(" footer DABS notice (moved off the top, t92u)")
    st, _, home = req("/", cookie=C)
    check_page_notice("home", home, has_tip=True, has_top_tip_link=True)
    st, _, prod = req("/product/012345", cookie=C)
    check_page_notice("product", prod, has_tip=True, has_top_tip_link=True)
    # On catalog pages the notice must not sit under the heading the way it used to.
    check("product: notice is not immediately under the heading",
          prod.find("</h1>") != -1 and prod.find("class=\"page-notice\"") - prod.find("</h1>") > 200,
          str(prod.find("class=\"page-notice\"") - prod.find("</h1>")))
    st, _, search = req("/search?q=bourbon", cookie=C)
    check_page_notice("search", search, has_tip=True, has_top_tip_link=True)
    check("search: notice is not immediately under the heading",
          search.find("Find a bottle.") != -1 and search.find("class=\"page-notice\"") > search.find('class="search"') > search.find("</h1>"))
    st, _, stores = req("/stores", cookie=C)
    check_page_notice("stores", stores, has_tip=True, has_top_tip_link=True)
    st, _, store = req("/stores/0001", cookie=C)
    check("store page 200", st == 200, str(st))
    check_page_notice("store", store, has_tip=True, has_top_tip_link=True)
    st, _, terms = req("/terms")
    check_page_notice("terms", terms, has_tip=True, has_top_tip_link=True)
    st, _, privacy = req("/privacy")
    check_page_notice("privacy", privacy, has_tip=True, has_top_tip_link=True)
    st, _, disc = req("/disclaimer")
    check_page_notice("disclaimer", disc, has_tip=True, has_top_tip_link=True)
    check("disclaimer page body is still intact", "<h1>Disclaimer</h1>" in disc and "independent service of Quazar16 LLC" in disc)
    st, _, tip = req("/tip", cookie=C)
    check_page_notice("/tip", tip, has_tip=False, has_top_tip_link=True)
    st, _, fb = req("/feedback")
    check_page_notice("/feedback", fb, has_tip=True, has_top_tip_link=True)
    st, _, gate = req("/gate")
    check_page_notice("gate", gate, has_tip=False, has_top_tip_link=False, has_disclaimer_nav=False)
    st, _, missing = req("/product/999999", cookie=C)
    check_page_notice("product 404", missing, has_tip=False, has_top_tip_link=False)
    st, _, ne = req("/not-eligible")
    check_page_notice("not-eligible", ne, has_tip=False, has_top_tip_link=False, has_disclaimer_nav=False)


    print(" spam layers")
    n0 = n_feedback()
    st, _, b = submit({}, tamper=lambda f: f.update(csrf="x" * 22))
    check("1 CSRF mismatch -> form error 400, not stored", st == 400 and "Form expired" in b and n_feedback() == n0, str(st))
    st, _, b = submit({}, ts="bad-token")
    check("2 Turnstile fail -> error 400, not stored, sampled", st == 400 and "verify you are human" in b and n_feedback() == n0 and n_spam("turnstile") == 1, str(st))
    TS_MODE["mode"] = "down"
    st, _, b = submit({})
    TS_MODE["mode"] = "ok"
    check("2b Turnstile unreachable -> 503 (fails closed), not stored", st == 503 and n_feedback() == n0, str(st))
    st, _, b = submit({"website": "http://spam.example"})
    check("3 honeypot -> quiet Thanks, not stored, sampled", st == 200 and THANKS in b and n_feedback() == n0 and n_spam("honeypot") == 1)
    check("thanks page: 'Utah Remedy Home' link, no 'Back to Utah Remedy' (t101u)", 'href="/">Utah Remedy Home</a>' in b and "Back to Utah Remedy" not in b)
    st, _, b = submit({}, tamper=lambda f: f.update(ft=""))
    check("4a missing token -> quiet Thanks, not stored", st == 200 and THANKS in b and n_feedback() == n0 and n_spam("no_token") == 1)
    st, _, b = submit({}, tamper=lambda f: f.update(ft=f["ft"][:-3] + "AAA"))
    check("4b forged token -> quiet Thanks, not stored", st == 200 and THANKS in b and n_spam("no_token") == 2)
    st, _, b = submit({}, wait=0.2)
    check("4c too fast (<3 s) -> quiet Thanks, not stored", st == 200 and THANKS in b and n_feedback() == n0 and n_spam("too_fast") == 1)
    clear_hits()
    st, _, b = submit({"message": "Great SEO services, click here http://a.example"})
    check("6 spam phrase + link -> quiet Thanks, not stored", st == 200 and THANKS in b and n_feedback() == n0 and n_spam("spam_phrase") == 1)
    st, _, b = submit({"message": "see http://a.example and http://b.example"})
    check("6 two outside links -> quiet Thanks, not stored", st == 200 and n_spam("many_links") == 1 and n_feedback() == n0)
    st, _, b = submit({"message": "Product page https://utahremedy.com/product/012345 and DABS https://abs.utah.gov/x look off"})
    check("own/DABS links are not outside links -> stored", st == 200 and THANKS in b and n_feedback() == n0 + 1)
    clear_hits()
    for i in range(5): submit({"message": f"rate test {i}"}, wait=3.05, ip="203.0.113.9")
    st, _, b = submit({"message": "rate test 6"}, wait=3.05, ip="203.0.113.9")
    check("5 sixth from one IP in an hour -> 429, not stored", st == 429 and "Too many messages" in b and n_feedback() == n0 + 6, f"{st} {n_feedback()}")
    hashes = d1("SELECT DISTINCT ip_hash FROM feedback_hits")
    check("IPs stored only as salted hashes", all(re.fullmatch(r"[0-9a-f]{32}", r["ip_hash"]) for r in hashes) and not d1("SELECT 1 FROM feedback_hits WHERE ip_hash LIKE '%203.0%'"))
    snip = d1("SELECT ip_hash FROM feedback_spam LIMIT 1")
    check("spam sample stores hash, not IP", snip and "." not in snip[0]["ip_hash"])
    clear_hits()
    st, _, b = submit({"category": "Nope"})
    check("validation: bad category -> 400", st == 400 and "Pick a category" in b)
    st, _, b = submit({"message": "x" * 2001})
    check("validation: >2000 chars -> 400", st == 400 and "2,000" in b)
    st, _, b = submit({"link": "javascript:alert(1)"})
    check("validation: bad link -> 400", st == 400 and "http://" in b)
    st, _, b = submit({"email": "not-an-email"})
    check("validation: bad email -> 400", st == 400 and "valid email" in b)
    clear_hits()

    print(" storage + notice")
    msg = "How do I see which stores have Blanton's? " + ("long text " * 40)
    st, _, b = submit({"category": "Bug", "message": msg, "city": "Park City", "link": "https://utahremedy.com/product/016850", "email": "Fan@Example.com", "user_id": "evil@x.com"})
    row = d1("SELECT * FROM feedback ORDER BY id DESC LIMIT 1")[0]
    check("stored with all columns", st == 200 and row["category"] == "Bug" and row["city"] == "Park City" and row["email"] == "fan@example.com" and row["status"] == "new" and row["link"].startswith("https://utahremedy.com"))
    check("user_id never from the form (NULL, no sign-in)", row["user_id"] is None)
    check("columns exactly as spec", set(row) == {"id", "created_at", "user_id", "email", "category", "city", "link", "message", "status", "replied_at", "reply_text", "owner_note"}, str(set(row)))
    time.sleep(2)
    lg = d1(f"SELECT * FROM feedback_mail_log WHERE kind='notice' AND feedback_id={row['id']}")
    check("one notice attempt logged for the item", len(lg) == 1, str(lg))
    check("notice sent via local simulator", lg and lg[0]["ok"] == 1, str(lg[:1]))
    logtxt = open(LOG, errors="replace").read()
    check("no bot token in wrangler log", TOKEN not in logtxt)
    check("analytics: no visit counted for /feedback or /__ur", '"/feedback"' not in logtxt and not re.search(r"\[ae-test\].*feedback", logtxt))
    fid = row["id"]

    print(" store cap")
    d1("INSERT INTO feedback (created_at, category, message) SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Other', 'filler' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<100) SELECT x FROM c)")
    n1 = n_feedback()
    st, _, b = submit({"message": "over the cap"})
    check("100 stored today -> 429 'try again tomorrow', not stored", st == 429 and "tomorrow" in b and n_feedback() == n1, str(st))
    d1("DELETE FROM feedback WHERE message='filler'")
    clear_hits()

    print(" bot endpoints")
    check("/__ur/feedback no header -> 403", bot("/__ur/feedback", token=None)[0] == 403)
    check("/__ur/feedback wrong token -> 403", bot("/__ur/feedback", token="y" * 43)[0] == 403)
    check("unknown /__ur path -> 404", bot("/__ur/nope")[0] == 404)
    st, j = bot("/__ur/feedback?status=new")
    check("list new -> 200 with items + counts", st == 200 and any(i["id"] == fid for i in j["items"]) and j["counts"]["new"] >= 1, str(st))
    it = next(i for i in j["items"] if i["id"] == fid)
    check("item reply_address = typed email (anonymous)", it["reply_address"] == "fan@example.com" and it["signed_in"] is False)
    check("list bad status -> 400", bot("/__ur/feedback?status=bogus")[0] == 400)
    st, j = bot(f"/__ur/feedback/{fid}/status", "POST", {"status": "needs-you", "note": "bug report, owner to decide"})
    check("status needs-you -> stored as needs-owner + note", st == 200 and j["item"]["status"] == "needs-owner" and j["item"]["owner_note"].startswith("bug"), str(j)[:200])
    st, j = bot("/__ur/feedback?status=needs-you")
    check("list status=needs-you alias", st == 200 and any(i["id"] == fid for i in j["items"]))
    check("status 'replied' via status endpoint refused", bot(f"/__ur/feedback/{fid}/status", "POST", {"status": "replied"})[0] == 400)
    check("status on missing id -> 404", bot("/__ur/feedback/999999/status", "POST", {"status": "reviewed"})[0] == 404)
    noaddr = d1("SELECT id FROM feedback WHERE email IS NULL AND user_id IS NULL ORDER BY id DESC LIMIT 1")[0]["id"]
    st, j = bot(f"/__ur/feedback/{noaddr}/reply", "POST", {"text": "hi"})
    check("reply with no reply address -> 409, not marked", st == 409 and d1(f"SELECT status FROM feedback WHERE id={noaddr}")[0]["status"] != "replied")
    check("reply without text -> 400", bot(f"/__ur/feedback/{fid}/reply", "POST", {})[0] == 400)
    st, j = bot(f"/__ur/feedback/{fid}/reply", "POST", {"text": "Thanks! Open the product page to see per-store counts."})
    check("reply -> sent, marked replied, text recorded", st == 200 and j.get("sent") and j["item"]["status"] == "replied" and j["item"]["reply_text"].startswith("Thanks") and j["item"]["replied_at"], str(j)[:200])
    st2, j2 = bot(f"/__ur/feedback/{fid}/reply", "POST", {"text": "second"})
    nrep = d1(f"SELECT COUNT(*) AS n FROM feedback_mail_log WHERE kind='reply' AND feedback_id={fid}")[0]["n"]
    check("second reply call does nothing (already, 1 send only)", st2 == 200 and j2.get("already") is True and nrep == 1 and d1(f"SELECT reply_text FROM feedback WHERE id={fid}")[0]["reply_text"].startswith("Thanks"))
    check("status change after reply refused (409)", bot(f"/__ur/feedback/{fid}/status", "POST", {"status": "reviewed"})[0] == 409)
    other = d1("SELECT id FROM feedback WHERE status='new' ORDER BY id LIMIT 1")[0]["id"]
    st, j = bot(f"/__ur/feedback/{other}/status", "POST", {"status": "reviewed"})
    check("status reviewed", st == 200 and j["item"]["status"] == "reviewed")

    print(" test-send (owner notice only)")
    nmail0 = d1("SELECT COUNT(*) AS n FROM feedback_mail_log WHERE kind='notice' AND feedback_id IS NULL")[0]["n"]
    check("GET /__ur/feedback/test-send -> 404", bot("/__ur/feedback/test-send")[0] == 404)
    check("test-send no header -> 403", bot("/__ur/feedback/test-send", "POST", {}, token=None)[0] == 403)
    check("test-send wrong token -> 403", bot("/__ur/feedback/test-send", "POST", {}, token="y" * 43)[0] == 403)
    st, j = bot("/__ur/feedback/test-send", "POST", {"to": "nobody@example.com", "text": "should not be used"})
    check("test-send -> 200, sent to NOTIFY_TO, body recipient ignored",
          st == 200 and j.get("sent") is True and j.get("kind") == "notice" and j.get("to") == "owner@example.com"
          and "nobody@example.com" not in str(j) and "sent" in (j.get("detail") or ""), f"{st} {j}")
    lg = d1("SELECT kind, feedback_id, ok, detail FROM feedback_mail_log WHERE kind='notice' AND feedback_id IS NULL ORDER BY id DESC LIMIT 1")
    check("test-send logs one owner notice with no feedback id",
          d1("SELECT COUNT(*) AS n FROM feedback_mail_log WHERE kind='notice' AND feedback_id IS NULL")[0]["n"] == nmail0 + 1
          and lg and lg[0]["ok"] == 1 and "sent" in lg[0]["detail"], str(lg))

    print(" admin page")
    st, h, b = req("/__ur/admin")
    check("admin without auth -> 401 + Basic challenge", st == 401 and "Basic" in (h.get("WWW-Authenticate") or ""))
    import base64
    st, h, b = req("/__ur/admin", headers={"Authorization": "Basic " + base64.b64encode(b"owner:wrong-password").decode()})
    check("admin wrong password -> 401", st == 401)
    st, h, b = req("/__ur/admin", headers={"Authorization": "Basic " + base64.b64encode(f"owner:{TOKEN}".encode()).decode()})
    check("admin via Basic auth (token as password) -> 200", st == 200 and "Feedback admin" in b, str(st))
    st, h, b = req("/__ur/admin", headers={"X-UR-Feedback-Token": TOKEN})
    check("admin shows statuses incl. needs you/replied/reviewed/new + reply text", st == 200 and all(x in b for x in [">replied<", ">reviewed<", ">new<", "Open the product page to see per-store counts."]))
    check("admin escapes user text", "<script" not in b.split("</header>")[1])
    check("admin noindex + no-store", "noindex" in b and "no-store" in (h.get("Cache-Control") or "") + (h.get("X-Robots-Tag") or "no-store"))
    check("admin lists spam sample + mail log", "Dropped as spam" in b and "honeypot" in b and "Recent email attempts" in b)

    print(" owner admin password (ADMIN_OWNER_PASSWORD)")
    ob = lambda pw, user="owner": {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}
    st, h, b = req("/__ur/admin", headers=ob(OWNER_PW))
    check("owner password (Basic) opens read-only admin -> 200", st == 200 and "Feedback admin" in b and "Read-only" in b, str(st))
    st, h, b = req("/__ur/admin", headers=ob(OWNER_PW, user="anything-at-all"))
    check("owner password works with any username", st == 200 and "Feedback admin" in b, str(st))
    st, h, b = req("/__ur/admin", headers=ob(OWNER_PW[:-1] + ("A" if OWNER_PW[-1] != "A" else "B")))
    check("owner password, last char wrong -> 401 + challenge", st == 401 and "Basic" in (h.get("WWW-Authenticate") or ""), str(st))
    st, h, b = req("/__ur/admin", headers=ob(OWNER_PW + "x"))
    check("owner password + extra char -> 401", st == 401, str(st))
    st, h, b = req("/__ur/admin", headers={"X-UR-Feedback-Token": OWNER_PW})
    check("owner password as bot header on admin -> 401", st == 401, str(st))
    target = d1("SELECT id FROM feedback WHERE status='new' ORDER BY id LIMIT 1")[0]["id"]
    before = d1(f"SELECT status, replied_at FROM feedback WHERE id={target}")[0]
    nmail = d1("SELECT COUNT(*) AS n FROM feedback_mail_log")[0]["n"]
    for path, method, body in [("/__ur/feedback", "GET", None), ("/__ur/feedback?status=new", "GET", None),
                               (f"/__ur/feedback/{target}/status", "POST", {"status": "reviewed"}),
                               (f"/__ur/feedback/{target}/reply", "POST", {"text": "should never send"}),
                               ("/__ur/feedback/test-send", "POST", {"to": "nobody@example.com"})]:
        data = json.dumps(body).encode() if body is not None else None
        st, _, _ = req(path, method, data=data, headers={"Content-Type": "application/json", **ob(OWNER_PW)})
        check(f"owner password (Basic) refused on {method} {path.split('?')[0]} -> 403", st == 403, str(st))
        st, _ = bot(path, method, body, token=OWNER_PW)
        check(f"owner password (bot header) refused on {method} {path.split('?')[0]} -> 403", st == 403, str(st))
    st, _, _ = req("/__ur/admin", "POST", data=b"{}", headers={"Content-Type": "application/json", **ob(OWNER_PW)})
    check("owner password refused on POST /__ur/admin -> 401", st == 401, str(st))
    after = d1(f"SELECT status, replied_at FROM feedback WHERE id={target}")[0]
    check("owner password attempts changed nothing (status, reply, mail log)", after == before and d1("SELECT COUNT(*) AS n FROM feedback_mail_log")[0]["n"] == nmail, f"{before} {after}")
    check("bot token Basic auth on admin still 200 with owner password set", req("/__ur/admin", headers=ob(TOKEN))[0] == 200)
    check("bot token header on API still 200 with owner password set", bot("/__ur/feedback")[0] == 200)
    time.sleep(1)
    check("no owner password in wrangler log", OWNER_PW not in open(LOG, errors="replace").read())
    stop()

def phase_b():
    print("phase b: tip off, email failure, quota reserve, cap")
    start({**FULL, "FEEDBACK_TEST_EMAIL_FAIL": "1"})
    C = "ur_age21=1"
    st, _, b = req("/", cookie=C)
    check("no CASHAPP_HANDLE or VENMO_HANDLE -> no tip link on home", st == 200 and "cash.app" not in b and "venmo.com" not in b and "Tip the dev" not in b and "tip-footer" not in b and 'href="/feedback"' in b)
    st, _, tipb = req("/tip", cookie="ur_age21=1")
    check("/tip still renders when no methods, without payment links or QRs", st == 200 and "entirely optional" in tipb and "cash.app" not in tipb and "venmo.com" not in tipb and "tip-qr" not in tipb and "tip-footer" not in tipb, str(st))
    st, _, b = req("/product/012345", cookie=C)
    check("no CASHAPP_HANDLE or VENMO_HANDLE -> no tip link on product", st == 200 and "cash.app" not in b and "venmo.com" not in b and "tip-footer" not in b)
    check_page_notice("home with tips off", req("/", cookie=C)[2], has_tip=False, has_top_tip_link=False)
    check_page_notice("product with tips off", b, has_tip=False, has_top_tip_link=False)
    check_page_notice("/tip with tips off", tipb, has_tip=False, has_top_tip_link=False)
    clear_hits()
    st, _, b = submit({"message": "email failure test", "email": "x@example.com"})
    check("submission still stored + Thanks when notice fails", st == 200 and THANKS in b)
    fid = d1("SELECT id FROM feedback ORDER BY id DESC LIMIT 1")[0]["id"]
    time.sleep(2)
    lg = d1(f"SELECT ok, detail FROM feedback_mail_log WHERE feedback_id={fid} AND kind='notice'")
    check("failed notice logged with error", lg and lg[0]["ok"] == 0 and "error" in lg[0]["detail"], str(lg))
    st, j = bot(f"/__ur/feedback/{fid}/reply", "POST", {"text": "hi there"})
    row = d1(f"SELECT status, replied_at, reply_text FROM feedback WHERE id={fid}")[0]
    check("reply send failure -> 502, NOT marked replied", st == 502 and row["status"] != "replied" and row["replied_at"] is None and row["reply_text"] is None, f"{st} {row}")
    check("reply lock released after failure", d1(f"SELECT COUNT(*) AS n FROM feedback_reply_lock WHERE feedback_id={fid}")[0]["n"] == 0)
    st, j = bot("/__ur/feedback/test-send", "POST", {})
    lg = d1("SELECT ok, detail FROM feedback_mail_log WHERE kind='notice' AND feedback_id IS NULL ORDER BY id DESC LIMIT 1")
    check("test-send send failure -> 502, logged as error, no success", st == 502 and j.get("sent") is False and lg and lg[0]["ok"] == 0 and "error" in lg[0]["detail"], f"{st} {j} {lg}")
    import base64
    ob = lambda pw: {"Authorization": "Basic " + base64.b64encode(f"owner:{pw}".encode()).decode()}
    check("ADMIN_OWNER_PASSWORD unset -> owner password path disabled (401)", req("/__ur/admin", headers=ob(OWNER_PW))[0] == 401)
    check("ADMIN_OWNER_PASSWORD unset -> bot token Basic auth unchanged (200)", req("/__ur/admin", headers=ob(TOKEN))[0] == 200)
    stop()
    print(" quota reserve + daily cap")
    start({**FULL, "EMAIL_DAILY_QUOTA": "12", "CASHAPP_HANDLE": "bad handle!", "VENMO_HANDLE": "no spaces allowed!", "ADMIN_OWNER_PASSWORD": "short-pw-11"})
    check("invalid CASHAPP_HANDLE and VENMO_HANDLE -> no tip link", "cash.app" not in req("/", cookie=C)[2] and "venmo.com" not in req("/", cookie=C)[2] and "tip-footer" not in req("/", cookie=C)[2])
    stop()
    start({**FULL, "VENMO_HANDLE": "@Quazar16"})
    b = req("/", cookie=C)[2]
    check("Venmo only: profile link and official QR, no Cash App", st_ok := ("https://www.venmo.com/u/Quazar16" in b) and "cash.app" not in b and "tip-footer" in b and "venmocs/51db6324-8b39-48c1-b215-9ad07680ee72" in b, b[b.find("tip-footer"):b.find("tip-footer")+400] if "tip-footer" in b else "missing tip")
    stop()
    start({**FULL}, ("--var", "CASHAPP_HANDLE:$UtahRemedyTest"))
    b = req("/", cookie=C)[2]
    check("Cash App only: cash.app link and QR, no Venmo", "https://cash.app/$UtahRemedyTest" in b and "venmo.com" not in b and "tip-footer" in b and 'data-qr="https://cash.app/$UtahRemedyTest?qr=1"' in b)
    stop()
    start({**FULL, "EMAIL_DAILY_QUOTA": "12", "CASHAPP_HANDLE": "bad handle!", "VENMO_HANDLE": "no spaces allowed!", "ADMIN_OWNER_PASSWORD": "short-pw-11"})
    check("ADMIN_OWNER_PASSWORD shorter than 12 chars -> disabled (401)", req("/__ur/admin", headers=ob("short-pw-11"))[0] == 401)
    check("short owner password -> bot token Basic auth unchanged (200)", req("/__ur/admin", headers=ob(TOKEN))[0] == 200)
    d1("DELETE FROM feedback_mail_log")
    d1("INSERT INTO feedback_mail_log (at, day, kind, feedback_id, ok, detail) VALUES " + ",".join(["(strftime('%Y-%m-%dT%H:%M:%fZ','now'), (SELECT date('now','-7 hours')), 'notice', NULL, 1, 'sent filler')"] * 2))
    day = d1("SELECT day FROM feedback_mail_log LIMIT 1")[0]["day"]   # MST Utah day (test runs Nov-Mar; adjust -6 h in MDT)
    st, j = bot(f"/__ur/feedback/{fid}/reply", "POST", {"text": "quota test"})
    check("quota 12, 2 sent today -> reply refused (last 10 reserved), not marked", st == 429 and "quota reserve" in j.get("error", "") and d1(f"SELECT status FROM feedback WHERE id={fid}")[0]["status"] != "replied", f"{st} {j} day={day}")
    d1("DELETE FROM feedback_mail_log")
    stop()
    start({**FULL})
    d1("INSERT INTO feedback_mail_log (at, day, kind, feedback_id, ok, detail) SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), '" + day + "', 'notice', NULL, 1, 'sent filler' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<30) SELECT x FROM c)")
    clear_hits()
    st, _, b = submit({"message": "notice cap test"})
    fid2 = d1("SELECT id FROM feedback ORDER BY id DESC LIMIT 1")[0]["id"]
    time.sleep(2)
    lg = d1(f"SELECT ok, detail FROM feedback_mail_log WHERE feedback_id={fid2}")
    check("30 feedback emails today -> notice suppressed (stored, Thanks)", st == 200 and lg and lg[0]["ok"] == 0 and "daily feedback email cap" in lg[0]["detail"], str(lg))
    stop()

    print(" NOTIFY_TO secret missing / invalid (fail closed)")
    for label, val in (("missing", None), ("invalid", "not-an-email")):
        start({**FULL, "NOTIFY_TO": val})
        d1("DELETE FROM feedback_mail_log")
        clear_hits()
        st, _, b = submit({"message": f"notify-to {label} test"})
        fid3 = d1("SELECT id FROM feedback ORDER BY id DESC LIMIT 1")[0]["id"]
        time.sleep(2)
        lg = d1(f"SELECT ok, detail FROM feedback_mail_log WHERE feedback_id={fid3}")
        check(f"NOTIFY_TO {label}: feedback stored + Thanks, notice not sent (logged ok=0 'no NOTIFY_TO secret')",
              st == 200 and THANKS in b and lg and lg[0]["ok"] == 0 and "no NOTIFY_TO secret" in lg[0]["detail"], str(lg))
        st, j = bot("/__ur/feedback/test-send", "POST", {"to": "nobody@example.com"})
        check(f"NOTIFY_TO {label}: test-send -> 503 not sent, body recipient never used",
              st == 503 and j.get("sent") is False and "NOTIFY_TO" in j.get("error", "") and "nobody@example.com" not in str(j), f"{st} {j}")
        check(f"NOTIFY_TO {label}: nothing counted as sent", d1("SELECT COUNT(*) AS n FROM feedback_mail_log WHERE ok=1")[0]["n"] == 0)
        st, j = bot("/__ur/feedback")
        check(f"NOTIFY_TO {label}: bot list reports notify_to_set false", st == 200 and j.get("email_today", {}).get("notify_to_set") is False, str(j.get("email_today")))
        stop()

def phase_c():
    print("phase c: intake not configured")
    start({"ADMIN_OWNER_PASSWORD": OWNER_PW})
    st, h, b = req("/feedback")
    check("form renders with 'temporarily unavailable'", st == 200 and "temporarily unavailable" in b and "cf-turnstile" not in b)
    check("default CSP kept when Turnstile is off", "script-src 'none'" in (h.get("Content-Security-Policy") or ""))
    n0 = n_feedback()
    st, _, b = req("/feedback", "POST", data=b"category=Other&message=hi", headers={"Content-Type": "application/x-www-form-urlencoded"})
    check("POST -> 503 friendly page, nothing stored", st == 503 and "temporarily unavailable" in b and n_feedback() == n0)
    check("/__ur/feedback -> 404 without bot secret configured", bot("/__ur/feedback")[0] == 404)
    check("test-send -> 404 without bot secret configured", bot("/__ur/feedback/test-send", "POST", {})[0] == 404)
    check("/__ur/admin -> 404 without bot secret configured", req("/__ur/admin")[0] == 404)
    import base64
    check("no bot secret -> owner password also 404 (fail closed)", req("/__ur/admin", headers={"Authorization": "Basic " + base64.b64encode(f"owner:{OWNER_PW}".encode()).decode()})[0] == 404)
    stop()
    print(" turnstile site key without secret")
    start({"TURNSTILE_SITE_KEY": "1x00000000000000000000AA", "UR_FEEDBACK_BOT_TOKEN": TOKEN})
    st, _, b = req("/feedback", "POST", data=b"category=Other&message=hi", headers={"Content-Type": "application/x-www-form-urlencoded"})
    check("site key only (no secret) -> still 503, Turnstile never skipped", st == 503)
    stop()

def main():
    phases = sys.argv[1:] or ["a", "b", "c"]
    shutil.rmtree(PERSIST, ignore_errors=True); open(LOG, "w").close()
    r = sh(NPX + ["d1", "migrations", "apply", "utah-remedy-db", "--local", "--persist-to", PERSIST]); assert r.returncode == 0, r.stdout[-500:] + r.stderr[-500:]
    d1("INSERT INTO products (sku, name, category) VALUES ('012345','TEST BOURBON SMALL BATCH','WHISKEY - BOURBON & TENNESSEE')")
    d1("INSERT INTO stores (id, name, city) VALUES ('0001','STORE 1 TEST','SALT LAKE CITY')")
    srv = HTTPServer(("127.0.0.1", 9912), TS); threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        for p in phases: {"a": phase_a, "b": phase_b, "c": phase_c}[p]()
    finally:
        stop(); srv.shutdown()
        try: os.remove(ENVF)
        except OSError: pass
    print(f"\n{passes} passed, {len(fails)} failed")
    for f in fails: print("  FAILED:", f)
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
