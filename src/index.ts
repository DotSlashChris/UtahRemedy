/**
 * Utah Remedy Worker.
 * Serves static assets from ./public and the gated catalog pages (src/web), enforces the 21+ age gate server-side,
 * injects the persistent disclaimer into every HTML page, redirects www -> apex,
 * and exposes /health.
 */

import { runDabsFetch, getSourceStatus, type RunOptions } from "./fetchers/dabs-locator";
import { runSweepTick, sweepStatus } from "./fetchers/sweep";
import { guardStatus, Meter } from "./fetchers/guard";
import { logEvent } from "./fetchers/store";
import { handleWeb } from "./web/router";
import { runCatalogTick, catalogStatus, catalogAutoState, CATALOG_AUTO_KEY } from "./fetchers/catalog-list";
import { runPerstoreTick, perstoreStatus } from "./fetchers/perstore";
import { runCatchupTick, catchupStatus } from "./fetchers/catchup";
import { popularList, popularAdmin, POPULAR_FLAG_KEY } from "./fetchers/popular";
import { track, pageInfo, stats } from "./analytics";
import { handleFeedback, handleFeedbackBot, feedbackCsp } from "./feedback";
import { addSiteLinks, tipPage } from "./tip";
import { AUTH_PATHS, addAuthLink, handleAuth } from "./auth";
import { type Job, inLocalWindow, localTime, LOCAL_WINDOWS, nextLocalOpen, SCHEDULE_TZ } from "./schedule";

/**
 * The ONLY cron expressions this Worker acts on. Anything else is rejected and logged. Keep in sync with wrangler.jsonc.
 * Since 2026-11-13 (owner-approved t80u) every window is pinned to America/Denver local time (src/schedule.ts): each
 * expression covers the union of the window's MST and MDT UTC hours, and scheduled() runs the job only when the tick's
 * local time is inside LOCAL_WINDOWS[job]; any other tick is a pure no-op (no D1/KV, no lock, no run, no DABS request).
 * Before 2026-11-13: "30-55/5 7" + "*\/5 8-10" sweep, "*\/5 11-17" per-store, "30 18 2-8" catalog, "*\/5 20-22" catch-up
 * (UTC-fixed = the same MST clock times, shifting +1 h in MDT). Older history: DECISIONS.md.
 */
export const EXPECTED_CRONS: Record<string, Job> = {
  // Sweep 00:30-03:55 local, hard stop at the 03:55 local tick: 06:30-10:55 UTC covers 06:30-09:55 (MDT) and 07:30-10:55 (MST).
  // Two expressions because one cron can't start at :30. The first tick is never at 00:00 local, the Utah-day boundary.
  "30-55/5 6 * * *": "sweep",
  "*/5 7-10 * * *": "sweep",
  // Per-store 04:00-10:55 local (B1 then popular-100; acts only after that day's sweep completed): 10:00-17:55 UTC covers
  // 10:00-16:55 (MDT) and 11:00-17:55 (MST). 10:xx UTC is also a sweep hour: the local gate gives it to exactly one job.
  "*/5 10-17 * * *": "perstore",
  // Monthly DABS Product List import 11:30 local on days 2-8: 17:30 UTC (MDT) / 18:30 UTC (MST). Cron path PAUSED unless KV
  // catalog:v1:auto = "on" (2026-11-03). 17:30 UTC also fires the per-store expression; the local gate picks one.
  "30 17,18 2-8 * *": "catalog",
  // Same-day catch-up of an incomplete nightly sweep (2026-11-13) 13:00-15:55 local, hard stop at the 15:55 local tick:
  // 19:00-22:55 UTC covers 19:00-21:55 (MDT) and 20:00-22:55 (MST). See src/fetchers/catchup.ts.
  "*/5 19-22 * * *": "catchup",   // must equal CATCHUP_CRON (catchup.ts)
};

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  UTAH_REMEDY_CACHE: KVNamespace;
  APP_VERSION: string;
  GIT_COMMIT: string;
  /** Secret (wrangler secret put ADMIN_TOKEN). If unset, internal endpoints are disabled. */
  ADMIN_TOKEN?: string;
  /** "true" to allow any DABS fetching (cron or admin). Kill switch KV key dabs:v1:kill=1 also stops it. */
  FETCHER_ENABLED?: string;
  /** Local mock testing only; production uses the real DABS URL. Test overrides are ignored unless this is set. */
  DABS_BASE_URL?: string;
  DABS_TEST_MIN_GAP_MS?: string;
  DABS_TEST_LOCK_TTL_MS?: string;
  DABS_TEST_RETRY_DELAY_MS?: string;
  DABS_TEST_LAST_TICK?: string;
  /** Local mock testing only (ignored unless DABS_BASE_URL is a non-DABS host): product-list page URL. */
  DABS_CATALOG_URL?: string;
  /** Per-store refresh mode: "allocated" = option B1 on; anything else = off. Limited (B2) has no setting: not implemented. */
  PERSTORE_REFRESH?: string;
  /** Workers Rate Limiting binding for search/detail cache misses. */
  SEARCH_LIMITER?: RateLimit;
  /** Workers Analytics Engine dataset utah_remedy_events (anonymous visit counting; src/analytics.ts). */
  EVENTS?: AnalyticsEngineDataset;
  /** Secret: Account Analytics Read token, used only by GET /internal/stats. */
  CF_ANALYTICS_TOKEN?: string;
  /** Secret: comma-separated owner IPs excluded from Analytics Engine writes. Missing or empty = no exclusion. */
  OWNER_EXCLUDE_IPS?: string;
  /** Local mock testing only: log analytics data points to the console. */
  ANALYTICS_TEST_LOG?: string;
  /** Feedback (src/feedback.ts, 2026-11-12): Email Service send binding; NOTIFY_TO = owner-notice inbox (secret, no default; missing -> no notice). */
  EMAIL?: SendEmail;
  NOTIFY_TO?: string;
  /** Turnstile: public site key (var) + secret (wrangler secret). Without both, /feedback accepts nothing (fails closed). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Secret: shared secret for /__ur/* (header X-UR-Feedback-Token); also derives the form-signing key and IP-hash salt. */
  UR_FEEDBACK_BOT_TOKEN?: string;
  ADMIN_OWNER_PASSWORD?: string;
  /** Account daily email quota; feedback mail never uses the last 10 sends. Default 100 if unset. */
  EMAIL_DAILY_QUOTA?: string;
  /** Local mock testing only (ignored unless DABS_BASE_URL is a local host). */
  FEEDBACK_TEST_TURNSTILE_URL?: string;
  FEEDBACK_TEST_EMAIL_FAIL?: string;
  /** Cash App cashtag for tip links/QRs (src/tip.ts). Unset or invalid -> Cash App is omitted. */
  CASHAPP_HANDLE?: string;
  /** Venmo username or profile URL for tip links/QRs (src/tip.ts). Unset or invalid -> Venmo is omitted. */
  VENMO_HANDLE?: string;
}

const APEX = "utahremedy.com";
const AGE_COOKIE = "ur_age21";
const DENY_COOKIE = "ur_under21";
const AGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const DENY_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

/** Paths reachable without passing the age gate. */
const PUBLIC_PATHS = new Set([
  "/gate", "/not-eligible", "/terms", "/privacy", "/disclaimer", "/health",
  "/robots.txt", "/favicon.svg",
  // Feedback form (2026-11-12): not alcohol content, so public like /terms and /privacy; never counted in analytics.
  "/feedback",
]);
const PUBLIC_PREFIXES = ["/assets/"];

const DISCLAIMER_HTML = `<aside class="ur-disclaimer" role="note" aria-label="Disclaimer">
  <p><strong>Independent service.</strong> Utah Remedy is not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services (DABS). Inventory data may lag and is not guaranteed &mdash; call or verify with the store before traveling. <a href="/disclaimer">Full disclaimer</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></p>
</aside>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // www -> apex (permanent)
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }

    let path = url.pathname.replace(/\/+$/, "") || "/";
    if (path.endsWith(".html")) path = path.slice(0, -5) || "/";
    if (path === "/index") path = "/";

    if (path === "/health") return health(env);
    if (path === "/internal/fetch/dabs") return internalFetch(request, env);
    if (path === "/internal/popular" || path.startsWith("/internal/popular/")) return internalPopular(request, env, path);
    if (path === "/internal/stats") return internalStats(request, env);
    // Feedback bot endpoints + admin page (secret header). Before the gate and analytics, like /internal/*: never counted.
    if (path === "/__ur" || path.startsWith("/__ur/")) return withHeaders(await handleFeedbackBot(request, env, path, url));
    const cookies = parseCookies(request.headers.get("Cookie"));

    // A visitor who answered under-21 is held on the block page for 24h (no immediate retry).
    if (path === "/gate" && cookies[DENY_COOKIE] === "1" && cookies[AGE_COOKIE] !== "1") {
      return withHeaders(new Response(null, { status: 303, headers: { Location: "/not-eligible" } }));
    }
    if (path === "/gate" && request.method === "POST") return handleGatePost(request, url, env, ctx);
    const isPublic = PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => url.pathname.startsWith(p));

    if (!isPublic && cookies[AGE_COOKIE] !== "1") {
      const dest = cookies[DENY_COOKIE] === "1" ? "/not-eligible" : `/gate?next=${encodeURIComponent(url.pathname + url.search)}`;
      return withHeaders(new Response(null, { status: 302, headers: { Location: dest } }));
    }
    // Already verified visitors skip the gate.
    if (path === "/gate" && cookies[AGE_COOKIE] === "1") {
      return withHeaders(new Response(null, { status: 302, headers: { Location: safeNext(url.searchParams.get("next")) } }));
    }

    // Public feedback form (D1 only, never DABS; public path, so never counted). CSP widened only for the Turnstile widget.
    if (path === "/feedback") {
      const r = withHeaders(decorateHtml(addAuthLink(addSiteLinks(await handleFeedback(request, env, ctx, path), env, path), request, path)));
      const csp = feedbackCsp(env);
      if (csp) r.headers.set("Content-Security-Policy", csp);
      return r;
    }

    // Email magic-link sign-in + minimal account page (watches design step 1, t99s544). Gated above; D1 + Email Sending only,
    // never DABS; never counted in analytics; always no-store. CSP widened for the Turnstile widget on /signin only.
    if (AUTH_PATHS.has(path)) {
      const r = withHeaders(decorateHtml(addAuthLink(addSiteLinks(await handleAuth(request, env, ctx, path, url), env, path), request, path)));
      r.headers.set("Cache-Control", "no-store");
      if (path === "/auth/verify") r.headers.set("Referrer-Policy", "no-referrer");
      const csp = path === "/signin" ? feedbackCsp(env) : null;
      if (csp) r.headers.set("Content-Security-Policy", csp);
      return r;
    }

    // Dedicated tip page (gated above, like other catalog pages; no D1).
    if (path === "/tip") {
      const page = tipPage(env);
      countVisit(request, env, ctx, path, isPublic, page);
      return withHeaders(decorateHtml(addAuthLink(addSiteLinks(page, env, path), request, path)));
    }

    // Catalog pages and JSON APIs (gated above; D1/Cache API only, never DABS).
    const web = await handleWeb(request, env, ctx, path, url);
    if (web) { countVisit(request, env, ctx, path, isPublic, web); return withHeaders(decorateHtml(addAuthLink(addSiteLinks(web, env, path), request, path))); }

    let res = await env.ASSETS.fetch(request);
    if (path === "/gate") res = fillGate(res, url);
    countVisit(request, env, ctx, path, isPublic, res);
    return withHeaders(decorateHtml(addAuthLink(addSiteLinks(res, env, path), request, path)));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = EXPECTED_CRONS[event.cron];
    if (!job) {
      console.error(`[cron] rejected unexpected cron expression: ${JSON.stringify(event.cron)}`);
      ctx.waitUntil(logEvent(env.DB, new Meter(), "cron", "rejected_cron", `unexpected cron ${event.cron}`).catch(() => {}));
      return;
    }
    // Local-time pin (America/Denver): outside this job's local window the tick is a pure no-op (nothing read or written).
    if (!inLocalWindow(job, event.scheduledTime)) {
      console.log(`[cron] ${event.cron} -> ${job} outside local window (${localTime(event.scheduledTime).text}); no-op`);
      return;
    }
    const r = job === "catchup" ? await runCatchupTick(env, { scheduledTime: event.scheduledTime }) : job === "catalog" ? await runCatalogTick(env, { cron: true }) : job === "perstore" ? await runPerstoreTick(env, { scheduledTime: event.scheduledTime }) : await runSweepTick(env, undefined, { scheduledTime: event.scheduledTime });
    console.log(`[cron] ${event.cron} -> ${JSON.stringify(r)}`);
  },
} satisfies ExportedHandler<Env>;

/**
 * Anonymous page-view count: gated (non-public) HTML GET with status 200 from a visitor holding the age cookie
 * (the gate above guarantees the cookie). Runs for Cache API hits and misses alike, entirely in waitUntil.
 */
function countVisit(request: Request, env: Env, ctx: ExecutionContext, path: string, isPublic: boolean, res: Response) {
  try {
    if (isPublic || request.method !== "GET" || res.status !== 200 || !(res.headers.get("Content-Type") || "").includes("text/html")) return;
    ctx.waitUntil(track(env, request, "visit", pageInfo(path)));
  } catch { /* never affect the response */ }
}

async function handleGatePost(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const next = safeNext(String(form?.get("next") ?? url.searchParams.get("next") ?? "/"));
  const y = Number(form?.get("year")), m = Number(form?.get("month")), d = Number(form?.get("day"));
  const affirm = form?.get("affirm") === "yes";

  const birth = validDate(y, m, d);
  if (!birth || !affirm) {
    const q = new URLSearchParams({ error: "1", next });
    return withHeaders(new Response(null, { status: 303, headers: { Location: `/gate?${q}` } }));
  }

  // Age is computed against today's date in Utah (America/Denver).
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
  const [ty, tm, td] = todayParts;
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age--;

  const headers = new Headers();
  if (age >= 21) {
    headers.set("Location", next);
    headers.append("Set-Cookie", cookie(AGE_COOKIE, "1", AGE_COOKIE_MAX_AGE));
    headers.append("Set-Cookie", cookie(DENY_COOKIE, "", 0));
    try { ctx.waitUntil(track(env, request, "gate_pass", { category: "gate", sku: "" })); } catch { /* never affect the response */ }
  } else {
    headers.set("Location", "/not-eligible");
    headers.append("Set-Cookie", cookie(DENY_COOKIE, "1", DENY_COOKIE_MAX_AGE));
  }
  // Birthdate is never stored or logged; only the yes/no result goes into a cookie.
  return withHeaders(new Response(null, { status: 303, headers }));
}

/** Fill the static gate form with the sanitized return path and optional error. */
function fillGate(res: Response, url: URL): Response {
  const next = safeNext(url.searchParams.get("next"));
  const showError = url.searchParams.get("error") === "1";
  return new HTMLRewriter()
    .on('input[name="next"]', { element(el) { el.setAttribute("value", next); } })
    .on("#gate-error", { element(el) { if (showError) el.removeAttribute("hidden"); } })
    .transform(res);
}

/**
 * Manual, secret-guarded trigger for the DABS fetcher (prototype; no Cron yet).
 * Returns 404 unless POST with `Authorization: Bearer <ADMIN_TOKEN>`.
 */
async function internalFetch(request: Request, env: Env): Promise<Response> {
  const notFound = () => withHeaders(new Response("Not found", { status: 404 }));
  if (request.method !== "POST" || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return notFound();
  const auth = request.headers.get("Authorization") ?? "";
  if (!(await timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`))) return notFound();
  let body: RunOptions & { sweepTick?: boolean; catalogImport?: boolean; perstoreTick?: boolean; catchupTick?: boolean; maxSkus?: number };
  try {
    body = (await request.json()) as RunOptions & { sweepTick?: boolean; catalogImport?: boolean; perstoreTick?: boolean; catchupTick?: boolean; maxSkus?: number };
    if (!body.sweepTick && !body.catalogImport && !body.perstoreTick && !body.catchupTick && !Array.isArray(body.queries)) throw new Error("queries[], sweepTick, catalogImport, perstoreTick or catchupTick required");
  } catch (e) {
    return withHeaders(Response.json({ ok: false, error: `bad request: ${e}` }, { status: 400 }));
  }
  if (body.catalogImport) {
    // Same code path, caps and lock as the monthly cron tick. "force": true skips only the once-per-day/attempt gating.
    const r = await runCatalogTick(env, { force: body.force === true });
    return withHeaders(Response.json(r, { headers: { "Cache-Control": "no-store" } }));
  }
  if (body.catchupTick) {
    // Same code path, caps and lock as the catch-up cron tick; acts only on a queued/running catch-up. Never the hard-stop tick.
    const r = await runCatchupTick(env);
    return withHeaders(Response.json(r, { headers: { "Cache-Control": "no-store" } }));
  }
  if (body.perstoreTick) {
    // Same code path, caps and lock as the B1 cron tick. maxSkus (1-2) limits a manual tick; it advances today's queue.
    const r = await runPerstoreTick(env, { maxSkus: typeof body.maxSkus === "number" ? body.maxSkus : undefined });
    return withHeaders(Response.json(r, { headers: { "Cache-Control": "no-store" } }));
  }
  if (body.sweepTick) {
    // Same code path, caps and lock as the cron tick.
    const r = await runSweepTick(env);
    return withHeaders(Response.json(r, { headers: { "Cache-Control": "no-store" } }));
  }
  const opts: RunOptions = { queries: body.queries, storeDetailSkus: Array.isArray(body.storeDetailSkus) ? body.storeDetailSkus : [], force: body.force === true };
  const out = await runDabsFetch(env, opts);
  const status = out.ok ? 200 : out.blocked ? 409 : 502;
  return withHeaders(Response.json(out, { status, headers: { "Cache-Control": "no-store" } }));
}

/**
 * Popular-100 admin (no DABS calls; D1/KV only). 404 for everything unless `Authorization: Bearer <ADMIN_TOKEN>`.
 *   GET  /internal/popular                     -> roster (active <=100 incl. locks, reserve)
 *   POST /internal/popular/{lock|unlock|add|remove}  {"sku":"016850", "note"?: "...", "rank"?: n (add/lock of a new sku)}
 *   POST /internal/popular/flag                {"popular":"on"|"off"}  (KV perstore:v1:popular; no deploy needed)
 * List changes take effect from the next day's per-store queue (today's queue is frozen at its first tick).
 */
async function internalPopular(request: Request, env: Env, path: string): Promise<Response> {
  const notFound = () => withHeaders(new Response("Not found", { status: 404 }));
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return notFound();
  const auth = request.headers.get("Authorization") ?? "";
  if (!(await timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`))) return notFound();
  const json = (b: unknown, status = 200) => withHeaders(Response.json(b, { status, headers: { "Cache-Control": "no-store" } }));
  if (path === "/internal/popular") {
    if (request.method !== "GET") return notFound();
    const flag = (await env.UTAH_REMEDY_CACHE.get(POPULAR_FLAG_KEY)) === "on" ? "on" : "off";
    return json({ ok: true, flag, ...(await popularList(env.DB)) });
  }
  const op = path.slice("/internal/popular/".length);
  if (request.method !== "POST" || !["lock", "unlock", "add", "remove", "flag"].includes(op)) return notFound();
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; if (!body || typeof body !== "object") throw new Error("object expected"); }
  catch (e) { return json({ ok: false, error: `bad request: ${e}` }, 400); }
  if (op === "flag") {
    if (body.popular !== "on" && body.popular !== "off") return json({ ok: false, error: 'popular must be "on" or "off"' }, 400);
    await env.UTAH_REMEDY_CACHE.put(POPULAR_FLAG_KEY, body.popular);
    return json({ ok: true, flag: body.popular, key: POPULAR_FLAG_KEY, note: "checked at every per-store tick" });
  }
  try {
    const r = await popularAdmin(env.DB, op as "lock" | "unlock" | "add" | "remove", body.sku, { rank: body.rank, note: body.note });
    return json(r.body, r.status);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

/** GET /internal/stats (Bearer ADMIN_TOKEN; 404 otherwise): anonymous visitor counts from Analytics Engine. */
async function internalStats(request: Request, env: Env): Promise<Response> {
  const notFound = () => withHeaders(new Response("Not found", { status: 404 }));
  if (request.method !== "GET" || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return notFound();
  if (!(await timingSafeEqual(request.headers.get("Authorization") ?? "", `Bearer ${env.ADMIN_TOKEN}`))) return notFound();
  const json = (b: unknown, status = 200) => withHeaders(Response.json(b, { status, headers: { "Cache-Control": "no-store" } }));
  if (!env.CF_ANALYTICS_TOKEN) return json({ ok: false, error: "CF_ANALYTICS_TOKEN not configured" }, 503);
  try { return json(await stats(env, env.DB)); }
  catch (e) { return json({ ok: false, error: String(e).slice(0, 400) }, 502); }
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function health(env: Env): Promise<Response> {
  const [d1, kv] = await Promise.all([
    env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>().then((r) => r?.ok === 1).catch(() => false),
    env.UTAH_REMEDY_CACHE.get("health:probe").then(() => true).catch(() => false),
  ]);
  const dabs = kv ? await getSourceStatus(env.UTAH_REMEDY_CACHE).catch(() => null) : null;
  const [guard, sweep, catalog, perstore, catalogAuto, catchup] = d1 && kv
    ? await Promise.all([guardStatus(env).catch(() => null), sweepStatus(env.DB), catalogStatus(env.DB), perstoreStatus(env).catch(() => null), catalogAutoState(env.UTAH_REMEDY_CACHE).catch(() => null), catchupStatus(env.DB).catch(() => null)])
    : [null, null, null, null, null, null];
  const body = {
    ok: d1 && kv,
    service: "utah-remedy",
    version: env.APP_VERSION,
    commit: env.GIT_COMMIT,
    timestamp: new Date().toISOString(),
    d1,
    kv,
    data_sources: {
      "dabs-locator": dabs
        ? { last_ok_at: dabs.last_ok_at ?? null, last_attempt_at: dabs.last_attempt_at ?? null, last_status: dabs.last_status ?? null, stale: dabs.stale ?? true }
        : { last_ok_at: null, stale: true, note: "never fetched" },
    },
    fetcher: guard ? { ...guard, schedule: Object.keys(EXPECTED_CRONS), local_schedule: localSchedule(), last_sweep: sweep, last_catalog_import: catalog, catalog_auto_import: { state: catalogAuto, key: CATALOG_AUTO_KEY, scope: "monthly catalog cron only" }, perstore, sweep_catchup: catchup } : null,
  };
  return withHeaders(new Response(JSON.stringify(body, null, 2), {
    status: body.ok ? 200 : 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  }));
}

function decorateHtml(res: Response): Response {
  const type = res.headers.get("Content-Type") || "";
  if (!type.includes("text/html")) return res;
  const out = new HTMLRewriter()
    .on("body", { element(el) { el.append(DISCLAIMER_HTML, { html: true }); } })
    .transform(res);
  const r = new Response(out.body, out);
  // Content depends on the age cookie; never let shared caches mix gate/landing.
  r.headers.set("Cache-Control", "private, no-cache");
  r.headers.set("Vary", "Cookie");
  return r;
}

function withHeaders(res: Response): Response {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  return r;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Only allow same-site relative redirects. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/gate")) return "/";
  return next;
}

function validDate(y: number, m: number, d: number): Date | null {
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < thisYear - 120 || y > thisYear || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** /health: the America/Denver windows, the UTC crons that cover them, and the next local opening of each. */
function localSchedule() {
  const now = Date.now();
  const jobs = Object.keys(LOCAL_WINDOWS) as Job[];
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    time_zone: SCHEDULE_TZ,
    gate: "each tick runs its job only if its scheduledTime in America/Denver (Intl) is inside the local window; otherwise no-op",
    now_local: localTime(now).text,
    windows: Object.fromEntries(jobs.map((j) => {
      const w = LOCAL_WINDOWS[j];
      const crons = Object.keys(EXPECTED_CRONS).filter((c) => EXPECTED_CRONS[c] === j);
      const next = nextLocalOpen(j, crons, now);
      return [j, { local: w.label, first_tick: hm(w.first), last_tick: hm(w.last), ...(w.days ? { local_days: `${w.days[0]}-${w.days[1]}` } : {}),
        crons_utc: crons, open_now: inLocalWindow(j, Math.floor(now / 300000) * 300000),
        next_open: next == null ? null : { utc: new Date(next).toISOString(), local: localTime(next).text } }];
    })),
  };
}
