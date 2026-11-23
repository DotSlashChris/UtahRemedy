/**
 * User-facing catalog routes. All are behind the 21+ gate (enforced in src/index.ts before we get here).
 * Cost controls:
 *  - Served ONLY from D1 (never calls DABS).
 *  - Responses cached in the Cache API (free; per data center) for CACHE_TTL_S; zero KV writes.
 *  - Rate limit (Workers Rate Limiting binding) applies to cache MISSES, i.e. requests that would hit D1.
 *  - Query length/token caps, page caps, and a 200-candidate cap bound D1 rows read per request.
 */
import * as C from "./catalog";
import * as P from "./pages";

export interface WebEnv { DB: D1Database; SEARCH_LIMITER?: RateLimit }

const CACHE_TTL_S = 300;
const META_TTL_S = 300;
const STORES_TTL_S = 3600;
const ORIGIN = "https://utahremedy.com";
const CACHE_NS = "/__cache/v1";

type Out = { kind: "html"; body: string; status?: number } | { kind: "json"; body: unknown; status?: number };

export async function handleWeb(request: Request, env: WebEnv, ctx: ExecutionContext, path: string, url: URL): Promise<Response | null> {
  const api = path.startsWith("/api/");
  const route = api ? path.slice(4) : path;
  let handler: ((m: C.Meter) => Promise<Out>) | null = null;
  let cacheKey = "";

  if (route === "/search") {
    const p = C.parseSearch(url);
    cacheKey = `${path}?${C.canonical(p)}`;
    handler = async (m) => {
      const [ds, list] = await Promise.all([meta(env, ctx, m), storeList(env, ctx, m)]);
      const res = p.q || p.kind || p.store ? await C.search(env.DB, m, p, ds.lastCleanAt) : null;
      return api ? { kind: "json", body: { params: p, data_status: ds, ...(res ? { mode: res.mode, has_more: res.hasMore, capped: res.capped, results: res.rows.map((r) => jsonProduct(r, ds)) } : { results: [] }) } }
        : { kind: "html", body: P.searchPage(res, ds, list) };
    };
  } else if (/^\/product\/\d{1,6}$/.test(route)) {
    const sku = C.normSku(route.split("/")[2]);
    if (route.split("/")[2] !== sku) return Response.redirect(`${url.origin}${api ? "/api" : ""}/product/${sku}`, 301);
    cacheKey = `${path}`;
    handler = async (m) => {
      const [ds, d] = await Promise.all([meta(env, ctx, m), C.product(env.DB, m, sku)]);
      if (!d) return notFound(api, "We don't have that SKU.", "We haven't seen this SKU in public DABS data (we track DABS's monthly product list plus items that have appeared in the in-stock list). Try the official DABS Product Locator.");
      return api ? { kind: "json", body: { data_status: ds, product: jsonProduct(d.product, ds), stores: d.stores.map((s) => ({ ...s, club_only: C.isClubStore(s.name) })) } }
        : { kind: "html", body: P.productPage(d, ds) };
    };
  } else if (route === "/stores") {
    cacheKey = path;
    handler = async (m) => {
      const [ds, list] = await Promise.all([meta(env, ctx, m), storeList(env, ctx, m)]);
      return api ? { kind: "json", body: { stores: list.map((s) => ({ ...s, club_only: C.isClubStore(s.name) })) } } : { kind: "html", body: P.storesPage(list, ds) };
    };
  } else if (/^\/stores\/\d{1,4}$/.test(route)) {
    const id = C.normStoreId(route.split("/")[2]);
    if (route.split("/")[2] !== id) return Response.redirect(`${url.origin}${api ? "/api" : ""}/stores/${id}${url.search}`, 301);
    const p = { ...C.parseSearch(url), store: id };
    cacheKey = `${path}?${C.canonical({ ...p, store: "" })}`;
    handler = async (m) => {
      const [ds, list, s] = await Promise.all([meta(env, ctx, m), storeList(env, ctx, m), C.store(env.DB, m, id)]);
      if (!s) return notFound(api, "Unknown store.", "We don't have a store with that number on file.");
      const res = await C.search(env.DB, m, p, ds.lastCleanAt);
      return api ? { kind: "json", body: { data_status: ds, store: { ...s.store, club_only: C.isClubStore(s.store.name) }, products_with_store_counts: s.skusChecked, has_more: res.hasMore, results: res.rows.map((r) => jsonProduct(r, ds)) } }
        : { kind: "html", body: P.storePage(s.store, s.skusChecked, res, ds, list) };
    };
  } else {
    return null;
  }

  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

  const cache = (caches as unknown as { default: Cache }).default;
  const keyReq = new Request(`${ORIGIN}${CACHE_NS}${cacheKey}`);
  const hit = await cache.match(keyReq).catch(() => undefined);
  if (hit) return finalize(hit, "HIT", null, api);

  if (env.SEARCH_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.SEARCH_LIMITER.limit({ key: `ur:web:${ip}` });
    if (!success) {
      const body = api ? JSON.stringify({ error: "rate_limited", retry_after_s: 60 })
        : P.messagePage("Easy there.", "That&rsquo;s a lot of searches in a minute. Give it a moment and try again.", 429).html;
      return new Response(body, { status: 429, headers: { "Content-Type": api ? "application/json" : "text/html; charset=utf-8", "Retry-After": "60", "Cache-Control": "no-store" } });
    }
  }

  const m: C.Meter = { rowsRead: 0, queries: 0 };
  let out: Out;
  try {
    out = await handler(m);
  } catch (e) {
    console.error(`[web] ${path} failed: ${e}`);
    // Fail closed: no data rather than wrong data.
    out = api ? { kind: "json", status: 503, body: { error: "data_unavailable", message: "Inventory data is temporarily unavailable." } }
      : { kind: "html", status: 503, body: P.messagePage("Data temporarily unavailable", "We couldn&rsquo;t read our inventory data just now, so we&rsquo;re not showing anything rather than showing something wrong. Please try again shortly.", 503).html };
  }
  const status = out.status ?? 200;
  const res = new Response(out.kind === "json" ? JSON.stringify(out.body) : out.body, {
    status,
    headers: { "Content-Type": out.kind === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_TTL_S}` },
  });
  if (status === 200 || status === 404) ctx.waitUntil(cache.put(keyReq, res.clone()).catch(() => {}));
  return finalize(res, "MISS", m, api);
}

function finalize(res: Response, cacheState: string, m: C.Meter | null, api: boolean): Response {
  const r = new Response(res.body, res);
  r.headers.set("X-UR-Cache", cacheState);
  if (m) r.headers.set("X-UR-D1-Rows-Read", String(m.rowsRead));
  r.headers.set("Cache-Control", api ? "private, max-age=60" : "private, no-cache");
  return r;
}

function notFound(api: boolean, title: string, msg: string): Out {
  return api ? { kind: "json", status: 404, body: { error: "not_found", message: msg } } : { kind: "html", status: 404, body: P.messagePage(title, P.esc(msg), 404).html };
}

function jsonProduct(r: C.ProductRow, ds: C.DataStatus) {
  const st = C.classify(r, ds.lastCleanAt);
  const s = C.statusInfo(r.status, r.status_label);
  return {
    sku: r.sku, name: r.name, display_name: P.displayName(r.name), size_ml: r.size_ml, price: r.price_cents === null ? null : r.price_cents / 100,
    type: r.kind, category: r.category, status: { code: r.status, dabs_label: r.status_label, plain: s.word, note: s.note },
    stock: { state: st.state, as_of: st.verifiedAt, stores_statewide: st.stores, warehouse: st.warehouse, on_order: st.onOrder, inferred_zero: st.inferred },
    ...(r.store_qty !== undefined ? { at_store: { quantity: r.store_qty, as_of: r.store_verified_at ?? null } } : {}),
  };
}

/** Small cached lookups (Cache API, never KV). */
async function cachedJson<T>(ctx: ExecutionContext, name: string, ttl: number, m: C.Meter, load: () => Promise<T>): Promise<T> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`${ORIGIN}${CACHE_NS}/__data/${name}`);
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit.json() as Promise<T>;
  const v = await load();
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })).catch(() => {}));
  return v;
}
const meta = async (env: WebEnv, ctx: ExecutionContext, m: C.Meter) => {
  const [ds, cov] = await Promise.all([
    cachedJson(ctx, "status", META_TTL_S, m, () => C.dataStatus(env.DB, m)),
    cachedJson(ctx, "store-coverage", STORES_TTL_S, m, () => C.storeCoverage(env.DB, m)),
  ]);
  return { ...ds, storeLevelSkus: cov };
};
const storeList = (env: WebEnv, ctx: ExecutionContext, m: C.Meter) => cachedJson(ctx, "stores", STORES_TTL_S, m, () => C.stores(env.DB, m));
