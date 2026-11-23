/** Server-rendered HTML for search, product and store pages. No client JS (CSP: script-src 'none'). */
import {
  KINDS, KIND_LABEL, PAGE_SIZE, STALE_MS, canonical, classify, isClubStore, statusInfo,
  type DataStatus, type ProductDetail, type ProductRow, type SearchResult, type Stock, type StoreInfo,
} from "./catalog";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
export const fmtMT = (iso: string | null) => (iso ? MT.format(new Date(iso)) : "never");
function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const asOf = (iso: string | null) => (iso ? `<time datetime="${esc(iso)}">${esc(fmtMT(iso))}</time>` : "never");

const titleCase = (s: string) => s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
export const displayName = (name: string) => titleCase(name.replace(/\s*\d+(?:\.\d+)?\s*ml$/i, "").replace(/\s*\d+\s*oz$/i, ""));
const sizeLabel = (ml: number | null, name: string) => {
  if (ml) return ml >= 1000 ? `${(ml / 1000).toFixed(ml % 1000 ? 2 : 0).replace(/0$/, "")} L` : `${ml} ml`;
  const oz = name.match(/(\d+)\s*oz$/i);
  return oz ? `${oz[1]} oz` : "";
};
const price = (c: number | null) => (c === null || c === undefined ? "Price n/a" : `$${(c / 100).toFixed(2)}`);
const n = (v: number) => v.toLocaleString("en-US");

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 48 L22 30 L30 38 L40 22 L56 48 Z" fill="#b5523b"/><path d="M26 10 h12 v6 c0 2 4 4 4 9 v25 a3 3 0 0 1-3 3 H25 a3 3 0 0 1-3-3 V25 c0-5 4-7 4-9 z" fill="#d39a3a" stroke="#f6f1e7" stroke-width="2"/></svg>`;

export function layout(title: string, body: string, opts: { description?: string; noindex?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Utah Remedy</title>
<meta name="description" content="${esc(opts.description ?? "Search Utah liquor availability from public DABS data. Independent; not affiliated with Utah DABS.")}">
${opts.noindex ? '<meta name="robots" content="noindex">' : ""}
<meta name="theme-color" content="#14181f">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="site-header"><div class="wrap"><a class="brand" href="/">${LOGO}Utah Remedy</a><nav class="nav" aria-label="Main"><a href="/search">Search</a><a href="/stores">Stores</a><a href="/disclaimer">Disclaimer</a></nav></div></header>
<main>
${body}
</main>
<footer class="site-footer"><div class="wrap">&copy; 2026 Utah Remedy. For adults 21 and older. Please drink responsibly.</div></footer>
</body>
</html>`;
}

/** Repeated right next to every block of per-store data (product page store table, store page list). */
const STORE_VERIFY = `<p class="notice small" role="note"><strong>Verify with the store before you travel.</strong> Per-store counts are a snapshot from public DABS data, checked once a day overnight or early morning; allocated and popular bottles can sell out as soon as a store opens. Call ahead.</p>`;

/** Exact DABS notice wording, injected at the bottom of every HTML page (just above the tip section) by addSiteLinks. */
export const PAGE_NOTICE = `<aside class="page-notice" role="note" aria-label="Data disclaimer"><p><strong>Independent service, not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services (DABS).</strong> Counts come from public DABS data, can lag, and aren&rsquo;t guaranteed. <strong>Verify with the store before you travel.</strong></p></aside>`;

export function statusBanner(ds: DataStatus): string {
  const last = ds.lastCleanAt ? `${asOf(ds.lastCleanAt)} (${esc(ago(ds.lastCleanAt))})` : "";
  const msg: Record<DataStatus["state"], string> = {
    ok: `Statewide counts confirmed by the nightly update at ${last}.`,
    running: `Tonight&rsquo;s update is in progress. Counts shown were confirmed at ${last} unless marked newer.`,
    failed: `<strong>The latest update (${esc(ds.latestDay)}) failed</strong>, so nothing from it was used to mark items out of stock. Showing counts confirmed at ${last}.`,
    incomplete: `<strong>The latest update finished with gaps</strong>, so &ldquo;not in stock&rdquo; isn&rsquo;t confirmed for items that dropped off. Last clean update: ${last}.`,
    stale: `<strong>Data is stale.</strong> The last complete update was ${last}. Treat every count below as unknown until the next update.`,
    never: `<strong>Partial data.</strong> The first full nightly catalog update hasn&rsquo;t completed yet (it runs between 1 and 3 AM Mountain). So far ${n(ds.productsTracked)} products have been checked directly; each one shows when it was last checked.`,
  };
  return `<p class="status status-${ds.level}" role="status">${msg[ds.state]}</p>`;
}

function stockPill(s: Stock): string {
  switch (s.state) {
    case "in_stock": return `<span class="stock stock-in">In stock &middot; ${n(s.stores.value!)} in stores statewide</span>`;
    case "warehouse_only": return `<span class="stock stock-wh">Not on store shelves &middot; ${n(s.warehouse.value!)} at the warehouse</span>`;
    case "out": return `<span class="stock stock-out">Not in stock at any store</span>`;
    case "stale": return `<span class="stock stock-unknown">Unknown &middot; data is stale</span>`;
    default: return `<span class="stock stock-unknown">Unknown &middot; not checked yet</span>`;
  }
}
const stockAsOf = (s: Stock) =>
  s.state === "unknown" ? "No quantity data: this item is on the DABS product list but hasn&rsquo;t appeared in the in-stock list we check nightly. Check with DABS or the store."
  : s.state === "stale" ? `Last confirmed ${asOf(s.verifiedAt)}; too old to trust.`
  : `As of ${asOf(s.verifiedAt)}${s.state === "out" && s.inferred ? " (dropped off the in-stock list in a clean nightly update)" : ""}.`;

function statusBadge(code: string | null, label: string | null) {
  const s = statusInfo(code, label);
  return `<span class="badge badge-${s.tone}" title="${esc(s.note)}">${esc(s.word)}</span>`;
}

function searchForm(p: SearchResult["params"] | null, storesList: StoreInfo[], compact = false): string {
  const q = p?.q ?? "";
  const kindOpts = [`<option value="">All types</option>`, ...KINDS.map((k) => `<option value="${k}"${p?.kind === k ? " selected" : ""}>${esc(KIND_LABEL[k])}</option>`)].join("");
  const storeOpts = [`<option value="">Any store</option>`, ...storesList.map((s) =>
    `<option value="${esc(s.id)}"${p?.store === s.id ? " selected" : ""}>${esc(storeShort(s))}</option>`)].join("");
  return `<form class="search${compact ? " compact" : ""}" action="/search" method="get" role="search">
  <label class="sr" for="q">Search</label>
  <input id="q" name="q" type="search" value="${esc(q)}" maxlength="80" placeholder="Name, brand, type, or SKU (e.g. Buffalo Trace)" autocomplete="off">
  <div class="filters">
    <label class="sr" for="type">Type</label><select id="type" name="type">${kindOpts}</select>
    <label class="sr" for="store">Store</label><select id="store" name="store">${storeOpts}</select>
    <label class="inline"><input type="checkbox" name="stock" value="1"${p?.inStock ? " checked" : ""}> In stock only</label>
  </div>
  <button class="btn" type="submit">Search</button>
</form>`;
}
export const storeShort = (s: StoreInfo) => `#${Number(s.id)} ${titleCase(s.city ?? "")}${s.address ? " — " + titleCase(s.address) : ""}${isClubStore(s.name) ? " (club only)" : ""}`;

function resultCard(r: ProductRow, lastCleanAt: string | null, storeId: string): string {
  const st = classify(r, lastCleanAt);
  const size = sizeLabel(r.size_ml, r.name);
  let storeLine = "";
  if (storeId && r.store_qty !== undefined && r.store_qty !== null) {
    const stale = !r.store_verified_at || Date.now() - Date.parse(r.store_verified_at) > STALE_MS;
    storeLine = stale
      ? `<p class="small muted">At this store: last seen ${n(r.store_qty)}, last checked ${asOf(r.store_verified_at ?? null)} <span class="flag">stale</span> &middot; verify with the store</p>`
      : `<p class="small">At this store: <strong>${n(r.store_qty)}</strong>, last checked ${asOf(r.store_verified_at ?? null)} <span class="muted">&middot; verify with the store before you travel</span></p>`;
  }
  return `<li class="result">
  <a class="rname" href="/product/${esc(r.sku)}">${esc(displayName(r.name))}</a>
  <p class="meta">${esc(size)}${size ? " &middot; " : ""}<strong>${esc(price(r.price_cents))}</strong> &middot; ${statusBadge(r.status, r.status_label)} <span class="muted">&middot; ${esc(KIND_LABEL[r.kind] ?? "Other")} &middot; SKU ${esc(r.sku)}</span></p>
  <p>${stockPill(st)}</p>
  <p class="small muted">${stockAsOf(st)}</p>
  ${storeLine}
</li>`;
}

export function searchPage(res: SearchResult | null, ds: DataStatus, storesList: StoreInfo[]): string {
  const p = res?.params ?? null;
  let results = "";
  if (res && res.mode !== "empty") {
    const storeName = p?.store ? storesList.find((s) => s.id === p.store) : undefined;
    const storeNote = p?.store
      ? `<p class="status status-info">Store filter: only items with a per-store count for ${esc(storeName ? storeShort(storeName) : "#" + p.store)}. Per-store counts exist for just ${n(ds.storeLevelSkus)} product${ds.storeLevelSkus === 1 ? "" : "s"} so far, so many items in stock there won&rsquo;t show up yet.</p>`
      : "";
    if (!res.rows.length) {
      results = `${storeNote}<div class="empty"><h2>No matches${p?.page && p.page > 1 ? " on this page" : ""}.</h2>
        <p>We know about products on DABS&rsquo;s monthly product list plus anything that has shown up in the public DABS in-stock list${ds.state === "never" ? " &mdash; and the first full catalog update hasn&rsquo;t run yet" : ""}. Allocated or retired items that are on neither won&rsquo;t appear. Try fewer words, a brand name, or the <a href="https://webapps2.abc.utah.gov/ProdApps/ProductLocatorCore/" rel="noopener">official DABS Product Locator</a>.</p></div>`;
    } else {
      const pager = [
        p!.page > 1 ? `<a class="btn ghost" href="/search?${esc(canonical(p!, p!.page - 1))}">&larr; Previous</a>` : "",
        res.hasMore ? `<a class="btn ghost" href="/search?${esc(canonical(p!, p!.page + 1))}">Next &rarr;</a>` : "",
      ].join("");
      results = `${storeNote}<p class="small muted">Showing ${(p!.page - 1) * PAGE_SIZE + 1}&ndash;${(p!.page - 1) * PAGE_SIZE + res.rows.length}${res.capped ? " of the first 200 matches (add a word or a filter to narrow it down)" : ""}. In-stock items first, then A&ndash;Z.</p>
      <ol class="results">${res.rows.map((r) => resultCard(r, ds.lastCleanAt, p!.store)).join("")}</ol>
      <nav class="pager" aria-label="Pages">${pager}</nav>`;
    }
  } else if (p && (p.q || p.kind || p.store)) {
    results = `<p class="status status-info">Type at least one letter or number to search.</p>`;
  }
  return layout(p?.q ? `“${p.q}”` : "Search", `<section class="wrap page">
  <p class="eyebrow">Search &middot; Beta</p>
  <h1>Find a bottle.</h1>
  ${statusBanner(ds)}
  ${searchForm(p, storesList)}
  ${results}
</section>`, { noindex: !!p?.q });
}

export function productPage(d: ProductDetail, ds: DataStatus): string {
  const p = d.product;
  const st = classify(p, ds.lastCleanAt);
  const info = statusInfo(p.status, p.status_label);
  const size = sizeLabel(p.size_ml, p.name);
  const countCell = (c: Stock["stores"], unit = "") =>
    c.value === null ? `<span class="muted">Unknown</span>`
    : c.stale ? `<span class="muted">Unknown</span><br><span class="small muted">last seen ${n(c.value)}${unit} on ${asOf(c.asOf)}</span>`
    : `<strong>${n(c.value)}</strong>${unit}<br><span class="small muted">as of ${asOf(c.asOf)}</span>`;

  // Per-store breakdown (only from store-detail fetches).
  const withStock = d.stores.filter((s) => (s.quantity ?? 0) > 0);
  const zero = d.stores.length - withStock.length;
  // Owner rule 2026-11-02: stores absent from an otherwise clean DABS list two Utah days running are shown as out of stock (inferred).
  const inferredZero = d.stores.filter((s) => (s.quantity ?? 0) === 0 && s.inferred === 1).length;
  // Freshness = verified_at (last validated re-check), not observed_at (last change).
  const storeAsOf = d.stores.reduce<string | null>((a, s) => (!a || s.verified_at > a ? s.verified_at : a), null);
  const rowStale = (s: { verified_at: string }) => Date.now() - Date.parse(s.verified_at) > STALE_MS;
  const storeStale = !storeAsOf || Date.now() - Date.parse(storeAsOf) > STALE_MS;
  const storeSum = withStock.reduce((a, s) => a + (s.quantity ?? 0), 0);
  const newerStatewide = st.verifiedAt && storeAsOf && st.verifiedAt > storeAsOf && !st.stores.stale;
  const mismatch = newerStatewide && st.stores.value !== null && st.stores.value !== storeSum;
  let storesHtml: string;
  if (!d.stores.length) {
    storesHtml = `<p class="status status-warn"><strong>Store-by-store counts haven&rsquo;t been collected for this product yet.</strong> ${
      st.state === "in_stock" ? `DABS reports ${n(st.stores.value!)} in stores statewide, but we can&rsquo;t say which stores.` : ""} Check the <a href="https://webapps2.abc.utah.gov/ProdApps/ProductLocatorCore/" rel="noopener">official DABS Product Locator</a> or call your store.</p>`;
  } else {
    const flags = [
      storeStale ? `<p class="status status-bad"><strong>Store counts are stale</strong> (last checked ${asOf(storeAsOf)}). Treat them as last known, not current.</p>` : "",
      mismatch ? `<p class="status status-warn"><strong>Store counts may be out of date:</strong> they add up to ${n(storeSum)}, but the newer statewide count is ${n(st.stores.value!)} (as of ${asOf(st.verifiedAt)}).</p>` : "",
    ].join("");
    const rows = withStock.map((s) => `<tr${storeStale || mismatch || rowStale(s) ? ' class="dim"' : ""}>
      <td><a href="/stores/${esc(s.id)}">${esc(`Store #${Number(s.id)} · ${titleCase(s.city ?? "")}`)}</a>${isClubStore(s.name) ? ` <span class="badge badge-off" title="Club store for licensed operations only; not open to the public.">Club only</span>` : ""}
        <br><span class="small muted">${esc(titleCase(s.address ?? ""))}, ${esc(titleCase(s.city ?? ""))}${s.phone ? ` &middot; <a href="tel:${esc(s.phone.replace(/[^\d]/g, ""))}">${esc(s.phone)}</a>` : ""}</span></td>
      <td class="num"><strong>${n(s.quantity ?? 0)}</strong>${!storeStale && rowStale(s) ? `<br><span class="flag">stale</span><br><span class="small muted">checked ${asOf(s.verified_at)}</span>` : ""}</td></tr>`).join("");
    storesHtml = `${flags}${STORE_VERIFY}<p class="small muted">Per-store counts last checked ${asOf(storeAsOf)}: ${withStock.length
      ? `${withStock.length} store${withStock.length === 1 ? "" : "s"} had it${zero ? `; ${zero} other store${zero === 1 ? "" : "s"} checked had none` : ""}`
      : `none of the ${zero} store${zero === 1 ? "" : "s"} checked had it`}.${inferredZero ? ` <span title="Not on the DABS store list two days in a row while the list otherwise added up exactly; treated as out of stock.">(${inferredZero} of the stores without it ${inferredZero === 1 ? "is" : "are"} inferred out of stock: missing from the DABS list two days running)</span>` : ""}</p>
      ${withStock.length ? `<table class="table"><thead><tr><th>Store</th><th class="num">Bottles</th></tr></thead><tbody>${rows}</tbody></table>` : ""}`;
  }
  return layout(displayName(p.name), `<section class="wrap page">
  <p class="eyebrow"><a href="/search">Search</a> &middot; ${esc(KIND_LABEL[p.kind] ?? "Other")}</p>
  <h1>${esc(displayName(p.name))}</h1>
  <p class="meta">${esc(size)}${size ? " &middot; " : ""}<strong>${esc(price(p.price_cents))}</strong> &middot; ${statusBadge(p.status, p.status_label)} <span class="muted">&middot; SKU ${esc(p.sku)}</span></p>
  ${statusBanner(ds)}
  <div class="card"><p>${stockPill(st)}</p><p class="small muted">${stockAsOf(st)}</p></div>
  <div class="grid three stats">
    <div class="card"><span class="tag">In stores statewide</span><p>${countCell(st.stores)}</p></div>
    <div class="card"><span class="tag">At the DABS warehouse</span><p>${countCell(st.warehouse)}</p></div>
    <div class="card"><span class="tag">On order</span><p>${countCell(st.onOrder)}</p></div>
  </div>
  <h2>Stores</h2>
  ${storesHtml}
  <h2>About this listing</h2>
  <p><strong>${esc(info.word)}:</strong> ${esc(info.note)} <span class="small muted">(DABS status ${esc(p.status ?? "?")}${p.status_label ? ` &ldquo;${esc(p.status_label)}&rdquo;` : ""})</span></p>
  <p class="small muted">DABS category: ${esc(p.category ? titleCase(p.category) : "none listed")}. Prices are DABS retail prices as last seen and can change.</p>
</section>`, { description: `${displayName(p.name)} ${size}: Utah availability from public DABS data.` });
}

export function storesPage(list: StoreInfo[], ds: DataStatus): string {
  const items = list.map((s) => `<li class="result"><a class="rname" href="/stores/${esc(s.id)}">${esc(`State Store #${Number(s.id)}`)}</a>${isClubStore(s.name) ? ` <span class="badge badge-off">Club only</span>` : ""}
    <p class="small muted">${esc(titleCase(s.address ?? ""))}, ${esc(titleCase(s.city ?? ""))}${s.phone ? ` &middot; ${esc(s.phone)}` : ""}</p></li>`).join("");
  return layout("Stores", `<section class="wrap page">
  <p class="eyebrow">Stores</p>
  <h1>Utah state liquor stores.</h1>
  <p class="small muted">${list.length} stores we&rsquo;ve seen in public DABS data. Club stores serve licensed operations only and aren&rsquo;t open to the public. Per-store counts exist for ${n(ds.storeLevelSkus)} product${ds.storeLevelSkus === 1 ? "" : "s"} so far.</p>
  <ol class="results">${items || "<li>No stores on file yet.</li>"}</ol>
</section>`);
}

export function storePage(s: StoreInfo, skusChecked: number, res: SearchResult, ds: DataStatus, storesList: StoreInfo[]): string {
  const club = isClubStore(s.name);
  const rows = res.rows.filter((r) => {
    // Drop per-store rows contradicted by a newer statewide zero (sold out since the store count was taken).
    const st = classify(r, ds.lastCleanAt);
    return !(st.state === "out" && st.verifiedAt && r.store_verified_at && st.verifiedAt > r.store_verified_at);
  });
  const dropped = res.rows.length - rows.length;
  const p = res.params;
  const pager = [
    p.page > 1 ? `<a class="btn ghost" href="/stores/${esc(s.id)}?${esc(canonical({ ...p, store: "" }, p.page - 1))}">&larr; Previous</a>` : "",
    res.hasMore ? `<a class="btn ghost" href="/stores/${esc(s.id)}?${esc(canonical({ ...p, store: "" }, p.page + 1))}">Next &rarr;</a>` : "",
  ].join("");
  return layout(`Store #${Number(s.id)}`, `<section class="wrap page">
  <p class="eyebrow"><a href="/stores">Stores</a> &middot; ${esc(titleCase(s.city ?? ""))}</p>
  <h1>State Store #${Number(s.id)}</h1>
  <p class="meta">${esc(titleCase(s.address ?? ""))}, ${esc(titleCase(s.city ?? ""))}${s.phone ? ` &middot; <a href="tel:${esc(s.phone.replace(/[^\d]/g, ""))}">${esc(s.phone)}</a>` : ""}</p>
  ${club ? `<p class="status status-bad"><strong>Club store for licensed operations only.</strong> This store isn&rsquo;t open to the public.</p>` : ""}
  ${statusBanner(ds)}
  <p class="status status-${skusChecked ? "info" : "warn"}">${skusChecked
    ? `We have per-store counts for only <strong>${n(skusChecked)}</strong> product${skusChecked === 1 ? "" : "s"} at this store so far, so this is <strong>not</strong> a full list of what&rsquo;s on the shelf. Anything not listed is unknown, not sold out.`
    : `<strong>No per-store counts collected for this store yet.</strong> We can&rsquo;t say what&rsquo;s on its shelves. Check the <a href="https://webapps2.abc.utah.gov/ProdApps/ProductLocatorCore/" rel="noopener">official DABS Product Locator</a> or call the store.`}</p>
  <form class="search compact" action="/stores/${esc(s.id)}" method="get" role="search">
    <label class="sr" for="q">Search this store</label>
    <input id="q" name="q" type="search" value="${esc(p.q)}" maxlength="80" placeholder="Search within this store">
    <button class="btn" type="submit">Search</button>
  </form>
  ${rows.length ? `${STORE_VERIFY}<ol class="results">${rows.map((r) => resultCard(r, ds.lastCleanAt, s.id)).join("")}</ol>` : `<p class="muted">${skusChecked ? "Nothing with a positive count here in what we&rsquo;ve collected." : ""}</p>`}
  ${dropped ? `<p class="small muted">${dropped} item${dropped === 1 ? "" : "s"} hidden: listed here earlier, but a newer statewide count shows none in stock.</p>` : ""}
  <nav class="pager" aria-label="Pages">${pager}</nav>
  <p class="small muted"><a href="/search?store=${esc(s.id)}">Search with more filters for this store</a> &middot; ${storesList.length} stores on file</p>
</section>`);
}

export function messagePage(title: string, msg: string, status = 404): { html: string; status: number } {
  return { status, html: layout(title, `<section class="wrap page"><div class="panel"><p class="eyebrow">${status}</p><h1>${esc(title)}</h1><p>${msg}</p><p><a href="/search">Back to search</a></p></div></section>`, { noindex: true }) };
}
