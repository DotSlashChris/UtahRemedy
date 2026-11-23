/**
 * Anonymous visitor counting (owner-approved 2026-10-25). Workers Analytics Engine only: no D1 writes, no cookies added.
 *
 * Visitor id = first 16 hex chars of SHA-256(daily salt | IP | User-Agent). The salt is 32 random bytes kept ONLY in KV
 * (key analytics:v1:salt:<MT day>), created ahead of time during the previous Utah day (or on demand), set to expire
 * ~1 h after its day ends; the previous day's salt is also deleted whenever a new salt is written. Once a salt is gone the ids for that day cannot be
 * recomputed or linked to an IP/UA or to another day. The IP, User-Agent, birthdate and cookie values are never written.
 *
 * Data point (dataset utah_remedy_events): index1 = daily visitor id; blob1 = event ("gate_pass" | "visit");
 * blob2 = page category ("home" | "search" | "product" | "store" | "other" | "gate"); blob3 = product SKU (product views
 * only, else ""); blob4 = Utah (America/Denver) calendar day; double1 = 1. Timestamp is added by Analytics Engine.
 *
 * Every call runs inside ctx.waitUntil and swallows all errors: analytics can never change or slow a page response.
 * If the OWNER_EXCLUDE_IPS secret lists the request's CF-Connecting-IP (comma-separated, exact IPv4/IPv6 match),
 * the write is skipped. The IP is not stored or logged. A missing or empty secret counts normally.
 */
export const DATASET = "utah_remedy_events";
export const ACCOUNT_ID = "ca827b3a832159e95f29d5d1d14e9b79";
const SALT_PREFIX = "analytics:v1:salt:";
const SALT_RECHECK_MS = 5 * 60 * 1000; // re-read KV so isolates converge if two created a salt at the same moment

export interface AnalyticsEnv {
  UTAH_REMEDY_CACHE: KVNamespace;
  EVENTS?: AnalyticsEngineDataset;
  CF_ANALYTICS_TOKEN?: string;
  /** Local mock testing only (ignored unless DABS_BASE_URL is a non-DABS host): also console.log each data point. */
  ANALYTICS_TEST_LOG?: string;
  DABS_BASE_URL?: string;
  /** Secret: comma-separated owner IPs excluded from Analytics Engine writes. Missing or empty = no exclusion. */
  OWNER_EXCLUDE_IPS?: string;
}
export type Category = "home" | "search" | "product" | "store" | "other" | "gate";
export interface PageInfo { category: Category; sku: string }

/** Utah calendar day, e.g. "2026-10-25". */
export function mtDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** Unix seconds of the end of the given Utah day + 1 h. */
function saltExpiry(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", timeZoneName: "shortOffset" })
    .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "GMT-7";
  const hours = Number((off.match(/GMT([+-]\d+)/) ?? [, "-7"])[1]);
  return Math.floor((Date.UTC(y, m - 1, d + 1) - hours * 3600_000) / 1000) + 3600;
}

let saltCache: { day: string; salt: string; at: number } | null = null;
let nextChecked: { day: string; at: number } | null = null;
const NEXT_RECHECK_MS = 30 * 60 * 1000;

function randomSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
async function putSalt(kv: KVNamespace, day: string, salt: string) {
  await kv.put(SALT_PREFIX + day, salt, { expiration: Math.max(saltExpiry(day), Math.floor(Date.now() / 1000) + 120) });
}

/**
 * KV has no put-if-absent and is eventually consistent (a missing key can read as missing for ~60 s everywhere), so
 * creating a salt at the first visit of the day lets several isolates pick different salts at once (seen on the first
 * deploy: 6 ids for 1 visitor). Fix: each day's salt is created AHEAD of time, while the previous day is still running
 * (checked at most every 30 min per isolate); any racing writes settle long before that day starts. Today's salt is
 * created on demand only if nobody visited yesterday.
 */
async function dailySalt(kv: KVNamespace, day: string): Promise<string> {
  if (!nextChecked || nextChecked.day !== day || Date.now() - nextChecked.at > NEXT_RECHECK_MS) {
    nextChecked = { day, at: Date.now() };
    const next = shiftDay(day, 1);
    if (!(await kv.get(SALT_PREFIX + next))) {
      await putSalt(kv, next, randomSalt());
      await kv.delete(SALT_PREFIX + shiftDay(day, -1));
    }
  }
  if (saltCache && saltCache.day === day && Date.now() - saltCache.at < SALT_RECHECK_MS) return saltCache.salt;
  let salt = await kv.get(SALT_PREFIX + day);
  if (!salt) {
    salt = randomSalt();
    await putSalt(kv, day, salt);
    await kv.delete(SALT_PREFIX + shiftDay(day, -1));
  }
  saltCache = { day, salt, at: Date.now() };
  return salt;
}

async function visitorId(env: AnalyticsEnv, request: Request, day: string): Promise<string> {
  const salt = await dailySalt(env.UTAH_REMEDY_CACHE, day);
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const ua = request.headers.get("User-Agent") ?? "";
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}|${ua}`)));
  return [...h.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Category for a gated HTML path (already normalized: no trailing slash / .html). */
export function pageInfo(path: string): PageInfo {
  if (path === "/") return { category: "home", sku: "" };
  if (path === "/search") return { category: "search", sku: "" };
  const m = path.match(/^\/product\/(\d{1,6})$/);
  if (m) return { category: "product", sku: m[1] };
  if (path === "/stores" || /^\/stores\/\d{1,4}$/.test(path)) return { category: "store", sku: "" };
  return { category: "other", sku: "" };
}

const isMock = (env: AnalyticsEnv) => !!env.DABS_BASE_URL && !env.DABS_BASE_URL.startsWith("https://webapps2.abc.utah.gov/");

/** Parse OWNER_EXCLUDE_IPS: comma-separated, trimmed, empties ignored. Exact IPv4/IPv6 match (IPv6 case-insensitive). */
export function isOwnerExcludedIp(env: Pick<AnalyticsEnv, "OWNER_EXCLUDE_IPS">, request: Request): boolean {
  const raw = env.OWNER_EXCLUDE_IPS;
  if (!raw) return false;
  const excluded = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (!excluded.length) return false;
  const ip = (request.headers.get("CF-Connecting-IP") ?? "").trim();
  if (!ip) return false;
  const needle = ip.toLowerCase();
  return excluded.some((entry) => entry.toLowerCase() === needle);
}

/** Fire-and-forget: call as ctx.waitUntil(track(...)). Never throws. */
export async function track(env: AnalyticsEnv, request: Request, event: "gate_pass" | "visit", page: PageInfo): Promise<void> {
  try {
    if (!env.EVENTS && !(env.ANALYTICS_TEST_LOG === "1" && isMock(env))) return;
    if (isOwnerExcludedIp(env, request)) return;
    const day = mtDay();
    const point = { indexes: [await visitorId(env, request, day)], blobs: [event, page.category, page.sku, day], doubles: [1] };
    env.EVENTS?.writeDataPoint(point);
    if (env.ANALYTICS_TEST_LOG === "1" && isMock(env)) console.log(`[ae-test] ${JSON.stringify(point)}`);
  } catch (e) {
    console.error(`[analytics] dropped event: ${String(e).slice(0, 200)}`);
  }
}

async function sql<T>(env: AnalyticsEnv, query: string): Promise<T[]> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST", headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: query,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`AE SQL HTTP ${r.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { data: T[] }).data;
}

/**
 * Admin stats (2 Analytics Engine read queries + 1 small D1 read for SKU names). Counts are weighted by
 * _sample_interval; unique visitors use count(DISTINCT index1), exact while nothing is sampled (see `sampled`).
 */
export async function stats(env: AnalyticsEnv, db: D1Database) {
  const cutoff30 = mtDay(new Date(Date.now() - 29 * 24 * 3600_000));
  type Day = { day: string; unique_visitors: number | string; page_views: number | string; gate_passes: number | string; max_sample_interval: number | string };
  type Sku = { sku: string; views: number | string };
  const [days, skus] = await Promise.all([
    sql<Day>(env, `SELECT blob4 AS day, count(DISTINCT index1) AS unique_visitors, sumIf(_sample_interval, blob1 = 'visit') AS page_views,
      sumIf(_sample_interval, blob1 = 'gate_pass') AS gate_passes, max(_sample_interval) AS max_sample_interval
      FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '92' DAY GROUP BY day ORDER BY day DESC FORMAT JSON`),
    sql<Sku>(env, `SELECT blob3 AS sku, sum(_sample_interval) AS views FROM ${DATASET}
      WHERE blob1 = 'visit' AND blob2 = 'product' AND timestamp > NOW() - INTERVAL '7' DAY
      GROUP BY sku ORDER BY views DESC LIMIT 20 FORMAT JSON`),
  ]);
  const n = (v: number | string) => Number(v) || 0;
  const all = days.map((d) => ({ day: d.day, unique_visitors: n(d.unique_visitors), page_views: n(d.page_views), gate_passes: n(d.gate_passes), sampled: n(d.max_sample_interval) > 1 }));
  const daily = all.filter((d) => d.day >= cutoff30);
  const names = new Map<string, string>();
  const list = skus.map((s) => s.sku).filter((s) => /^\d{6}$/.test(s));
  if (list.length) {
    const r = await db.prepare(`SELECT sku, name FROM products WHERE sku IN (${list.map(() => "?").join(",")})`).bind(...list).all<{ sku: string; name: string }>();
    for (const x of r.results) names.set(x.sku, x.name);
  }
  const sum = (a: typeof all, k: "unique_visitors" | "page_views" | "gate_passes") => a.reduce((t, d) => t + d[k], 0);
  return {
    ok: true,
    dataset: DATASET,
    generated_at: new Date().toISOString(),
    note: "Days are Utah (America/Denver) days. Visitor ids rotate daily, so the same person on two days counts twice: totals are unique-visitor-days, not people. gate_passes ~ new browsers (the age cookie lasts 30 days). Analytics Engine keeps ~3 months.",
    totals: {
      unique_visitor_days_30d: sum(daily, "unique_visitors"), page_views_30d: sum(daily, "page_views"), gate_passes_30d: sum(daily, "gate_passes"),
      unique_visitor_days_all: sum(all, "unique_visitors"), page_views_all: sum(all, "page_views"), gate_passes_all: sum(all, "gate_passes"),
      first_day: all.length ? all[all.length - 1].day : null,
    },
    daily,
    top_products_7d: skus.map((s) => ({ sku: s.sku, name: names.get(s.sku) ?? null, views: n(s.views) })),
  };
}
