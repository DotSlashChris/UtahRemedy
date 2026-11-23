#!/usr/bin/env python3
"""Fast local tests for email magic-link sign-in (src/auth.ts; watches design step 1, owner-approved t99s544, 2026-11-21).
ZERO real Turnstile, email or DABS traffic: `wrangler dev` (port 8789, inspector 9339) with a throwaway persist dir
(/tmp/ur-auth-test), a local mock Turnstile siteverify (port 9913), a throwaway bot secret generated in memory and written only to a
chmod-600 temp env file (deleted afterwards). Mail goes to the local send_email simulator; the test reads the .txt it writes.
Run (Node 22 on PATH):  python3 scripts/test-auth.py [phase ...]   phases: a (main flow, default), b (limits + retention), c (not configured / mail failure)"""
import json, os, re, secrets, shutil, subprocess, sys, threading, time, urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERSIST = "/tmp/ur-auth-test"
ENVF = "/tmp/ur-auth-test.env"
LOG = "/tmp/ur-auth-test.log"
BASE = "http://127.0.0.1:8789"
NPX = ["npx", "wrangler"]
TOKEN = secrets.token_urlsafe(32)
fails, passes = [], 0
TS_MODE = {"mode": "ok"}
AGE = "ur_age21=1"

class TS(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        q = urllib.parse.parse_qs(self.rfile.read(n).decode())
        if TS_MODE["mode"] == "down": self.send_response(500); self.end_headers(); return
        ok = q.get("response", [""])[0] == "pass-token" and q.get("secret", [""])[0] == "test-turnstile-secret"
        b = json.dumps({"success": ok}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass

def check(name, cond, detail=""):
    global passes
    if cond: passes += 1; print(f"  PASS {name}")
    else: fails.append(name); print(f"  FAIL {name} {str(detail)[:300]}")

def sh(args, **kw): return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, **kw)
def d1(sql):
    r = sh(NPX + ["d1", "execute", "utah-remedy-db", "--local", "--persist-to", PERSIST, "--json", "--command", sql])
    try: out = json.loads(r.stdout)
    except ValueError: raise SystemExit(f"d1 failed: {r.stdout[-300:]} {r.stderr[-300:]}")
    return out[0]["results"] if out else []
def n(sql): return list(d1(sql)[0].values())[0]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def req(path, method="GET", cookie=None, data=None, headers=None, ip="198.51.100.7"):
    h = {"User-Agent": "UR-Auth-Test/1.0", "X-UR-Test-IP": ip, **(headers or {})}
    if cookie: h["Cookie"] = cookie
    if isinstance(data, dict): data = urllib.parse.urlencode(data).encode(); h["Content-Type"] = "application/x-www-form-urlencoded"
    r = urllib.request.Request(BASE + path, method=method, headers=h, data=data)
    try: resp = opener.open(r, timeout=30)
    except urllib.error.HTTPError as e: resp = e
    return resp.status, resp.headers, resp.read().decode("utf-8", "replace")
def cookies_from(h):
    out = {}
    for sc in h.get_all("Set-Cookie") or []:
        k, _, rest = sc.partition("="); out[k.strip()] = (rest.split(";")[0], sc)
    return out
def jar(*parts): return "; ".join(p for p in parts if p)

def signin_form(cookie=AGE, ip="198.51.100.7", next_=None):
    st, h, body = req("/signin" + (f"?next={urllib.parse.quote(next_)}" if next_ else ""), cookie=cookie, ip=ip)
    ck = cookies_from(h).get("__Host-ur_auth_csrf")
    csrf_ck = f"__Host-ur_auth_csrf={ck[0]}" if ck else None
    g = lambda k: (re.search(rf'name="{k}" value="([^"]*)"', body) or [None, ""])[1]
    return st, h, body, csrf_ck, g("csrf"), g("ft"), g("next")

def request_link(email, ip="198.51.100.7", wait=2.2, ts="pass-token", tamper=None, next_=None, agree="yes"):
    st, h, body, ck, csrf, ft, nxt = signin_form(ip=ip, next_=next_)
    time.sleep(wait)
    f = {"csrf": csrf, "ft": ft, "next": nxt, "email": email, "agree": agree, "cf-turnstile-response": ts, "website": ""}
    if tamper: tamper(f)
    return req("/signin", "POST", cookie=jar(AGE, ck), ip=ip, data=f)

def log_size(): return os.path.getsize(LOG)
def mails_since(pos, timeout=6):
    """Text bodies the local send_email simulator wrote after log offset `pos`."""
    end = time.time() + timeout; out = []
    while time.time() < end:
        with open(LOG, "r", errors="replace") as fh: fh.seek(pos); txt = fh.read()
        paths = re.findall(r"Text: (\S+email-text/\S+\.txt)", txt)
        if paths:
            time.sleep(0.3)
            with open(LOG, "r", errors="replace") as fh: fh.seek(pos); txt = fh.read()
            return [open(p).read() for p in re.findall(r"Text: (\S+email-text/\S+\.txt)", txt)]
        time.sleep(0.3)
    return out
def link_of(mail):
    m = re.search(r"(https?://[^\s/]+/auth/verify\?t=([A-Za-z0-9_-]{43}))(?![A-Za-z0-9_-])", mail or "")
    if not m: print("    (no link found; mail with tokens redacted):", re.sub(r"t=[A-Za-z0-9_=-]+", "t=<redacted>", mail or "")[:600])
    return (m.group(1), m.group(2)) if m else (None, None)

def get_link(email, ip="198.51.100.7", next_=None):
    pos = log_size(); st, h, body = request_link(email, ip=ip, next_=next_)
    mails = mails_since(pos)
    return st, body, (link_of(mails[0])[1] if mails else None), mails

def finish(tok, ip="198.51.100.7"):
    st, h, body = req(f"/auth/verify?t={tok}", cookie=AGE, ip=ip)
    ck = cookies_from(h).get("__Host-ur_auth_csrf"); csrf_ck = f"__Host-ur_auth_csrf={ck[0]}" if ck else ""
    csrf = (re.search(r'name="csrf" value="([^"]*)"', body) or [None, ""])[1]
    return req("/auth/verify", "POST", cookie=jar(AGE, csrf_ck), ip=ip, data={"csrf": csrf, "t": tok})

def session_of(h):
    c = cookies_from(h).get("__Host-ur_session"); return (f"__Host-ur_session={c[0]}", c[1]) if c else (None, None)

def account_csrf(sess):
    st, h, body = req("/account", cookie=jar(AGE, sess))
    ck = cookies_from(h).get("__Host-ur_auth_csrf"); csrf_ck = f"__Host-ur_auth_csrf={ck[0]}" if ck else ""
    return st, body, csrf_ck, (re.search(r'name="csrf" value="([^"]*)"', body) or [None, ""])[1]

def sign_in(email, ip="198.51.100.7"):
    d1("DELETE FROM auth_hits")
    st, body, tok, _ = get_link(email, ip=ip)
    st2, h2, _ = finish(tok, ip=ip)
    return session_of(h2)[0]

wr = None
def start(extra_env):
    global wr
    stop()
    with open(ENVF, "w") as fh: pass
    os.chmod(ENVF, 0o600)
    base = {"DABS_BASE_URL": "http://127.0.0.1:9911/dyn", "FETCHER_ENABLED": "false", "FEEDBACK_TEST_TURNSTILE_URL": "http://127.0.0.1:9913/siteverify", "ANALYTICS_TEST_LOG": "1"}
    base.update(extra_env)
    with open(ENVF, "w") as fh:
        for k, v in base.items():
            if v is not None: fh.write(f"{k}='{v}'\n")
    logf = open(LOG, "a")
    wr = subprocess.Popen(NPX + ["dev", "--port", "8789", "--inspector-port", "9339", "--persist-to", PERSIST, "--env-file", ENVF], cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
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
    wr = None; time.sleep(0.5)

FULL = {"TURNSTILE_SITE_KEY": "1x00000000000000000000AA", "TURNSTILE_SECRET": "test-turnstile-secret", "UR_FEEDBACK_BOT_TOKEN": TOKEN, "VENMO_HANDLE": "Quazar16"}
NOTICE_OPEN = "Independent service, not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services (DABS)."

def phase_a():
    print("phase a: gate, pages, header links, form layers, link, verify, session, sign-out, delete")
    start(FULL)
    for p in ["/signin", "/account", "/auth/verify?t=abc", "/account/delete"]:
        st, h, _ = req(p)
        check(f"{p} gated: 302 to /gate without the age cookie", st == 302 and h.get("Location", "").startswith("/gate?next="), f"{st} {h.get('Location')}")
    st, h, _ = req("/signin", "POST", data={"email": "a@example.com"})
    check("POST /signin gated too", st == 302 and "/gate" in h.get("Location", ""))

    print(" pages + header")
    st, h, body, ck, csrf, ft, nxt = signin_form()
    check("GET /signin 200 behind gate, Turnstile widget, required 21+ box", st == 200 and 'class="cf-turnstile' in body and 'name="agree"' in body and "required" in body and "I&rsquo;m 21 or older" in body)
    check("/signin no-store + noindex", h.get("Cache-Control") == "no-store" and 'name="robots" content="noindex"' in body, h.get("Cache-Control"))
    check("/signin CSP allows only the Turnstile origin for script", "script-src https://challenges.cloudflare.com" in (h.get("Content-Security-Policy") or ""))
    check("/signin CSRF cookie flags", ck and "HttpOnly" in cookies_from(h)["__Host-ur_auth_csrf"][1] and "Secure" in cookies_from(h)["__Host-ur_auth_csrf"][1])
    i_hdr = body.find("</header>")
    check("/signin header: Disclaimer, Tip the dev, Sign in links", 0 < body.find('href="/disclaimer">Disclaimer</a>') < i_hdr and 0 < body.find('href="/tip">Tip the dev</a>') < i_hdr and 0 < body.find('href="/signin">Sign in</a>') < i_hdr)
    i_notice = body.find('class="page-notice"'); i_tip = body.find("tip-footer"); i_main = body.rfind("</main>")
    check("/signin: DABS notice at bottom, tip section last in main", i_hdr < i_notice < i_tip < i_main and body.count(NOTICE_OPEN) == 1, f"{i_notice} {i_tip} {i_main}")
    st, _, home = req("/", cookie=AGE)
    hh = home.find("</header>")
    check("home: header Sign in link next to Disclaimer/Tip the dev", st == 200 and 0 < home.find('href="/signin">Sign in</a>') < hh and 0 < home.find('href="/disclaimer">Disclaimer</a>') < hh and 0 < home.find('href="/tip">Tip the dev</a>') < hh)
    st, _, gate = req("/gate")
    check("gate page: no Sign in link", st == 200 and 'href="/signin"' not in gate)
    for p in ["/privacy", "/terms"]:
        st, _, b = req(p)
        check(f"{p}: Sign in header link (public page)", st == 200 and 'href="/signin">Sign in</a>' in b)
    st, _, b = req("/privacy")
    check("privacy: new wording (account, sign-in protection, keeping/deleting, cookies, sharing)",
          "<strong>Account and sign-in:</strong> if you sign in to use watches" in b and "<strong>Sign-in protection:</strong>" in b and "Keeping and deleting your data" in b
          and "Alert records are deleted after 90 days." in b and "a sign-in cookie that keeps you signed in for up to 30 days" in b
          and "We don&rsquo;t share your email or watches with DABS, stores, or anyone else" in b and "We do not currently have accounts" not in b
          and "Last updated: November 21, 2026" in b)
    st, _, b = req("/terms")
    check("terms: section 6 Accounts, watches, and alerts; 7 Remedies and Concierge; renumbered to 11",
          "<h2>6. Accounts, watches, and alerts</h2>" in b and "<h2>7. Remedies and Concierge</h2>" in b and "<h2>8. Limitation of liability</h2>" in b
          and "<h2>11. Contact</h2>" in b and "Future features" not in b and "Last updated: November 21, 2026" in b)

    print(" form layers")
    d1("DELETE FROM auth_hits"); d1("DELETE FROM mail_log")
    pos = log_size()
    st, _, b = request_link("x@example.com", tamper=lambda f: f.update(csrf="wrong"))
    check("bad CSRF -> 400 form, nothing sent", st == 400 and "Form expired" in b)
    st, _, b = request_link("x@example.com", ts="bad-token")
    check("fake Turnstile token -> 400 'could not verify', nothing sent", st == 400 and "could not verify you are human" in b)
    TS_MODE["mode"] = "down"
    st, _, b = request_link("x@example.com")
    TS_MODE["mode"] = "ok"
    check("Turnstile unreachable -> 503 (fail closed)", st == 503)
    st, _, b_hp = request_link("x@example.com", tamper=lambda f: f.update(website="http://spam"))
    check("honeypot -> same 'check your email' page", st == 200 and "Check your email" in b_hp)
    st, _, b_fast = request_link("x@example.com", wait=0)
    check("too fast (< 2 s) -> same page quietly", st == 200 and "Check your email" in b_fast)
    st, _, b = request_link("not-an-email")
    check("invalid email -> 400", st == 400 and "valid email" in b)
    st, _, b = request_link("x@example.com", agree="")
    check("21+/terms box unchecked -> 400", st == 400 and "21 or older" in b)
    time.sleep(1.5)
    check("none of those sent mail or stored a link", n("SELECT COUNT(*) FROM mail_log") == 0 and n("SELECT COUNT(*) FROM auth_tokens") == 0 and not mails_since(pos, 1))

    print(" link + email")
    st, body_new, tok, mails = get_link("New.User@Example.com", next_="/product/012345")
    check("valid request -> 200 'check your email' + one email", st == 200 and "Check your email" in body_new and len(mails) == 1 and tok, f"{st} {len(mails)}")
    m = mails[0] if mails else ""
    check("email: link, 15 min/once, ignore line, DABS disclaimer + verify line, 21+", "expires in 15 minutes" in m and "works once" in m and "No account is created unless the link is used" in m
          and "not affiliated with or endorsed by the Utah Department of Alcoholic Beverage" in m and "Verify with the store before you travel." in m and "21 and older" in m)
    check("mail_log: one signin row, ok=1, no recipient stored", d1("SELECT kind, ok, detail FROM mail_log") and n("SELECT COUNT(*) FROM mail_log WHERE kind='signin' AND ok=1") == 1 and "example.com" not in json.dumps(d1("SELECT * FROM mail_log")))
    row = d1("SELECT * FROM auth_tokens")[0]
    check("token stored only as SHA-256; email normalized; next kept", tok not in json.dumps(row) and len(row["token_hash"]) == 64 and row["email"] == "new.user@example.com" and row["next"] == "/product/012345", row)
    exp = (time.mktime(time.strptime(row["expires_at"][:19], "%Y-%m-%dT%H:%M:%S")) - time.mktime(time.strptime(row["created_at"][:19], "%Y-%m-%dT%H:%M:%S")))
    check("token lifetime exactly 15 min", abs(exp - 900) <= 1, exp)
    hits = d1("SELECT * FROM auth_hits")
    check("rate-limit hits are hashes only (no IP / email)", hits and "198.51.100.7" not in json.dumps(hits) and "example.com" not in json.dumps(hits))
    check("no account yet before the link is used", n("SELECT COUNT(*) FROM users") == 0)

    print(" scanner-safe verify + single use")
    for i in range(2):
        st, h, b = req(f"/auth/verify?t={tok}", cookie=AGE)
        check(f"GET verify #{i+1}: Finish signing in button, no-store, no-referrer", st == 200 and "Finish signing in" in b and 'method="post" action="/auth/verify"' in b and h.get("Cache-Control") == "no-store" and h.get("Referrer-Policy") == "no-referrer")
    check("GETs did not consume the link or create a session", n("SELECT COUNT(*) FROM auth_tokens WHERE used_at IS NULL") == 1 and n("SELECT COUNT(*) FROM sessions") == 0)
    st, h, b = finish(tok)
    sess, sc = session_of(h)
    check("POST verify -> 303 to the safe next path", st == 303 and h.get("Location") == "/product/012345", f"{st} {h.get('Location')}")
    check("session cookie: __Host-, HttpOnly, Secure, SameSite=Lax, Max-Age 30 days, Path=/", sess and "HttpOnly" in sc and "Secure" in sc and "SameSite=Lax" in sc and "Max-Age=2592000" in sc and "Path=/" in sc, sc)
    u = d1("SELECT * FROM users")
    check("user created on first use: email, age_confirmed_at, terms_version", len(u) == 1 and u[0]["email"] == "new.user@example.com" and u[0]["age_confirmed_at"] and u[0]["terms_version"] == "2026-11-21", u)
    srow = d1("SELECT * FROM sessions")
    check("session stored only as SHA-256, expires in 30 days", len(srow) == 1 and sess.split("=", 1)[1] not in json.dumps(srow) and len(srow[0]["id_hash"]) == 64)
    _, _, _, ckx, csrfx, _, _ = signin_form()
    st, h, b = req("/auth/verify", "POST", cookie=jar(AGE, ckx), data={"csrf": csrfx, "t": tok})
    hits0 = n("SELECT COUNT(*) FROM auth_hits WHERE kind='verify'")
    check("same link again (valid CSRF, no session) -> 303 to /auth/used, no session (single use)", st == 303 and h.get("Location") == "/auth/used?next=%2Fproduct%2F012345" and not session_of(h)[0], f"{st} {h.get('Location')}")
    st, h, b = req(h.get("Location"), cookie=AGE)
    check("/auth/used without a session -> 400 'already used', links to /account and /signin, no form, no session", st == 400 and "already used" in b and 'href="/account"' in b and 'href="/signin"' in b and 'action="/auth/verify"' not in b and h.get("Cache-Control") == "no-store" and not session_of(h)[0])
    st, h, b = req(f"/auth/verify?t={tok}", cookie=AGE)
    check("GET of a used link, no session -> 303 to /auth/used (no form)", st == 303 and h.get("Location", "").startswith("/auth/used?next=") and 'action="/auth/verify"' not in b, f"{st} {h.get('Location')}")
    st, h, _ = req("/auth/used?next=https%3A%2F%2Fevil.example%2F", cookie=jar(AGE, sess))
    check("/auth/used signed in with an outside next -> 303 /account (safeNext)", st == 303 and h.get("Location") == "/account", f"{st} {h.get('Location')}")
    st, h, _ = req("/auth/used?next=%2Fproduct%2F012345")
    check("/auth/used is behind the age gate", st == 302 and h.get("Location", "").startswith("/gate"), f"{st} {h.get('Location')}")
    check("used-link pages add no bad-verify hits", n("SELECT COUNT(*) FROM auth_hits WHERE kind='verify'") == hits0)
    ns0 = n("SELECT COUNT(*) FROM sessions")
    st, h, b = req(f"/auth/verify?t={tok}", cookie=jar(AGE, sess))
    check("GET of a used link while signed in -> 303 to its next path, no new session", st == 303 and h.get("Location") == "/product/012345" and not session_of(h)[0] and n("SELECT COUNT(*) FROM sessions") == ns0, f"{st} {h.get('Location')}")
    st, h, b = req("/auth/verify", "POST", cookie=jar(AGE, ckx, sess), data={"csrf": csrfx, "t": tok})
    check("POST of a used link while signed in -> 303, no new session", st == 303 and not session_of(h)[0] and n("SELECT COUNT(*) FROM sessions") == ns0, st)
    st, _, b = req(f"/auth/verify?t={'B'*43}", cookie=AGE)
    check("unknown link -> 400 'isn't valid' + one bad-verify hit", st == 400 and "isn&rsquo;t valid" in b and n("SELECT COUNT(*) FROM auth_hits WHERE kind='verify'") == hits0 + 1)

    print(" owner report 2026-11-21: double-click on Finish signing in")
    d1("DELETE FROM auth_hits")
    _, _, tokd, _ = get_link("double@example.com")
    st, h, b = req(f"/auth/verify?t={tokd}", cookie=AGE)
    ckd = cookies_from(h).get("__Host-ur_auth_csrf"); ckd = f"__Host-ur_auth_csrf={ckd[0]}" if ckd else ""
    csrfd = re.search(r'name="csrf" value="([^"]*)"', b).group(1)
    st1, h1, _ = req("/auth/verify", "POST", cookie=jar(AGE, ckd), data={"csrf": csrfd, "t": tokd})
    st2, h2, b2 = req("/auth/verify", "POST", cookie=jar(AGE, ckd), data={"csrf": csrfd, "t": tokd})   # 2nd click, sent before the cookie landed
    sessd = session_of(h1)[0]
    check("double-click: 1st POST signs in, 2nd -> 303 /auth/used (no error page, no 2nd session)", st1 == 303 and sessd and st2 == 303 and h2.get("Location", "").startswith("/auth/used?next=") and not session_of(h2)[0]
          and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email='double@example.com'") == 1, [st1, st2])
    st3, h3, b3 = req(h2.get("Location"), cookie=jar(AGE, ckd, sessd))   # browser follows the redirect; the 1st POST's cookie has landed
    check("double-click: following /auth/used with the session -> silently continues to the link's next page, no new session (t102u)", st3 == 303 and h3.get("Location") == h1.get("Location") and not session_of(h3)[0]
          and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email='double@example.com'") == 1, f"{st3} {h3.get('Location')} {h1.get('Location')}")
    st, h, _ = req("/signin", cookie=jar(AGE, sessd))
    check("then 'Get a new sign-in link' while signed in -> straight to /account (expected; the 1st POST did sign in)", st == 303 and h.get("Location") == "/account", f"{st} {h.get('Location')}")
    st, h, b = req("/account", cookie=AGE)
    check("'Go to your account' without the session cookie -> /signin (the used page grants nothing)", st == 303 and h.get("Location", "").startswith("/signin"), f"{st} {h.get('Location')}")
    d1("DELETE FROM auth_hits")
    _, _, tok2, _ = get_link("race@example.com")
    def post_once(_):
        st, h, b = req(f"/auth/verify?t={tok2}", cookie=AGE)
        ck = cookies_from(h).get("__Host-ur_auth_csrf"); csrf = re.search(r'name="csrf" value="([^"]*)"', b).group(1)
        return (ck, csrf)
    prep = [post_once(i) for i in range(4)]
    with ThreadPoolExecutor(4) as ex:
        raw = list(ex.map(lambda p: req("/auth/verify", "POST", cookie=jar(AGE, f"__Host-ur_auth_csrf={p[0][0]}"), data={"csrf": p[1], "t": tok2}), prep))
    res = [("signin" if session_of(h)[0] else "used" if st == 303 and h.get("Location", "").startswith("/auth/used?") else st) for st, h, _ in raw]
    check("4 concurrent POSTs of one link -> exactly one sign-in, the rest go to /auth/used", res.count("signin") == 1 and res.count("used") == 3 and n("SELECT COUNT(*) FROM users WHERE email='race@example.com'") == 1
          and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email='race@example.com'") == 1, res)
    d1("DELETE FROM auth_hits")
    _, _, tok3, _ = get_link("late@example.com")
    d1("UPDATE auth_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds') WHERE email='late@example.com'")
    st1, _, _ = req(f"/auth/verify?t={tok3}", cookie=AGE); st2, h2, _ = finish(tok3)
    check("expired link (past 15 min) -> GET and POST refused", st1 == 400 and st2 == 400 and not session_of(h2)[0])
    st, h, b = req("/auth/verify", "POST", cookie=AGE, data={"csrf": "x", "t": tok3})
    check("verify POST without CSRF cookie -> 400", st == 400)

    print(" enumeration-safe responses")
    d1("DELETE FROM auth_hits")
    st_e, _, b_exist = request_link("new.user@example.com")      # existing account
    st_n, _, b_new2 = request_link("someone.else@example.com")   # new address
    d1("INSERT INTO auth_hits (kind, key_hash, at) SELECT 'ip', key_hash, at FROM auth_hits WHERE kind='ip' LIMIT 1")
    for _ in range(5): d1("INSERT INTO auth_hits (kind, key_hash, at) SELECT kind, key_hash, at FROM auth_hits WHERE kind='ip' LIMIT 1")
    st_l, _, b_lim = request_link("limited@example.com")           # IP over its limit
    check("existing / new / rate-limited / honeypot: identical status and body", st_e == st_n == st_l == 200 and b_exist == b_new2 == b_lim == body_new == b_hp, [st_e, st_n, st_l])

    print(" account, sessions, sign-out, sign-out everywhere")
    d1("DELETE FROM auth_hits")
    st, h, b = req("/account", cookie=jar(AGE, sess))
    check("/account signed in: email shown, no-store, Sign out / everywhere / delete", st == 200 and "new.user@example.com" in b and h.get("Cache-Control") == "no-store" and 'action="/signout"' in b and 'action="/account/signout-all"' in b and 'href="/account/delete"' in b)
    check("header shows Account (not Sign in) with a session cookie", 'href="/account">Account</a>' in b and 'href="/signin">Sign in</a>' not in b)
    st, _, hb = req("/", cookie=jar(AGE, sess))
    check("home header shows Account when signed in", 'href="/account">Account</a>' in hb)
    st, h, _ = req("/account", cookie=AGE)
    check("/account signed out -> 303 /signin?next=/account", st == 303 and h.get("Location") == "/signin?next=%2Faccount")
    st, h, _ = req("/signin", cookie=jar(AGE, sess))
    check("/signin while signed in -> redirect to /account", st == 303 and h.get("Location") == "/account")
    st, body, ck, csrf = account_csrf(sess)
    st, h, b = req("/signout", "POST", cookie=jar(AGE, sess, ck), data={"csrf": "bad"})
    check("sign out with bad CSRF -> no change", st == 303 and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='new.user@example.com'") == 1)
    st, h, b = req("/signout", "POST", cookie=jar(AGE, sess, ck), data={"csrf": csrf})
    _, clr = session_of(h)
    check("signed-out page: 'Utah Remedy Home' link, no 'Back to Utah Remedy' (t101u)", 'href="/">Utah Remedy Home</a>' in b and "Back to Utah Remedy" not in b)
    check("sign out -> session row deleted, cookie cleared (Max-Age=0)", st == 200 and "signed out" in b and clr and "Max-Age=0" in clr and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='new.user@example.com'") == 0)
    check("old cookie no longer works", req("/account", cookie=jar(AGE, sess))[0] == 303)
    s1 = sign_in("multi@example.com", ip="198.51.100.21"); s2 = sign_in("multi@example.com", ip="198.51.100.22")
    check("two devices -> two sessions", s1 and s2 and s1 != s2 and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='multi@example.com'") == 2)
    st, body, ck, csrf = account_csrf(s1)
    st, h, b = req("/account/signout-all", "POST", cookie=jar(AGE, s1, ck), data={"csrf": csrf})
    check("sign out everywhere -> all sessions of that user gone, both cookies dead", st == 200 and n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='multi@example.com'") == 0
          and req("/account", cookie=jar(AGE, s1))[0] == 303 and req("/account", cookie=jar(AGE, s2))[0] == 303)
    other = sign_in("bystander@example.com", ip="198.51.100.23")
    for i in range(6): last = sign_in("many@example.com", ip=f"198.51.100.{40+i}")
    check("max 5 sessions per user (oldest dropped); other users untouched", n("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='many@example.com'") == 5
          and req("/account", cookie=jar(AGE, last))[0] == 200 and req("/account", cookie=jar(AGE, other))[0] == 200)
    d1("UPDATE sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds') WHERE user_id = (SELECT id FROM users WHERE email='bystander@example.com')")
    check("expired session (30 days absolute) -> signed out", req("/account", cookie=jar(AGE, other))[0] == 303)

    print(" delete account")
    sd = sign_in("delete.me@example.com", ip="198.51.100.60")
    uid = d1("SELECT id FROM users WHERE email='delete.me@example.com'")[0]["id"]
    d1(f"INSERT INTO products (sku, name) VALUES ('012345','TEST BOURBON') ON CONFLICT DO NOTHING")
    d1(f"INSERT INTO watches (user_id, kind, criteria_json) VALUES ('{uid}', 'product', '{{\"sku\":\"012345\"}}')")
    d1(f"INSERT INTO alerts (watch_id, user_id, channel, status) VALUES ((SELECT id FROM watches WHERE user_id='{uid}'), '{uid}', 'email', 'dry_run')")
    d1(f"INSERT INTO feedback (created_at, user_id, category, message) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), '{uid}', 'Other', 'keep this message')")
    d1(f"INSERT INTO auth_tokens (token_hash, email, created_at, expires_at) VALUES ('pending-hash', 'delete.me@example.com', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'))")
    st, h, b = req("/account/delete", cookie=jar(AGE, sd))
    check("delete confirm page", st == 200 and "Delete your account?" in b and 'action="/account/delete"' in b)
    ck = cookies_from(h).get("__Host-ur_auth_csrf"); ckh = f"__Host-ur_auth_csrf={ck[0]}" if ck else ""
    csrf = re.search(r'name="csrf" value="([^"]*)"', b).group(1)
    st, h, b = req("/account/delete", "POST", cookie=jar(AGE, sd, ckh), data={"csrf": csrf})
    check("delete without confirm=yes -> nothing deleted", st == 303 and n(f"SELECT COUNT(*) FROM users WHERE id='{uid}'") == 1)
    st, h, b = req("/account/delete", "POST", cookie=jar(AGE, sd, ckh), data={"csrf": csrf, "confirm": "yes"})
    _, clr = session_of(h)
    gone = [n(f"SELECT COUNT(*) FROM users WHERE id='{uid}'"), n(f"SELECT COUNT(*) FROM sessions WHERE user_id='{uid}'"), n(f"SELECT COUNT(*) FROM watches WHERE user_id='{uid}'"),
            n(f"SELECT COUNT(*) FROM alerts WHERE user_id='{uid}'"), n("SELECT COUNT(*) FROM auth_tokens WHERE email='delete.me@example.com'")]
    check("delete -> user, sessions, watches, alerts, pending links all gone immediately; cookie cleared", st == 200 and gone == [0, 0, 0, 0, 0] and clr and "Max-Age=0" in clr, gone)
    fb = d1("SELECT user_id, message FROM feedback WHERE message='keep this message'")
    check("feedback kept but unlinked", fb and fb[0]["user_id"] is None)
    check("other users untouched", n("SELECT COUNT(*) FROM users WHERE email='many@example.com'") == 1)

    print(" next sanitizing + analytics")
    d1("DELETE FROM auth_hits")
    for bad in ["//evil.example/x", "https://evil.example", "/\\evil", "/gate?next=x", "/auth/verify?t=x"]:
        st, _, b, _, _, _, nxt = signin_form(next_=bad)
        check(f"next {bad!r} -> /account", nxt == "/account", nxt)
    with open(LOG, errors="replace") as fh: before = fh.read().count("[ae-test]")
    for p in ["/signin", "/account", f"/auth/verify?t={tok}"]: req(p, cookie=AGE)
    req("/signin", cookie=AGE)
    time.sleep(1)
    with open(LOG, errors="replace") as fh: after = fh.read().count("[ae-test]")
    req("/", cookie=AGE); time.sleep(1)
    with open(LOG, errors="replace") as fh: after_home = fh.read().count("[ae-test]")
    check("auth pages are never counted in analytics (home still is)", after == before and after_home == after + 1, f"{before} {after} {after_home}")
    stop()

def phase_b():
    print("phase b: rate limits, global sign-in budget, verify limit, retention purges")
    start(FULL)
    d1("DELETE FROM auth_hits"); d1("DELETE FROM mail_log"); d1("DELETE FROM auth_tokens")
    pos = log_size()
    for i in range(6): request_link(f"ip{i}@example.com", ip="203.0.113.5", wait=2.1)
    time.sleep(2)
    check("per IP: 5 links/hour (6th not sent)", n("SELECT COUNT(*) FROM mail_log WHERE kind='signin' AND ok=1") == 5 and len(mails_since(pos, 2)) == 5)
    d1("DELETE FROM auth_hits"); d1("DELETE FROM mail_log")
    for i in range(4): request_link("same@example.com", ip=f"203.0.113.{20+i}", wait=2.1)
    time.sleep(2)
    check("per email: 3 links/hour (4th not sent)", n("SELECT COUNT(*) FROM mail_log WHERE kind='signin' AND ok=1") == 3)
    d1("DELETE FROM mail_log")
    # day limits: hits 2 h old don't count for the hour but do for the day
    d1("UPDATE auth_hits SET at = at - 7200000")
    for i in range(3): request_link("same@example.com", ip=f"203.0.113.{30+i}", wait=2.1)
    time.sleep(2)
    check("per email: 6 links/day (3 more after an hour, then blocked)", n("SELECT COUNT(*) FROM mail_log WHERE kind='signin' AND ok=1") == 2, n("SELECT COUNT(*) FROM mail_log WHERE kind='signin' AND ok=1"))
    d1("DELETE FROM auth_hits"); d1("DELETE FROM mail_log")
    ipk = None
    request_link("probe@example.com", ip="203.0.113.77"); time.sleep(1.5)
    ipk = d1("SELECT key_hash FROM auth_hits WHERE kind='ip' LIMIT 1")[0]["key_hash"]
    d1("INSERT INTO auth_hits (kind, key_hash, at) SELECT 'ip', '" + ipk + "', (CAST(strftime('%s','now') AS INTEGER) - 7200) * 1000 FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<19) SELECT x FROM c)")
    d1("DELETE FROM mail_log")
    request_link("fresh@example.com", ip="203.0.113.77"); time.sleep(1.5)
    check("per IP: 20 links/day", n("SELECT COUNT(*) FROM mail_log WHERE kind='signin' AND ok=1") == 0)
    print(" global sign-in budget (40/day) + site-wide 190 stop")
    d1("DELETE FROM auth_hits"); d1("DELETE FROM mail_log")
    day = d1("SELECT date('now','-7 hours') AS d")[0]["d"]   # MST Utah day (tests run Nov-Mar)
    d1("INSERT INTO mail_log (at, day, kind, ok, detail) SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), '" + day + "', 'signin', 1, 'filler' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<40) SELECT x FROM c)")
    pos = log_size()
    st, _, b = request_link("global@example.com", ip="203.0.113.90"); time.sleep(2)
    check("40 sign-in emails today -> no send, same page, suppression logged", st == 200 and "Check your email" in b and not mails_since(pos, 1)
          and n("SELECT COUNT(*) FROM mail_log WHERE ok=0 AND detail LIKE 'suppressed%'") == 1 and n("SELECT COUNT(*) FROM auth_tokens WHERE email='global@example.com'") == 0)
    d1("DELETE FROM mail_log"); d1("DELETE FROM auth_hits")
    d1("INSERT INTO mail_log (at, day, kind, ok, detail) SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), '" + day + "', 'alert', 1, 'filler' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<120) SELECT x FROM c)")
    d1("INSERT INTO feedback_mail_log (at, day, kind, feedback_id, ok, detail) SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), '" + day + "', 'notice', NULL, 1, 'filler' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<30) SELECT x FROM c)")
    pos = log_size()
    st, _, b = request_link("crowd@example.com", ip="203.0.113.91"); time.sleep(2)
    check("alerts 120 + feedback 30 already sent -> sign-in still sends (never crowded out)", len(mails_since(pos, 2)) == 1)
    d1("INSERT INTO mail_log (at, day, kind, ok, detail) SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), '" + day + "', 'signin', 1, 'filler' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<39) SELECT x FROM c)")
    pos = log_size(); d1("DELETE FROM auth_hits")
    request_link("stop@example.com", ip="203.0.113.92"); time.sleep(2)
    check("190 total today -> hard stop, nothing sent", not mails_since(pos, 1) and n("SELECT (SELECT COUNT(*) FROM mail_log WHERE day='" + day + "' AND ok=1) + (SELECT COUNT(*) FROM feedback_mail_log WHERE day='" + day + "' AND ok=1)") == 190)
    d1("DELETE FROM mail_log"); d1("DELETE FROM feedback_mail_log"); d1("DELETE FROM auth_hits")

    print(" verify attempt limit")
    codes = [req(f"/auth/verify?t={'A'*43}", cookie=AGE, ip="203.0.113.99")[0] for _ in range(21)]
    check("bad verify attempts: 20/IP/hour, then 429", codes[:20].count(400) == 20 and codes[20] == 429, codes)
    check("other IPs unaffected", req(f"/auth/verify?t={'A'*43}", cookie=AGE, ip="203.0.113.100")[0] == 400)

    print(" retention purges")
    d1("DELETE FROM auth_hits")
    d1("INSERT INTO auth_tokens (token_hash, email, created_at, expires_at) VALUES ('old-tok', 'o@example.com', strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 hours'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours'))")
    d1("INSERT INTO auth_tokens (token_hash, email, created_at, expires_at) VALUES ('new-tok', 'o@example.com', strftime('%Y-%m-%dT%H:%M:%fZ','now','-23 hours'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-23 hours'))")
    d1("INSERT INTO auth_hits (kind, key_hash, at) VALUES ('ip', 'oldhit', (CAST(strftime('%s','now') AS INTEGER) - 90000) * 1000)")
    d1("INSERT INTO users (id, email, created_at, last_signin_at) VALUES ('u-inactive', 'gone@example.com', '2025-01-01T00:00:00Z', '2025-10-01T00:00:00Z'), ('u-watching', 'keep@example.com', '2025-01-01T00:00:00Z', '2025-10-01T00:00:00Z'), ('u-recent', 'recent@example.com', '2025-01-01T00:00:00Z', strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 days'))")
    d1("INSERT INTO products (sku, name) VALUES ('012345','TEST BOURBON') ON CONFLICT DO NOTHING")
    d1("INSERT INTO watches (user_id, kind, criteria_json, active) VALUES ('u-watching', 'product', '{}', 1), ('u-inactive', 'product', '{}', 0)")
    d1("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ('exp-sess', 'u-recent', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')")
    d1("INSERT INTO alerts (user_id, channel, status, created_at) VALUES ('u-recent', 'email', 'sent', strftime('%Y-%m-%dT%H:%M:%fZ','now','-91 days')), ('u-recent', 'email', 'sent', strftime('%Y-%m-%dT%H:%M:%fZ','now','-89 days'))")
    request_link("trigger@example.com", ip="203.0.113.120"); time.sleep(2.5)
    check("links older than 24 h purged (newer kept)", n("SELECT COUNT(*) FROM auth_tokens WHERE token_hash='old-tok'") == 0 and n("SELECT COUNT(*) FROM auth_tokens WHERE token_hash='new-tok'") == 1)
    check("rate-limit hits older than 24 h purged", n("SELECT COUNT(*) FROM auth_hits WHERE key_hash='oldhit'") == 0)
    check("expired sessions purged", n("SELECT COUNT(*) FROM sessions WHERE id_hash='exp-sess'") == 0)
    check("alert rows older than 90 days purged (89-day kept)", n("SELECT COUNT(*) FROM alerts WHERE user_id='u-recent'") == 1)
    check("inactive 12 months + no active watches -> account deleted (incl. its inactive watch)", n("SELECT COUNT(*) FROM users WHERE id='u-inactive'") == 0 and n("SELECT COUNT(*) FROM watches WHERE user_id='u-inactive'") == 0)
    check("inactive but has an active watch -> kept; signed in within 12 months -> kept", n("SELECT COUNT(*) FROM users WHERE id IN ('u-watching','u-recent')") == 2)
    stop()

def phase_c():
    print("phase c: not configured -> fail closed; mail failure")
    start({"UR_FEEDBACK_BOT_TOKEN": TOKEN})
    st, _, b, ck, csrf, ft, nxt = signin_form()
    check("no Turnstile keys: form renders with 'unavailable', button disabled", st == 200 and "temporarily unavailable" in b and "disabled" in b)
    st, _, b = req("/signin", "POST", cookie=jar(AGE, ck), data={"csrf": csrf, "ft": ft, "email": "a@example.com", "agree": "yes", "cf-turnstile-response": "pass-token"})
    check("no Turnstile keys: POST 503, nothing stored or sent", st == 503 and n("SELECT COUNT(*) FROM auth_tokens WHERE email='a@example.com'") == 0)
    stop()
    start({**FULL, "FEEDBACK_TEST_EMAIL_FAIL": "1"})
    d1("DELETE FROM auth_hits"); d1("DELETE FROM mail_log")
    st, _, b = request_link("fail@example.com", ip="203.0.113.150"); time.sleep(2)
    lg = d1("SELECT ok, detail FROM mail_log")
    check("send failure: same page, logged ok=0 (not counted), link deleted", st == 200 and "Check your email" in b and lg and lg[0]["ok"] == 0 and "E_TEST" in lg[0]["detail"] and n("SELECT COUNT(*) FROM auth_tokens WHERE email='fail@example.com'") == 0, lg)
    stop()

def main():
    phases = sys.argv[1:] or ["a", "b", "c"]
    shutil.rmtree(PERSIST, ignore_errors=True); open(LOG, "w").close()
    r = sh(NPX + ["d1", "migrations", "apply", "utah-remedy-db", "--local", "--persist-to", PERSIST]); assert r.returncode == 0, r.stdout[-500:] + r.stderr[-500:]
    d1("INSERT INTO products (sku, name, category) VALUES ('012345','TEST BOURBON SMALL BATCH','WHISKEY - BOURBON & TENNESSEE')")
    srv = HTTPServer(("127.0.0.1", 9913), TS); threading.Thread(target=srv.serve_forever, daemon=True).start()
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
