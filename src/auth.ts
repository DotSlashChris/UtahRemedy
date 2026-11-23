/**
 * Email magic-link sign-in (watches design step 1, docs/WATCHES-DESIGN.md section 2; owner-approved t99s544, 2026-11-21).
 * D1 + Email Sending only: never touches DABS, the fetchers, crons, caps or analytics counting (auth pages are never counted).
 * Every route here sits behind the 21+ gate (src/index.ts) and answers with Cache-Control: no-store.
 *
 *   GET  /signin[?next=/path]   email + required "21 or older and agree" box + Turnstile + CSRF cookie + timed form token + honeypot
 *   POST /signin                CSRF -> Turnstile (fail closed) -> honeypot -> form token (>= 2 s, < 1 h) -> field checks ->
 *                               ALWAYS the same "check your email" page. Limits, token and email happen after the response
 *                               (ctx.waitUntil), so new/existing/limited addresses look and time the same (no enumeration).
 *   GET  /auth/verify?t=...     "Finish signing in" button page. Does NOT consume the token (mail scanners pre-fetch GETs).
 *   POST /auth/verify           single-use: one UPDATE ... WHERE used_at IS NULL AND expires_at > now -> user (first time) -> session
 *   GET  /account               minimal signed-in page (email, member since, sign out, sign out everywhere, delete)
 *   POST /signout               this session; POST /account/signout-all every session of the user
 *   GET/POST /account/delete    confirm page; POST deletes sessions, watches, alerts, pending links and the user row in one batch
 * Tokens/sessions: 32 random bytes, only SHA-256 stored. Link 15 min, single use. Session cookie __Host-ur_session, 30 days
 * absolute, HttpOnly, Secure, SameSite=Lax; max 5 sessions per user. Limits (salted HMAC hashes only, purged after 24 h):
 * per IP 5/h + 20/day, per email 3/h + 6/day, bad verify 20/IP/h; site-wide sign-in mail 40/day via src/mail-budget.ts.
 * Retention purges run after sign-in requests: links/hits 24 h, expired sessions, alert rows 90 days, accounts inactive 12 months
 * with no active watches.
 */
import { esc, fmtMT, layout } from "./web/pages";
import {
  EMAIL_RE, FROM_ADDR, b64url, botReady, clientIp, hex, hmac, htmlResponse, isLocalTest, oneLine, parseCookies, safeEqual,
  turnstileReady, turnstileVerify, TURNSTILE_ORIGIN, type FeedbackEnv,
} from "./feedback";
import { logSuppressed, reserveMail, settleMail } from "./mail-budget";

export type AuthEnv = FeedbackEnv;

export const AUTH_PATHS = new Set(["/signin", "/auth/verify", "/auth/used", "/signout", "/account", "/account/signout-all", "/account/delete"]);
export const TERMS_VERSION = "2026-11-21";
export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_S = 30 * 86400;
export const MAX_SESSIONS = 5;
export const AUTH_LIMITS = { ipHour: 5, ipDay: 20, emailHour: 3, emailDay: 6, verifyHour: 20 };
export const FORM_MIN_AGE_MS = 2000;
export const FORM_MAX_AGE_MS = 3600_000;
const HIT_KEEP_MS = 86400_000;
const TOKEN_KEEP_MS = 86400_000;
const ALERT_KEEP_DAYS = 90;
const INACTIVE_DAYS = 365;
export const SESSION_COOKIE = "__Host-ur_session";
const CSRF_COOKIE = "__Host-ur_auth_csrf";
const ORIGIN = "https://utahremedy.com";
const SENT_TEXT = "If that address can receive a link, we&rsquo;ve sent one. It works once and expires in 15 minutes.";
const enc = new TextEncoder();

// ---------------------------------------------------------------- small helpers
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
async function sha256(s: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
export const normEmail = (s: string) => oneLine(s).trim().toLowerCase().slice(0, 254);
/** Same-origin relative paths only; never back into the gate or the auth flow itself. */
export function safeNext(next: string | null | undefined, dflt = "/account"): string {
  const n = (next ?? "").trim();
  if (!n || n.length > 300 || !n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\") || /[\u0000-\u001f]/.test(n)) return dflt;
  if (/^\/(gate|not-eligible|auth\/|signin|signout)/.test(n)) return dflt;
  return n;
}
const sessionCookie = (v: string, maxAge: number) => `${SESSION_COOKIE}=${v}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const csrfCookie = (v: string) => `${CSRF_COOKIE}=${v}; Max-Age=7200; Path=/; Secure; HttpOnly; SameSite=Strict`;
const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const page = (title: string, inner: string, status = 200, extra: Record<string, string> = {}) =>
  htmlResponse(layout(title, `<section class="wrap page"><div class="panel">${inner}</div></section>`, { noindex: true }), status, { ...noStore, ...extra });
const redirect = (to: string, extra: [string, string][] = []) => {
  const h = new Headers({ Location: to, ...noStore }); for (const [k, v] of extra) h.append(k, v);
  return new Response(null, { status: 303, headers: h });
};

async function csrfFor(request: Request): Promise<{ csrf: string; set: string | null }> {
  const c = parseCookies(request.headers.get("Cookie"))[CSRF_COOKIE];
  if (c && /^[A-Za-z0-9_-]{22}$/.test(c)) return { csrf: c, set: null };
  const csrf = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { csrf, set: csrfCookie(csrf) };
}
async function csrfOk(request: Request, fd: FormData | null): Promise<boolean> {
  const c = parseCookies(request.headers.get("Cookie"))[CSRF_COOKIE] ?? "";
  const f = fd?.get("csrf");
  return !!c && typeof f === "string" && !!f && (await safeEqual(c, f));
}
async function formToken(env: AuthEnv, csrf: string, t = Date.now()): Promise<string> {
  const body = `${t}.${csrf.slice(0, 12)}`;
  return `${body}.${b64url(await hmac(env.UR_FEEDBACK_BOT_TOKEN!, "ur-auth-form-v1", body))}`;
}
async function checkFormToken(env: AuthEnv, tok: string, csrf: string): Promise<number | "expired" | null> {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{20,64})$/.exec(tok || "");
  if (!m || !env.UR_FEEDBACK_BOT_TOKEN) return null;
  const want = b64url(await hmac(env.UR_FEEDBACK_BOT_TOKEN, "ur-auth-form-v1", `${m[1]}.${m[2]}`));
  if (!(await safeEqual(want, m[3])) || m[2] !== csrf.slice(0, 12)) return null;
  const t = Number(m[1]);
  return Date.now() - t > FORM_MAX_AGE_MS ? "expired" : t;
}
const keyHash = async (env: AuthEnv, label: string, v: string) => hex(await hmac(env.UR_FEEDBACK_BOT_TOKEN!, label, v)).slice(0, 32);
async function hits(env: AuthEnv, kind: "ip" | "email" | "verify", key: string, sinceMs: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_hits WHERE kind = ? AND key_hash = ? AND at >= ?").bind(kind, key, sinceMs).first<{ n: number }>();
  return r?.n ?? 0;
}
const addHit = (env: AuthEnv, kind: "ip" | "email" | "verify", key: string) =>
  env.DB.prepare("INSERT INTO auth_hits (kind, key_hash, at) VALUES (?, ?, ?)").bind(kind, key, Date.now());

export const authReady = (env: AuthEnv) => turnstileReady(env) && botReady(env);

// ---------------------------------------------------------------- sessions
export interface Session { idHash: string; userId: string; email: string; userCreated: string; expiresAt: string; lastSeen: string | null }
/** True if the request carries a well-formed session cookie (no D1 read; used only to pick the header link). */
export const hasSessionCookie = (request: Request) => TOKEN_RE.test(parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE] ?? "");
export async function getSession(env: AuthEnv, request: Request): Promise<Session | null> {
  const raw = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE] ?? "";
  if (!TOKEN_RE.test(raw)) return null;
  const idHash = await sha256(raw);
  const r = await env.DB.prepare(
    "SELECT s.user_id, s.expires_at, s.last_seen_at, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?",
  ).bind(idHash, nowIso()).first<{ user_id: string; expires_at: string; last_seen_at: string | null; email: string; created_at: string }>();
  if (!r) return null;
  return { idHash, userId: r.user_id, email: r.email, userCreated: r.created_at, expiresAt: r.expires_at, lastSeen: r.last_seen_at };
}

// ---------------------------------------------------------------- retention
export async function purgeAuth(env: AuthEnv, ms = Date.now()): Promise<void> {
  const inactive = `COALESCE(last_signin_at, created_at) < ?1 AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.user_id = users.id AND w.active = 1)`;
  const cut = nowIso(ms - INACTIVE_DAYS * 86400_000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_tokens WHERE created_at < ?").bind(nowIso(ms - TOKEN_KEEP_MS)),
    env.DB.prepare("DELETE FROM auth_hits WHERE at < ?").bind(ms - HIT_KEEP_MS),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso(ms)),
    env.DB.prepare("DELETE FROM alerts WHERE created_at < ?").bind(nowIso(ms - ALERT_KEEP_DAYS * 86400_000)),
    env.DB.prepare(`DELETE FROM alerts WHERE user_id IN (SELECT id FROM users WHERE ${inactive})`).bind(cut),
    env.DB.prepare(`DELETE FROM watches WHERE user_id IN (SELECT id FROM users WHERE ${inactive})`).bind(cut),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE ${inactive})`).bind(cut),
    env.DB.prepare(`UPDATE feedback SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE ${inactive})`).bind(cut),
    env.DB.prepare(`DELETE FROM users WHERE ${inactive}`).bind(cut),
  ]);
}

/** Everything about one user, in one D1 batch (transaction). Feedback text stays, unlinked. */
export function deleteUserStatements(env: AuthEnv, userId: string, email: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM alerts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM watches WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM auth_tokens WHERE email = ?").bind(email),
    env.DB.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ];
}

// ---------------------------------------------------------------- email
export function signinEmailText(link: string): string {
  return [
    "Here is your Utah Remedy sign-in link:",
    "",
    link,
    "",
    "It works once and expires in 15 minutes. When the page opens, choose \"Finish signing in\".",
    "",
    "Didn't ask for this? You can ignore this email. No account is created unless the link is used.",
    "",
    "Counts come from public DABS data, can lag, and aren't guaranteed. Verify with the store before you travel.",
    "Utah Remedy is an independent service, not affiliated with or endorsed by the Utah Department of Alcoholic Beverage",
    "Services (DABS). For adults 21 and older.",
    "",
  ].join("\n");
}

/** After the response: limits -> shared budget -> token -> send. Never reveals anything to the requester. */
async function issueLink(env: AuthEnv, email: string, next: string, ip: string, origin: string): Promise<string> {
  const now = Date.now();
  const [ipH, emH] = await Promise.all([keyHash(env, "ur-auth-ip-v1", ip), keyHash(env, "ur-auth-email-v1", email)]);
  const [ipHr, ipDay, emHr, emDay] = await Promise.all([
    hits(env, "ip", ipH, now - 3600_000), hits(env, "ip", ipH, now - 86400_000),
    hits(env, "email", emH, now - 3600_000), hits(env, "email", emH, now - 86400_000),
  ]);
  await env.DB.batch([addHit(env, "ip", ipH), addHit(env, "email", emH)]);
  let why = "";
  if (ipHr >= AUTH_LIMITS.ipHour || ipDay >= AUTH_LIMITS.ipDay) why = "rate_ip";
  else if (emHr >= AUTH_LIMITS.emailHour || emDay >= AUTH_LIMITS.emailDay) why = "rate_email";
  if (why) { console.log(`[auth] link not sent (${why})`); return why; }
  if (!env.EMAIL) { await logSuppressed(env, "signin", "no EMAIL binding"); return "no_binding"; }
  const rid = await reserveMail(env, "signin");
  if (rid === null) { await logSuppressed(env, "signin", "suppressed: sign-in budget or site-wide stop"); console.log("[auth] link not sent (budget)"); return "budget"; }
  const token = randomToken();
  const th = await sha256(token);
  await env.DB.prepare("INSERT INTO auth_tokens (token_hash, email, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(th, email, next, nowIso(now), nowIso(now + LINK_TTL_MS)).run();
  try {
    if (isLocalTest(env) && env.FEEDBACK_TEST_EMAIL_FAIL === "1") throw Object.assign(new Error("test-mode forced failure"), { code: "E_TEST" });
    const r = await env.EMAIL.send({
      to: email, from: { email: FROM_ADDR, name: "Utah Remedy" }, replyTo: FROM_ADDR,
      subject: "Your Utah Remedy sign-in link", text: signinEmailText(`${origin}/auth/verify?t=${token}`),
    });
    await settleMail(env, "mail_log", rid, true, `sent${r?.messageId ? ` ${r.messageId}` : ""}`);
    return "sent";
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const detail = `error ${err.code ?? ""} ${String(err.message ?? e)}`.replace(/\s+/g, " ").trim();
    console.error(`[auth] sign-in link not sent: ${detail.slice(0, 200)}`);
    await settleMail(env, "mail_log", rid, false, detail);
    await env.DB.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").bind(th).run();
    return "error";
  }
}

// ---------------------------------------------------------------- pages
function signinHtml(env: AuthEnv, csrf: string, ft: string, next: string, error: string | null, email = ""): string {
  const ts = turnstileReady(env) ? env.TURNSTILE_SITE_KEY!.trim() : "";
  const unavailable = !authReady(env);
  return layout("Sign in", `<section class="wrap page">
  <h1>Sign in</h1>
  <p class="narrow">Enter your email and we&rsquo;ll send you a one-time sign-in link. There are no passwords. The link works once and expires in 15 minutes.</p>
  ${unavailable ? `<p class="status status-warn" role="status">Sign-in is temporarily unavailable. Please check back soon.</p>` : ""}
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/signin" class="card fb">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="ft" value="${esc(ft)}">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="si-email">Email</label>
    <input id="si-email" type="email" name="email" required maxlength="254" value="${esc(email)}" autocomplete="email" placeholder="you@example.com">
    <label class="check"><input type="checkbox" name="agree" value="yes" required> I&rsquo;m 21 or older and agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</label>
    <div class="hp" aria-hidden="true"><label for="si-website">Website</label><input id="si-website" type="text" name="website" tabindex="-1" autocomplete="off"></div>
    ${ts ? `<div class="cf-turnstile fb-turnstile" data-sitekey="${esc(ts)}"></div><script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>` : ""}
    <p class="fb-send"><button class="btn" type="submit"${unavailable ? " disabled" : ""}>Email me a sign-in link</button></p>
    <p class="hint">We use your email only for sign-in links. See our <a href="/privacy">Privacy Policy</a>.</p>
  </form>
</section>`, { noindex: true, description: "Sign in to Utah Remedy with a one-time email link." });
}
async function renderSignin(env: AuthEnv, request: Request, next: string, error: string | null, status: number, email = ""): Promise<Response> {
  const { csrf, set } = await csrfFor(request);
  const ft = botReady(env) ? await formToken(env, csrf) : "";
  return htmlResponse(signinHtml(env, csrf, ft, next, error, email), status, { ...noStore, ...(set ? { "Set-Cookie": set } : {}) });
}
const sentPage = () => page("Check your email", `<h1>Check your email</h1><p>${SENT_TEXT}</p>
  <p class="small muted">Didn&rsquo;t get it? Check spam, or wait a minute and try again. Links stop arriving after a few tries in a short time.</p>
  <p><a href="/">Utah Remedy Home</a></p>`);
const badLinkPage = (status = 400) => page("Link not valid", `<h1>This link isn&rsquo;t valid</h1>
  <p>Sign-in links work once and expire after 15 minutes. Please request a new one.</p><p><a href="/signin">Get a new sign-in link</a></p>`, status, { "Referrer-Policy": "no-referrer" });
/** A link that was really issued and already used (e.g. a double-click on "Finish signing in" or reopening the email). Shown only to
 *  someone holding the real token; grants nothing: /account still checks the session cookie. */
const usedLinkPage = () => page("Link already used", `<h1>This link was already used</h1>
  <p>Sign-in links work once. If you just chose &ldquo;Finish signing in&rdquo;, you&rsquo;re already signed in on this device.</p>
  <p><a href="/account">Go to your account</a> &middot; <a href="/signin">Get a new sign-in link</a></p>`, 400, { "Referrer-Policy": "no-referrer" });
const tooManyPage = () => page("Too many tries", `<h1>Too many tries</h1><p>Please wait a while and try again.</p><p><a href="/">Utah Remedy Home</a></p>`, 429, { "Referrer-Policy": "no-referrer" });

async function accountHtml(request: Request, s: Session): Promise<Response> {
  const { csrf, set } = await csrfFor(request);
  const hid = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  return htmlResponse(layout("Account", `<section class="wrap page">
  <h1>Your account</h1>
  <div class="card fb">
    <p>Signed in as <strong>${esc(s.email)}</strong></p>
    <p class="small muted">Account created ${esc(fmtMT(s.userCreated))}. This sign-in lasts until ${esc(fmtMT(s.expiresAt))} or until you sign out.</p>
    <form method="post" action="/signout" class="fb-send">${hid}<button class="btn ghost" type="submit">Sign out</button></form>
    <form method="post" action="/account/signout-all" class="fb-send">${hid}<button class="btn ghost" type="submit">Sign out everywhere</button></form>
    <p class="hint">&ldquo;Sign out everywhere&rdquo; ends every signed-in session on every device.</p>
    <h2>Delete my account</h2>
    <p class="small">This removes your email, watches, alert records and sessions right away. <a href="/account/delete">Delete my account and data</a></p>
  </div>
</section>`, { noindex: true }), 200, { ...noStore, ...(set ? { "Set-Cookie": set } : {}) });
}
async function deleteConfirmHtml(request: Request, s: Session): Promise<Response> {
  const { csrf, set } = await csrfFor(request);
  return htmlResponse(layout("Delete account", `<section class="wrap page"><div class="panel">
  <h1>Delete your account?</h1>
  <p>This deletes the account for <strong>${esc(s.email)}</strong>: your email, watches, alert records and every signed-in session, right away. It can&rsquo;t be undone. Any feedback you sent stays, but is no longer linked to you.</p>
  <form method="post" action="/account/delete" class="fb-send"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="confirm" value="yes">
    <button class="btn" type="submit">Delete my account and data</button></form>
  <p><a href="/account">Cancel</a></p>
</div></section>`, { noindex: true }), 200, { ...noStore, ...(set ? { "Set-Cookie": set } : {}) });
}

// ---------------------------------------------------------------- router
export async function handleAuth(request: Request, env: AuthEnv, ctx: ExecutionContext, path: string, url: URL): Promise<Response> {
  const m = request.method;
  if (path === "/signin") return m === "POST" ? signinPost(request, env, ctx, url) : m === "GET" || m === "HEAD" ? signinGet(request, env, url) : notAllowed();
  if (path === "/auth/verify") return m === "POST" ? verifyPost(request, env, ctx) : m === "GET" || m === "HEAD" ? verifyGet(request, env, url) : notAllowed();
  if (path === "/auth/used") return m === "GET" || m === "HEAD" ? usedGet(request, env, url) : notAllowed();
  if (path === "/signout") return m === "POST" ? signout(request, env) : redirect("/account");
  if (path === "/account") return m === "GET" || m === "HEAD" ? accountGet(request, env, ctx) : notAllowed();
  if (path === "/account/signout-all") return m === "POST" ? signoutAll(request, env) : redirect("/account");
  if (path === "/account/delete") return m === "POST" ? deletePost(request, env) : m === "GET" || m === "HEAD" ? deleteGet(request, env) : notAllowed();
  return page("Not found", "<h1>Not found</h1>", 404);
}
const notAllowed = () => new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, POST", ...noStore } });

async function signinGet(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  const next = safeNext(url.searchParams.get("next"));
  if (await getSession(env, request)) return redirect(next);
  return renderSignin(env, request, next, null, 200);
}

async function signinPost(request: Request, env: AuthEnv, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (!authReady(env)) return page("Sign-in unavailable", `<h1>Sign-in is temporarily unavailable</h1><p>Nothing was sent. Please try again soon.</p>`, 503, { "Retry-After": "3600" });
  const fd = await request.formData().catch(() => null);
  const g = (k: string) => { const v = fd?.get(k); return typeof v === "string" ? v : ""; };
  const next = safeNext(g("next"));
  const email = normEmail(g("email"));
  const ip = clientIp(request, env);
  // 1. CSRF
  if (!(await csrfOk(request, fd))) return renderSignin(env, request, next, "Form expired, please try again.", 400, email);
  // 2. Turnstile (required; unreachable = refused)
  const ts = await turnstileVerify(env, g("cf-turnstile-response"), ip);
  if (ts === null) return renderSignin(env, request, next, "We couldn't reach our security check just now. Please try again in a minute.", 503, email);
  if (!ts) return renderSignin(env, request, next, "We could not verify you are human. Please try again.", 400, email);
  // 3. Honeypot / 4. timed form token: dropped quietly with the same page as a real request.
  if (g("website").trim()) return sentPage();
  const issued = await checkFormToken(env, g("ft"), g("csrf"));
  if (issued === "expired") return renderSignin(env, request, next, "This form timed out. Please try again.", 400, email);
  if (issued === null || Date.now() - issued < FORM_MIN_AGE_MS) return sentPage();
  // 5. Field checks (user errors; say nothing about whether an account exists)
  if (!email || !EMAIL_RE.test(email)) return renderSignin(env, request, next, "Enter a valid email address.", 400, email);
  if (g("agree") !== "yes") return renderSignin(env, request, next, "Please confirm you're 21 or older and agree to the Terms and Privacy Policy.", 400, email);
  // 6. Everything else after the response: identical page and timing for every address.
  const origin = isLocalTest(env) ? url.origin : ORIGIN;
  ctx.waitUntil((async () => {
    try { await issueLink(env, email, next, ip, origin); } catch (e) { console.error(`[auth] issue failed: ${String(e).slice(0, 200)}`); }
    try { await purgeAuth(env); } catch (e) { console.error(`[auth] purge failed: ${String(e).slice(0, 200)}`); }
  })());
  return sentPage();
}

async function verifyLimited(env: AuthEnv, ipH: string): Promise<boolean> {
  return (await hits(env, "verify", ipH, Date.now() - 3600_000)) >= AUTH_LIMITS.verifyHour;
}

/**
 * A link that can't be used (any more). Never creates a session. In order:
 *  - the browser already holds a valid session (e.g. the first of two quick POSTs signed it in, or the email link is reopened
 *    after signing in): go where the link was going, as /signin does for signed-in visitors;
 *  - the token is a real link that was already used: 303 to /auth/used, which continues if the session cookie has landed by then,
 *    else says "already used" plainly (no rate-limit hit);
 *  - otherwise (unknown, malformed or expired): the generic "not valid" page and one bad-verify hit for this IP.
 */
async function deadLink(env: AuthEnv, request: Request, ipH: string, t: string): Promise<Response> {
  const row = TOKEN_RE.test(t)
    ? await env.DB.prepare("SELECT next, used_at FROM auth_tokens WHERE token_hash = ?").bind(await sha256(t)).first<{ next: string | null; used_at: string | null }>()
    : null;
  if (await getSession(env, request)) return redirect(safeNext(row?.next));
  // Used link, no session on this request: hop once through GET /auth/used. On a double-click the 2nd POST leaves the browser before
  // the 1st POST's session cookie lands; by the time this redirect is followed it usually has, so the visitor just continues.
  if (row?.used_at) return redirect(`/auth/used?next=${encodeURIComponent(safeNext(row.next))}`);
  await addHit(env, "verify", ipH).run();
  return badLinkPage();
}

/** After a used link: signed in -> continue to the link's next page silently (owner t102u); otherwise the plain "already used" page.
 *  Grants nothing and reveals nothing (anyone can open it; it never creates a session). */
async function usedGet(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  if (await getSession(env, request)) return redirect(safeNext(url.searchParams.get("next")));
  return usedLinkPage();
}

async function verifyGet(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  if (!botReady(env)) return badLinkPage(503);
  const t = url.searchParams.get("t") ?? "";
  const ipH = await keyHash(env, "ur-auth-verify-v1", clientIp(request, env));
  if (await verifyLimited(env, ipH)) return tooManyPage();
  // Read-only check: a GET never consumes the link (mail scanners and previewers fetch GET links).
  const row = TOKEN_RE.test(t)
    ? await env.DB.prepare("SELECT 1 AS ok FROM auth_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(await sha256(t), nowIso()).first<{ ok: number }>()
    : null;
  if (!row) return deadLink(env, request, ipH, t);
  const { csrf, set } = await csrfFor(request);
  return page("Finish signing in", `<h1>Finish signing in</h1>
  <p>Choose the button to finish signing in to Utah Remedy on this device.</p>
  <form method="post" action="/auth/verify" class="fb-send"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="t" value="${esc(t)}">
    <button class="btn" type="submit">Finish signing in</button></form>
  <p class="small muted">Didn&rsquo;t ask for this? Just close this page. Nothing happens unless you choose the button.</p>`, 200,
  { "Referrer-Policy": "no-referrer", ...(set ? { "Set-Cookie": set } : {}) });
}

async function verifyPost(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
  if (!botReady(env)) return badLinkPage(503);
  const fd = await request.formData().catch(() => null);
  const t = typeof fd?.get("t") === "string" ? String(fd!.get("t")) : "";
  const ipH = await keyHash(env, "ur-auth-verify-v1", clientIp(request, env));
  if (await verifyLimited(env, ipH)) return tooManyPage();
  if (!(await csrfOk(request, fd))) {
    // Form expired: show the button page again (the link is still unused).
    return page("Finish signing in", `<h1>Please try again</h1><p>This page expired. Open the link from your email again.</p>`, 400, { "Referrer-Policy": "no-referrer" });
  }
  if (!TOKEN_RE.test(t)) { await addHit(env, "verify", ipH).run(); return badLinkPage(); }
  const now = Date.now();
  // Single use: only one request can flip used_at from NULL (also covers two concurrent POSTs).
  const tok = await env.DB.prepare("UPDATE auth_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING email, next, created_at")
    .bind(nowIso(now), await sha256(t)).first<{ email: string; next: string | null; created_at: string }>();
  if (!tok) return deadLink(env, request, ipH, t);
  const user = await env.DB.prepare(
    "INSERT INTO users (id, email, age_confirmed_at, terms_version, last_signin_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5) " +
    "ON CONFLICT(email) DO UPDATE SET last_signin_at = excluded.last_signin_at, terms_version = excluded.terms_version, updated_at = excluded.updated_at, " +
    "age_confirmed_at = COALESCE(users.age_confirmed_at, excluded.age_confirmed_at) RETURNING id",
  ).bind(crypto.randomUUID(), tok.email, tok.created_at, TERMS_VERSION, nowIso(now)).first<{ id: string }>();
  const sid = randomToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256(sid), user!.id, nowIso(now), nowIso(now + SESSION_TTL_S * 1000), nowIso(now)),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1 AND id_hash NOT IN (SELECT id_hash FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)")
      .bind(user!.id, MAX_SESSIONS),
  ]);
  ctx.waitUntil(purgeAuth(env).catch((e) => console.error(`[auth] purge failed: ${String(e).slice(0, 200)}`)));
  console.log("[auth] signed in");
  return redirect(safeNext(tok.next), [["Set-Cookie", sessionCookie(sid, SESSION_TTL_S)]]);
}

async function accountGet(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
  const s = await getSession(env, request);
  if (!s) return redirect("/signin?next=%2Faccount", hasSessionCookie(request) ? [["Set-Cookie", sessionCookie("", 0)]] : []);
  const today = nowIso().slice(0, 10);
  if (!s.lastSeen || s.lastSeen.slice(0, 10) !== today) {
    ctx.waitUntil(env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(nowIso(), s.idHash).run().then(() => {}, () => {}));
  }
  return accountHtml(request, s);
}

async function signout(request: Request, env: AuthEnv): Promise<Response> {
  const fd = await request.formData().catch(() => null);
  if (!(await csrfOk(request, fd))) return redirect("/account");
  const raw = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE] ?? "";
  if (TOKEN_RE.test(raw)) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(raw)).run();
  return page("Signed out", `<h1>You&rsquo;re signed out</h1><p><a href="/">Utah Remedy Home</a> &middot; <a href="/signin">Sign in again</a></p>`, 200,
    { "Set-Cookie": sessionCookie("", 0) });
}

async function signoutAll(request: Request, env: AuthEnv): Promise<Response> {
  const fd = await request.formData().catch(() => null);
  if (!(await csrfOk(request, fd))) return redirect("/account");
  const s = await getSession(env, request);
  if (!s) return redirect("/signin?next=%2Faccount", [["Set-Cookie", sessionCookie("", 0)]]);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(s.userId).run();
  return page("Signed out everywhere", `<h1>You&rsquo;re signed out everywhere</h1><p>Every signed-in session for your account has ended, on every device.</p>
  <p><a href="/">Utah Remedy Home</a> &middot; <a href="/signin">Sign in again</a></p>`, 200, { "Set-Cookie": sessionCookie("", 0) });
}

async function deleteGet(request: Request, env: AuthEnv): Promise<Response> {
  const s = await getSession(env, request);
  if (!s) return redirect("/signin?next=%2Faccount");
  return deleteConfirmHtml(request, s);
}

async function deletePost(request: Request, env: AuthEnv): Promise<Response> {
  const fd = await request.formData().catch(() => null);
  if (!(await csrfOk(request, fd)) || fd?.get("confirm") !== "yes") return redirect("/account/delete");
  const s = await getSession(env, request);
  if (!s) return redirect("/signin?next=%2Faccount", [["Set-Cookie", sessionCookie("", 0)]]);
  await env.DB.batch(deleteUserStatements(env, s.userId, s.email));
  console.log("[auth] account deleted");
  return page("Account deleted", `<h1>Your account is deleted</h1><p>We removed your email, watches, alert records and sessions. Thanks for trying Utah Remedy.</p>
  <p><a href="/">Utah Remedy Home</a></p>`, 200, { "Set-Cookie": sessionCookie("", 0) });
}

// ---------------------------------------------------------------- header link
const SKIP_LINK = new Set(["/gate", "/not-eligible"]);
/** Small "Sign in" / "Account" link in the header nav. Picked from cookie presence only (no D1 read on every page). */
export function addAuthLink(res: Response, request: Request, path: string): Response {
  if (!(res.headers.get("Content-Type") || "").includes("text/html") || SKIP_LINK.has(path)) return res;
  const link = hasSessionCookie(request) ? `<a href="/account">Account</a>` : `<a href="/signin">Sign in</a>`;
  return new HTMLRewriter().on("header.site-header nav.nav", { element(el) { el.append(link, { html: true }); } }).transform(res);
}
