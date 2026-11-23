# Utah Remedy: Decisions Log

## 2026-10-21: Phase 0 foundation

### Architecture
- **One Worker, `utah-remedy`, using the Workers + static assets pattern** (TypeScript, no framework, no build step beyond wrangler's bundler). `run_worker_first: true` makes every request go through the Worker, so the age gate is enforced server-side even for static HTML.
- **Custom domains** (not zone routes) for `utahremedy.com` and `www.utahremedy.com`, so Cloudflare manages the DNS records and certs. `www` gets a 301 to apex in the Worker (path and query kept).
- `workers.dev` is left **enabled** (`https://utah-remedy.<account-subdomain>.workers.dev`) as a fallback/debug URL. Preview URLs are disabled. Consider turning workers.dev off (`"workers_dev": false`) before public launch.
- ~~No Cron Triggers and no data fetcher yet~~ (superseded: see Step 4 below).

### Age gate (21+)
- **Method:** date-of-birth entry (month/day/year) **plus** a required "I confirm I am 21 or older" checkbox, submitted as a plain HTML form POST (no JavaScript). Age is calculated server-side against today's date in America/Denver.
- **The birthdate is never stored or logged.** Only the result goes into a cookie.
- Pass: `ur_age21=1`, 30 days, `Secure; HttpOnly; SameSite=Lax`.
- Fail: `ur_under21=1`, 24 hours. During that window `/gate` sends the visitor to `/not-eligible`, so they can't retry right away. The polite block page links to the legal pages.
- Exempt from the gate: `/gate`, `/not-eligible`, `/terms`, `/privacy`, `/disclaimer`, `/health`, `/assets/*`, `/favicon.svg`, `/robots.txt`.
- Known limitation: like any cookie age gate, a determined user can fake the cookie. It is an honest-attestation gate, which is the usual standard for alcohol information sites. Revisit when accounts arrive (store `users.age_confirmed_at`).
- Return path (`next`) is limited to same-site relative paths (open-redirect safe).

### Disclaimer
- The Worker injects the disclaimer (HTMLRewriter, appended to `<body>`) into **every HTML response**, including the gate, legal pages, and 404, so it can't be left off a page by accident. Text lives in `DISCLAIMER_HTML` in `src/index.ts`.

### Legal pages: DRAFTS PENDING REVIEW
- `/terms`, `/privacy`, `/disclaimer` (`public/terms.html`, `public/privacy.html`, `public/disclaimer.html`) are **plain-language drafts that counsel has not reviewed**. Each file carries an HTML comment saying so. Nothing on the rendered page says "draft".
- Open items before public launch: legal review; add a real contact email/address (no contact address is published yet); entity name (Quazar16 LLC?) in the Terms; update the Privacy Policy before collecting emails (watches/alerts).

### Headers and caching
- Security headers on all responses: strict CSP (`script-src 'none'`, no inline styles), HSTS, nosniff, `X-Frame-Options: DENY`, Referrer-Policy.
- HTML is served with `Cache-Control: private, no-cache` and `Vary: Cookie`, so shared caches never mix up the gate and the landing page.

### Brand / copy
- Names used consistently: **Utah Remedy**, **Remedies** (points), **Concierge** (special-order help). Landing page says search, watches, and drop alerts are "coming soon", and Concierge and Remedies are "later in beta". No forms, sign-ups, payments, or subscriptions.
- Visual: dark ink background, amber (barrel) accent, Utah red-rock secondary color, serif headings. Mobile-first.

### Node / tooling
- Node **22.23.4** via **nvm** at `~/.nvm` (user-scoped). The system `/usr/bin/node` (v20.19.2) is untouched. `.nvmrc` = `22`. Requires `unset NPM_CONFIG_PREFIX` before sourcing nvm (box env).
- `wrangler` 4.151.3, `typescript`, `@cloudflare/workers-types` pinned exactly as devDependencies.
- Git: local repo only (branch `main`), no remote (GitHub isn't authenticated on the box).

## 2026-10-21: Data-source prototype

Full inventory: `docs/DATA-SOURCES.md`.

- **Primary source: the DABS Product Locator** (public, no login). We use the same endpoints its own page calls:
  - `POST …/Products/LoadProductTable`: JSON with SKU, name, category, status, price, and warehouse/store/on-order qty.
  - `GetDetailUrl` → `ProductDetail/Index`: HTML with per-store qty and store address/phone/lat-lng.
- **Robots and terms:**
  - abs.utah.gov robots.txt allows everything, with `Crawl-delay: 10`. webapps2 has no robots.txt, and we apply the same 10 s delay there.
  - No DABS-specific terms exist. The Utah.gov Terms/Disclaimer do not prohibit automated access; they cover abuse/tampering and say "personal or informational use… not modified".
  - **Open question for the owner:** whether to get counsel's read and/or ask DABS for a data feed.
- **Fetcher:** `src/fetchers/dabs-locator.ts`.
  - **User-Agent:** `UtahRemedyBot/0.1 (+https://utahremedy.com; independent Utah liquor availability service)`.
  - **Rate limits:** ≥ 10 s between requests (also tracked in KV across invocations), ≤ 12 requests per run, 20 s timeout, no retries within a run. The run stops at the first failure, and a 429/5xx sets a 1 h backoff in KV.
  - **KV cache:** keys `dabs:v1:table:<query>` and `dabs:v1:detail:<sku>` with a 30 min TTL. `dabs:v1:status` holds last_ok/stale, which `/health` reads.
  - **Validation is strict.** Any of the following fails the whole response:
    - a SKU that isn't 6 digits;
    - an unknown status code;
    - quantities that aren't integers ≥ 0;
    - a price that isn't a number;
    - more rows than `recordsFiltered`;
    - a non-JSON content type;
    - the requested SKU missing from the result;
    - on the detail page, a SKU different from the one requested;
    - a store table with an unexpected column count.
  - **Fail closed:** any of these statuses means nothing is written to products/stores/inventory_snapshots, and the KV status is marked `stale: true`:
    - `network_error`, `http_error`, `invalid_shape`;
    - `empty` (0 rows);
    - `suspicious`: either ≥ 3 SKUs that had stock in their last snapshot now all report 0 everywhere, or the result count dropped by more than 50% versus the last good total for the same query (when that total was ≥ 20).
  - **Single-product sellouts are NOT flagged.** A real allocated sellout must still come through.
  - Every attempt, including cache hits and skipped runs, gets a `fetch_log` row.
- **Data mapping:**
  - The product table writes upserts to `products` and one `inventory_snapshots` row per product with `store_id NULL`. That row stores warehouse qty in `quantity`, plus `store_total_qty` and `on_order_qty`.
  - The detail page writes upserts to `stores` and one snapshot per store (including qty 0, because the page lists them). Every snapshot carries `fetch_id`.
- **Manual trigger:** `POST /internal/fetch/dabs` requires `Authorization: Bearer <ADMIN_TOKEN>`.
  - The secret is set with `wrangler secret put` and is ≥ 32 chars. If it's unset, wrong, or the method isn't POST, the endpoint returns 404.
  - Comparison is constant-time.
  - Inputs are capped at 5 queries, 3 detail SKUs, and 50 rows per page.
  - The token's box copy is at `~/.config/utah-remedy/admin-token` (0600, not in git).
- ~~No Cron Triggers~~ (superseded in Step 4: the owner approved Option B).
- **Migration** `0002_fetch_log_and_locator_fields.sql` applied remotely:
  - adds the `fetch_log` table;
  - adds `products.status_label` and `products.on_spa`;
  - adds `inventory_snapshots.store_total_qty`, `.on_order_qty`, and `.fetch_id`.
- **Things to handle later:**
  - Store #34 is a "Club store for licensed operations only"; the UI must flag or filter it.
  - The allocated page has no SKUs, so name matching will be needed.
  - Detail snapshots include zero-qty rows, which adds storage volume.

## Step 4 (2026-10-21): hard caps, efficiency fixes, Option B enabled

The owner approved shipping the caps and efficiency fixes, then enabling **Option B only** (the nightly sweep) for a one-week usage check. Option A jobs (drop day, allocated, top-SKU store detail) come later, before the Nov 21 drop.

### Hard caps (`src/fetchers/guard.ts`)
- **Kill switch.** KV `dabs:v1:kill` (any value) or `FETCHER_ENABLED != "true"` blocks cron and admin fetching before any D1 write, lock, or DABS request.
  - Command: `npx wrangler kv key put --binding UTAH_REMEDY_CACHE dabs:v1:kill 1 --remote`
  - KV is eventually consistent, so allow up to ~60 s for it to take effect.
- **D1 daily budget.** Kept in `fetch_budget`, keyed by the America/Denver calendar day.
  - **Caps:** DABS requests 700 (1,600 on the 3rd Saturday, the drop day); D1 rows written 250,000; KV writes 3,000; runs 60 (150 on drop day).
  - **Reservation:** every DABS request is reserved first with an atomic `UPDATE … WHERE <all caps hold> RETURNING`.
  - **When a cap trips:** `exhausted_reason`/`exhausted_at` are recorded, fetching stops for the rest of that day, and one `fetch_log` row is written (`status='budget_exhausted'`).
  - **Overshoot:** rows and KV are metered from `meta.rows_written` and checked before each request, so overshoot is at most one page (+156 rows in tests).
- **Platform limits.** `wrangler.jsonc` sets `limits: { cpu_ms: 5000, subrequests: 300 }`.
- **Single-run lock** (`fetch_lock`, TTL 6 min).
  - It covers both cron and the admin endpoint; the admin endpoint returns 409 `locked`.
  - A crashed run's lock expires, and the next tick resumes from the sweep cursor.
- **Cron allow-list.** `EXPECTED_CRONS` in `src/index.ts`; any other expression is rejected and logged (`fetch_log.status='rejected_cron'`).
- **Per-run caps are kept.** 12 requests per run, a 10 s gap between requests (robots `Crawl-delay: 10`), and a 1 h backoff on 429/5xx.
- **Status in `/health → fetcher`:** enabled, kill switch, lock, budget used/cap, schedule, and last sweep. No secrets.

### Efficiency fixes (migration `0003_caps_latest_sweep.sql`, `src/fetchers/store.ts`)
- **`inventory_latest`** (WITHOUT ROWID, PK `(sku, store_key)`). Snapshots are written **only when a value changes**, or when a real observation replaces an inferred one. The table was backfilled from existing snapshots.
- **No-op upserts are skipped.** Product and store upserts use `ON CONFLICT DO UPDATE … WHERE <any column differs>`.
- **One snapshot index.** The two snapshot indexes were merged into `idx_inv_sku_store_time(sku, store_id, observed_at)`.
- **Table rebuilds.** `inventory_snapshots` and `fetch_log` were rebuilt without AUTOINCREMENT, and snapshots without FKs, to reduce write amplification. `fetch_log` is now one index `(source, started_at)`. The data was preserved: 101 snapshots and 5 logs remotely.
- **Fewer KV writes.** `last_request_at` is read once and written once per run, and status is written once per run. That is 3 KV writes per run instead of 3 per page.
- **Fixed false-zero guard.** The guard now reads `inventory_latest` by PK instead of scanning snapshots.
- **Out-of-stock detection** (`src/fetchers/sweep.ts`). SKUs that drop out of the in-stock list get an `inferred=1` snapshot with `store_total_qty=0` (warehouse/on-order NULL = unknown). This happens **only** after a COMPLETE sweep that:
  - had no failures;
  - was not degraded (total drift ≤ 2 and no short pages);
  - saw ≥ 98% of the reported total;
  - would vanish ≤ max(25, 10% of the previously in-stock count).

  Otherwise vanish is skipped and the reason is recorded in `sweep_state.vanish_skipped`.
- **Fail-closed sweep.**
  - Any page failure, or a total below 50% of the last complete sweep, marks the day's sweep `failed`; no vanish follows, and the day gets no more ticks.
  - The admin path keeps the Step 2 fail-closed checks.
- **TODO: 90-day retention/rollup (F7)** is not built. Snapshot growth is only ~5–11 MB per month, so this is not urgent.
- **Stale `running` rows.** A run killed mid-flight (CPU limit or eviction) leaves its `fetch_log` row as `running`. Treat `running` rows older than 10 minutes as crashed.

### Option B schedule
- **Cron `*/5 8 * * *`.** Workers cron runs in UTC: 08:00–08:55 UTC, which is **01:00–01:55 MST** (Nov–Mar) and **02:00–02:55 MDT** (Mar–Nov). Both stay within the 1–3 AM America/Denver window, so no change is needed at the DST switch (Nov 1 2026 → 1 AM MST).
- **Ticks.** There are 12 ticks per night. Each tick fetches up to 12 pages of 50 rows with a stride of 48, at ≥ 10 s spacing (~2 min per tick). The current ~5,456 in-stock items take ~114 requests over ~10 ticks.
- **Capacity.** About 6,900 in-stock items. Beyond that, move to `*/4 8 * * *`.
- **First run.** A full sweep (114 requests) would have exceeded the "~110 more DABS requests today" limit, so **no manual sweep was run**. Tonight's cron (Oct 22, 08:00 UTC = 2:00 AM MDT) is the first sweep. Production got a single-request smoke test only.

### Tests (local, mock DABS: 700 in stock + 100 out of stock): all passed
| # | Test | Result |
|---|---|---|
| T1 | Fresh sweep | 15 pages over 2 ticks via the cursor; the 3rd tick was a no-op; 4,986 rows (~7.1 per new SKU); 3 KV writes |
| T2 | Unchanged sweep | **86 rows** over 15 pages; 3 KV writes |
| T3 | 30 changed + 10 vanished | 206 rows (+3 per item); inferred rows have total 0 and warehouse NULL |
| T4 | HTTP 500 mid-sweep | Sweep failed with no vanish (in-stock stayed 690), backoff set, later ticks no-ops |
| T5 | badshape / empty / html page | Sweep failed each time |
| T6 | List drift during the sweep | Degraded; vanish skipped, which avoided 8 false zeros |
| T7 | Short page | Vanish skipped |
| T8 | Mass vanish (155/690) | Skipped |
| T9 | Total collapse (535 → 135) | Flagged suspicious; sweep failed |
| T10 | Kill switch (cron and admin) | Blocked, with 0 D1 writes and 0 fetch_log rows |
| T11 | Request cap | Tripped at 700 and logged once; sweep left `running`; no vanish |
| T12 | Rows cap | Tripped at 250,156 |
| T13 | KV cap | Recorded at 3,001; the next run was blocked |
| T14 | Runs cap | Blocked at run start |
| T15 | Overlap | A 2nd tick and an admin call during a run both returned `locked` (logged) |
| T16 | Crash at page 8 | Lock blocked until its TTL; the next tick resumed at start=384 and completed with 700 seen |
| T17 | Unexpected cron `* * * * *` | Rejected and logged; `*/5 8 * * *` ran |
| T18 | Admin fail-closed + `FETCHER_ENABLED=false` | allzero, badshape, html, empty, and skumismatch all failed closed; a good query changed 0 rows; both paths blocked when disabled |

### Production (2026-10-21)
- Migration 0003 was applied remotely, and `FETCHER_ENABLED=true` was deployed.
- **Smoke test.** One DABS request (SKU 018006). Status ok, 0 data rows changed, and the run wrote 9 D1 rows in total (lock, budget, log).
- **Budget after the smoke test.** 1 of 700 requests and 1 of 60 runs used.

## 2026-10-21: Legal page operator/contact update; workers.dev disabled

### Legal pages (`public/terms.html`, `privacy.html`, `disclaimer.html`)
- **Operator.** Each page now says Utah Remedy is a service of **Quazar16 LLC**: Terms and Privacy in the intro, Disclaimer under "Independent service".
- **Contact.** Each page gained a short Contact section with **hello@utahremedy.com**. The shared footer had no contact placeholder, so it is unchanged.
- **Birthdates not stored.** Terms §1 (Eligibility) and Privacy (Age check) now say explicitly that birthdates entered at the age gate are not stored. Only a pass cookie (30 days) or a block cookie (24 hours) is set, which matches the code in `src/index.ts` (`handleGate`).
- **Unchanged:** the DABS non-affiliation language, the instruction to verify with the store before traveling (Disclaimer and Terms), and the plain-language style. "Last updated" stays at October 21, 2026.
- **Still drafts.** They remain *Draft, pending legal review*: no counsel has reviewed them. Per the Phase 0 instruction, the draft marker stays in an HTML comment on each page plus this file; it is not shown to visitors.

### workers.dev disabled
- **Config.** `wrangler.jsonc` now has `workers_dev: false`; `preview_urls` was already `false`. `utah-remedy.<account-subdomain>.workers.dev` now returns Cloudflare error 1042 (404).
- **Only public entry point:** the custom domain `utahremedy.com`, with www redirecting 301 to the apex.
- **Unchanged:** the cron `*/5 8 * * *`, both custom domains, `limits`, `FETCHER_ENABLED`, the D1/KV caps, the kill-switch key, and per-run caps.
- **Local dev.** `wrangler dev` is unaffected.

### Email (read-only check, nothing changed)
- **Already configured.** Cloudflare Email Routing is already enabled for utahremedy.com. Its status is `ready`, set up by the owner on 2026-10-21, 5:54 PM MDT.
- **DNS.** MX records are route1/2/3.mx.cloudflare.net, and SPF is `v=spf1 include:_spf.mx.cloudflare.net ~all`.
- **Rule.** `hello@utahremedy.com` forwards to the owner's verified Gmail. The catch-all rule is set to drop.
- **No DMARC record yet.** It is not needed for receiving mail.

## 2026-10-21: Beta phase 2: search, product and store views

### Scope
- **Shipped:** search, product and store pages, plus JSON equivalents:
  - `/search`
  - `/product/:sku`
  - `/stores`
  - `/stores/:id`
  - `/api/search`, `/api/product/:sku`, `/api/stores`, `/api/stores/:id`

  All are behind the 21+ gate (they are not in `PUBLIC_PATHS`). Visitors without a cookie get a 302 to `/gate?next=…`; under-21 visitors go to `/not-eligible`. Legal pages and `/health` are unchanged.
- **Not added (per owner):** watches, notifications, Concierge, Remedies, reports, accounts.
- **Untouched:** fetcher, cron, caps and kill switch. `src/fetchers/*` has no changes.
- **Landing page:** the hero gained a search box, and the Search card now says "Beta".

### Data mapping
- **Type.** Comes from the DABS `displayGroup` (stored as `products.category`), via the SQL view `product_search_source`. That view is the single source of truth.
  - Keyword rules map to beer (BEER / MALT / ALE / LAGER / SELTZER), cider, premixed, spirits (WHISK*, BOURBON, SCOTCH, VODKA, GIN, RUM, TEQUILA, MEZCAL, BRANDY, COGNAC, LIQUEUR*, CORDIAL*, SCHNAPPS, SPIRIT*, …), then wine (WINE*, RED, WHITE, ROSE, BLUSH, SPARKLING, CHAMPAGNE, PORT, SHERRY, MADEIRA, VERMOUTH, MARSALA, SAKE).
  - When the group is ambiguous ("ALLOCATED ITEM", "LIMITED OFFERS", "GIFT & SPECIAL ORDER"), strong keywords in the product name decide. Otherwise the type is "other".
  - The top-level DABS category list (40 groups, read from the public Product Locator page) informed the rules. The first full sweep will show how many land in "other"; refine the rules then.
- **Brand.** DABS publishes no brand field. Brand search works because DABS names start with the brand ("BUFFALO TRACE BOURBON"). There is no brand facet.
- **Name search.** FTS5 prefix tokens over name + category. Apostrophes are stripped on both sides, so "blantons" matches "BLANTON'S" and "blanton" matches both spellings.
- **Status in plain words.** These follow the official abs.utah.gov status-code table:

  | Code | Plain words |
  |---|---|
  | 1 | General |
  | L | Limited (select stores) |
  | A | Allocated |
  | T | Trial |
  | S | Special order only |
  | D | Discontinued |
  | X | Discontinued (limited) |
  | U | Going unavailable ("will be unavailable shortly") |
  | N | Unavailable |
  | P | Limited availability |

  DABS publishes no description for P, so its own label is shown. The DABS label is always shown alongside.
- **Club stores.** Store #34 (Park City) **and #33** (Salt Lake City) are "Club store for licensed operations only". They are detected from the DABS store name and badged "Club only" everywhere, and the store page carries a banner.

### Fail-closed freshness (`src/web/catalog.ts`)
- **Statewide store count.** Confirmed at `max(observed_at, last CLEAN complete sweep)`. `observed_at` only moves on change, and a clean sweep re-confirms every product-level row: seen, inferred-vanished, or not on the in-stock list.
- **Warehouse and on-order.** Re-confirmed by a sweep only when the SKU was in the in-stock list; otherwise they fall back to `observed_at`.
- **Per-store rows.** Use `max(observed_at)` as their as-of. This is conservative: it can say "stale" when the data is actually fresh, never the reverse.
- **Stale cutoff.** Anything older than **36 h** is shown as "Unknown · data is stale (last confirmed …)", never as a current count.
- **Unknown vs out.** No row means "Unknown · not checked yet". Zero is shown as "Not in stock at any store" only when it is confirmed fresh. A zero inferred by a clean sweep is labeled as such on the product page.
- **Global banner.** Driven by `sweep_state` (the run states are labeled in the UI):

  | State | Meaning |
  |---|---|
  | ok | Last clean sweep is fresh |
  | running | Tonight's sweep is in progress |
  | failed | Latest sweep failed; showing the last clean data |
  | incomplete | Latest sweep had gaps (vanish skipped, or stuck > 2 h) |
  | stale | Last clean sweep is older than 36 h |
  | never | No clean sweep yet |

  It always gives an "as of" time in America/Denver (MDT/MST).
- **Store breakdown.** Flagged when it is stale, or when it no longer adds up to a newer statewide count. Store pages hide per-store rows contradicted by a newer statewide zero.
- **D1 errors.** Return 503 "data temporarily unavailable" (HTML or JSON). They are never cached and never show partial data.
- **Ordering.** Results are sorted "fresh in stock" first, using the same rule, then A–Z.

### Cost controls (details: `docs/COST-PROJECTION.md` §9)
- **No DABS calls from user requests.** D1 only.
- **Migration `0004_search.sql` (additive only):**
  - view `product_search_source`;
  - FTS5 table `product_search` (`detail=column`), backfilled;
  - insert, update-of-name/category and delete triggers on `products`;
  - partial index `idx_latest_store (store_key, sku) WHERE store_key <> ''`, so product-level writes don't touch it.
- **No bm25 ranking.** Ranking reads a size row for every match. Instead, the first 200 matches in index order are taken, filtered, then sorted. Caps: query 80 characters and 6 tokens, 20 results per page, 10 pages.
- **Caching.** Cache API, free and per data center: 5 min for pages; status 5 min; store list and coverage 1 h. Zero KV writes. Browser caching is `private`, and pages vary on Cookie.
- **Rate limit.** `ratelimits` binding `SEARCH_LIMITER`, namespace `730116`, 60 per 60 s per IP. It applies only on cache misses; cached pages keep serving.
- **Diagnostic headers.** `X-UR-Cache: HIT|MISS` and `X-UR-D1-Rows-Read`, used to measure cost. They contain no secrets.

### Tests (local: synthetic 5,457-product catalog via `scripts/seed-catalog.py`; live: real 9-product data)
- **Gate:** every new route redirects without a cookie; under-21 visitors go to `/not-eligible`; the legal pages and `/health` stay public.
- **States:** all five stock states, and all six banner states (ok, failed, incomplete, stale, never, and the D1-error 503).
- **Edge cases:** club badges; per-store stale and mismatch flags; a store with no per-store data; 404s; SKU padding redirect; 405 on POST.
- **Hostile input:** FTS syntax and HTML/script input are neutralised.
- **Rate limit:** the 429 path works, and cached pages still serve while limited.
- **Measured costs:** rows read per request as in COST-PROJECTION §9. Trigger write costs were measured on production D1 with a throwaway SKU `000000` inserted, changed and deleted in a single command.

### Needs owner input
1. **Per-store coverage is tiny.** Only 2 SKUs (from the Step 2 prototype) have per-store rows, because the nightly sweep only returns statewide totals. Store pages and the store filter will stay mostly empty until a store-detail job exists (Option A-style, 1 DABS request per SKU). Which SKUs, and what budget?
2. ~~**The catalog is only what appears in the in-stock list.**~~ *(Done 2026-10-22: monthly Product List XLSX import, see below.)* That is ~5.5k of ~26k SKUs; out-of-stock and special-order items aren't searchable. Options:
   - import the monthly DABS product-list XLSX (1 request/month; names, status, category, no quantities);
   - or a rare full-catalog sweep (~550 requests).
3. **Fetcher `verified_at`.** Per-store as-of times are conservative, because `observed_at` only moves on change. When the store-detail job ships, the fetcher should record a `verified_at`. That is a fetcher change, so it was not done here.
4. **Optional saving.** Excluding `/assets/*` from `run_worker_first` would roughly halve Worker invocations per page view. That is a config change to the gate path, so it was not done without approval. *(Done as item 4 below, with exact files instead of `/assets/*`.)*

## 2026-10-21: Item 4: pure static files bypass the Worker (gate unchanged)

Approved by the owner: serve CSS, icons and other pure static files without a Worker invocation, with every HTML/dynamic route still Worker-first so the 21+ gate keeps applying. No other behavior change.

**Config.** `assets.run_worker_first` changed from `true` to an array:
`["/*", "!/assets/style.css", "!/favicon.svg", "!/robots.txt"]`. Negations win over `/*`, and `/*` already covers `/` (wrangler rejects `"/"` as redundant).
- **Exact files, not `!/assets/*`.** Local testing showed that with `not_found_handling: "404-page"`, the asset layer answers a *miss* under a bypassed glob (e.g. `/assets/missing.css`, `/assets/x.html`) with `404.html` itself: HTML served without the Worker, so no disclaimer and no CSP. With exact files, every miss, trailing-slash variant and traversal attempt falls to the Worker exactly as before.
- **Guard.** `scripts/check-assets.sh` runs first in `npm run deploy`. It fails if any bypass entry is a glob, `.html`, a directory or a missing file, or if any HTML exists under `public/assets/`. New CSS, font or image files must be added to the list explicitly.
- **`public/_headers`** (static responses only) gives the bypassed files nosniff, Referrer-Policy, HSTS and X-Frame-Options. There is deliberately no CSP (not meaningful for CSS/SVG/text), which also makes direct-asset responses distinguishable from Worker responses. `/_headers` itself is not served (Worker gate → 302).
- **Unchanged:** fetcher, cron `*/5 8 * * *`, caps, kill switch, D1/KV, `html_handling`, `not_found_handling`, routes, custom domains, and all Worker code.

**Deployed:** version `d0127af4-b464-4b35-bf39-299c421379e6` from commit `6c9c1cc` (`/health` reports `commit: 6c9c1cc`). This entry is a docs-only follow-up commit and was not redeployed.

### Live verification (2026-10-21 ~7:46 PM MDT)
- **Ungated (no cookie)**, all Worker → `302 /gate?next=…`: `/`, `/search`, `/search?q=vodka`, `/product/018006`, `/stores`, `/api/search`, `/index.html`, `/index`, `/search.html`, `/product/018006.html`, `/404.html`, `/_headers`, `/ASSETS/style.css`, `/favicon.svg/../search`, `/assets/../index.html` and `/assets/%2e%2e/index.html` (both with `--path-as-is`).
- `/gate.html` and `/terms.html` → 307 to the clean public path. `/assets/..%2findex.html` → 307 `/index.html` → gate.
- **Asset misses go through the Worker:** `/assets/missing.css`, `/assets/x.html`, `/assets/style.css/` and `/assets/style.css.html` → 404 with CSP and the disclaimer, as before.
- **Direct static, no Worker:** `/assets/style.css`, `/favicon.svg` and `/robots.txt` → 200 with `cache-control: public, max-age=0, must-revalidate`, an ETag, `cf-cache-status: HIT`, the `_headers` set, and **no** CSP, `Vary: Cookie` or `private, no-cache`. Before the deploy, `style.css` carried the Worker CSP.
- **`wrangler tail --format json`** during the run logged 40 events: every HTML/API/`.html`/miss request, and **0** for the tagged `style.css`, `favicon.svg` and `robots.txt` requests.
- **With cookie:** POST `/gate` (`affirm=yes`) → 303 `/search` and sets `ur_age21`. Then `/`, `/search?q=vodka`, `/product/018006`, `/stores`, `/stores/0008` and `/api/search` → 200, with the disclaimer on HTML.
- **Public pages** `/gate`, `/terms`, `/privacy`, `/disclaimer`, `/not-eligible` → 200 with CSP and the disclaimer.
- **`/health`** → ok, d1/kv true, kill_switch false, caps 700 DABS / 250,000 rows / 3,000 KV / 60 runs, schedule `*/5 8 * * *`. The deploy output listed both custom domains and the schedule.

### Known side effect
`https://www.utahremedy.com/assets/style.css`, `/favicon.svg` and `/robots.txt` now return 200 directly instead of the Worker's 301 to the apex. `run_worker_first` matches paths, not hostnames. HTML on www still 301s (e.g. `/search`). This is harmless (identical public static bytes, no gate relevance, and pages only reference the apex). Fixing it would need a Cloudflare redirect rule or a www route change, which is a DNS/zone change, so it was not done.

## 2026-10-22: Full-catalog import (monthly DABS Product List)

Owner-approved: import DABS's monthly product list so every listed product is searchable (name, status, category) without quantities, after the first nightly sweep was confirmed clean (Oct 22: 114 requests all 200, 5,453 in stock, no errors).

### Source
- **Page:** https://abs.utah.gov/shop-products/interactive-product-list/ (public, no login). It links exactly one XLSX per DABS fiscal period, currently `https://abs.utah.gov/wp-content/uploads/Oct-2026-Product-List-FY27-P3.xlsx` (951 KB, Last-Modified Oct 1 2026 13:37 UTC = 7:37 AM MDT).
- **robots.txt** (re-checked Oct 22): `User-agent: * / Disallow:` with `Crawl-delay: 10`. We keep the shared ≥ 10 s gap and the identifying User-Agent.
- **Contents:** 9,994 products, one worksheet with inline strings. Columns: CSC, Description, Div/Dept/Class codes, Size, Retail Price, Item Status, On Spa, Vendor, Div/Dept/Class names.
- **Not ~26k.** The list is the *current fiscal period* catalog: statuses S 5,312, 1 2,814, L 1,504, T 282, D 69, X 13. Allocated (A), unavailable (N/U) and retired SKUs are not on it. The locator's 26,340 total includes those. Allocated items still come in through the nightly sweep when they're in stock.

### Design (`src/fetchers/catalog-list.ts`, migration `0005_catalog_import.sql`)
- **Cron:** `30 9 2-8 * *` = 02:30 MST / 03:30 MDT on days 2–8 of each month, after the sweep window. Added to both `wrangler.jsonc` and `EXPECTED_CRONS`. Day 1 is skipped because DABS posted October's file mid-morning on the 1st.
- **Per America/Denver month:**
  - The tick fetches the page and requires exactly one `*Product-List*.xlsx` link under `https://abs.utah.gov/wp-content/uploads/`.
  - If that link is the same file as the last complete import, the month is `waiting`: no XLSX request, and at most one page check per day.
  - Otherwise it downloads, validates, stages and applies.
  - Once the month is `complete`, every later tick is a no-op with 0 DABS requests.
  - `failed` retries at most once per day, 3 times per month. After that it needs a manual run.
- **Caps:** the same as every fetch. Kill switch and `FETCHER_ENABLED`, the single-run lock, the daily budget (each request is reserved, and runs, D1 rows and KV writes are metered), 1 h backoff on 429/5xx, and `fetch_log` rows (`source='dabs-catalog'`, kinds `catalog_page`, `catalog_xlsx`, `catalog_apply`). PoliteClient is capped at 2 requests per run.
- **Fail closed:** nothing is written to `products` if any check fails.
  - **Download:** HTTP 200, a spreadsheet/zip content type, and a size of 100 KB–15 MB.
  - **File structure:** a valid zip, exactly one worksheet, an 80 MB inflate cap, and the required header columns.
  - **Rows:** every row has a 6-digit unique CSC, a non-empty name, a known status code, a numeric price and a Yes/No On Spa value.
  - **Plausibility:** ≥ 5,000 rows, ≥ 70% of the last complete import, and ≥ 60% of currently in-stock SKUs present on the list (wrong-file guard; today 86%).
  - Tested locally: garbage bytes, a 3,000-row file, a missing column, a bad status, SKU-shifted ("wrong") file, row-count drop, 0 or 2 links, kill switch, unexpected cron → all failed/blocked with 0 product writes. A shared-strings XLSX (openpyxl) parses identically.
- **Change-only, chunked apply:**
  - The validated list is staged in KV (`dabs:v1:catalog:staged:<YYYY-MM>`, 1 write, 40-day TTL).
  - The apply reads `products` once, then writes only:
    - **new SKUs:** `INSERT … ON CONFLICT DO NOTHING`, `data_source='catalog'`;
    - **changed catalog-owned rows:** a guarded `UPDATE`.
  - The FTS index updates through the existing triggers.
  - A cursor in `catalog_import.next_index` lets it stop at 120k rows per run or 200k rows per day (cap 250k) and resume next tick from KV, with no new DABS request.
- **Live data wins:**
  - Rows the Product Locator wrote (`data_source` NULL) are never touched by the import.
  - The locator upsert now sets `data_source=NULL`, so the first time the sweep sees a catalog item it takes the row over. That is a one-time write.
  - Status labels for list rows use the locator's own label text (e.g. "Special Order").
  - Products that drop off a later list are left as they are (not deleted).
- **UI:** no ranking change. Order is still fresh in-stock first, then A–Z. Catalog-only products have no `inventory_latest` row, so they classify as **unknown** ("Unknown · not checked yet", with a note that the item is on the DABS product list but not in the nightly in-stock list), never "out of stock". The no-match and SKU-404 texts mention the monthly list. Disclaimer/legal text is unchanged.
- **`/health`:** `fetcher.schedule` lists both crons, and `fetcher.last_catalog_import` shows the month's status and counts.

### Production (2026-10-22)
- **Rollout:** migration 0005 applied remotely, then deployed as Worker version `1e929432-740b-4782-bbef-d6e428cd2190` from commit `3d23bf6`. Deploy output listed both schedules and both custom domains.
- **First import:** run via the admin endpoint (`{"catalogImport":true}`) at 8:24 AM MDT. Results:
  - **requests:** 2 DABS requests, both 200;
  - **rows:** 9,994 validated; **5,308 inserted** as catalog-only; 4,686 skipped because the locator owns them;
  - **cost:** 26,540 D1 rows written by the apply; **789 ms CPU**, 21 s wall.
- **Products searchable:** 5,461 → **10,769** (FTS rows 10,769).
- **Day budget after the import:** 116/700 requests, 70,835/250,000 D1 rows, 13/3,000 KV writes, 11/60 runs. Nothing exhausted, no `running` fetch_log rows, lock free, kill switch off.
- **Live checks:**
  - `/api/search?q=fighting+cock` returns 018276 FIGHTING COCK BOURBON with status S "Special order" and `stock.state="unknown"`, all counts null.
  - `bulleit` and `clyde may` show in-stock items first, then A–Z, with catalog-only items as unknown.
  - Broad `bourbon` returns all in-stock on page 1 (999 rows read, as before).
  - Without the cookie, `/api/search` and `/product/018276` still 302 to `/gate`.
  - `/health` ok.
- **Estimates:**
  - **First import:** ~26.6k rows.
  - **Monthly after:** ~20–3,000 rows (17 rows measured for an unchanged list; +3 per price/status change, +~5 per new item).
  - **Allowance and cost:** at most 0.06% of the 50M included rows. $0 incremental.

### Notes / follow-ups
- About 15.6k locator SKUs (allocated, unavailable, retired) are still not searchable unless they're in stock. Covering them would need a rare full locator sweep (~530 requests), which is not approved.
- Task B (per-store quantities) is estimate-only: `docs/per-store-estimate.md`.

## 2026-10-22: Per-store refresh, option B1 only (allocated SKUs, daily)

Owner approved B1 from `docs/per-store-estimate.md`: status-A SKUs with any stock (store, warehouse or on-order > 0), once a day after the nightly sweep. **B2 (limited items) is not enabled and not implemented.** `PERSTORE_REFRESH` only recognises `"allocated"`, and `PERSTORE_CONFIG.limited = false`.

### verified_at (migration `0006_perstore_verified.sql`, additive)
- `inventory_latest.verified_at TEXT NULL`. Every validated per-store fetch sets it for every listed store. `observed_at` still moves only when the count changes (a snapshot is written only on change). Existing rows are NULL, and the UI falls back to `observed_at` (`COALESCE(verified_at, observed_at)`).
- The UI uses verified_at for the 36 h stale rule on product pages (per row, plus the "last checked" summary), the store page, the search store line, and `at_store.as_of`. Search ORDER BY is unchanged (product-level `observed_at`).
- `perstore_state` has one row per MT day: queue, cursor, ok/failed, stores verified/changed, requests, status `running|complete|failed|skipped|capped`.

### Schedule
- Cron `*/5 10 * * *`: 10:00–10:55 UTC, i.e. **04:00–04:55 MDT** (through Nov 1, 2026) and **03:00–03:55 MST** after that. It is added to `EXPECTED_CRONS`, so any other expression is still rejected.
- A tick does nothing unless today's `sweep_state` is `complete`. Otherwise the day is marked `skipped` and logged once. The sweep normally finishes around 08:45 UTC.
- Each tick does up to 6 SKUs (12-request per-run cap, 2 requests per SKU, 10 s gap). 43 SKUs means ~8 ticks, done by ~10:40 UTC.

### Guards
- These are the same as the sweep: kill switch (`FETCHER_ENABLED` and KV `dabs:v1:kill`), run lock, cron allowlist, daily budgets (700 / 1,600 on drop day; D1 rows; KV; runs), PoliteClient gap and backoff, and the per-tick cap.
- Extra B1 limits: at most 60 SKUs per day, and B1 stops when the day's total DABS requests would pass min(400, the daily cap). That status is `capped`. B1 does no KV cache writes.
- Expected total is ~114 (sweep) + ~86 (B1) ≈ 200 requests/day, under 700.

### Fail closed
- `validateStoreList` rejects:
  - duplicate store ids;
  - a missing statewide row;
  - a per-store sum that doesn't **exactly** equal the statewide `store_total_qty` from the sweep (it runs about 1 h after the sweep, while stores are closed);
  - any store previously stocked that is missing from the list.
- On rejection (`incomplete`), shape errors or HTTP errors, nothing is written, verified_at is not advanced, and nothing is zeroed. Missing stores are never zeroed. Each SKU is logged in `fetch_log` (kind `perstore_detail`).
- Day-level events are logged under kind `perstore`: `skipped`, `failed`, `capped`, `budget_exhausted`.
- HTTP 429/5xx stops the tick and triggers the 1 h backoff, which effectively ends that night's run. The failed SKU is skipped, not retried.
- Three consecutive non-`incomplete` failures mark the day `failed`.
- The admin `storeDetailSkus` path uses the same validation.

### Verification (2026-10-22)
- Local run against the mock (`scripts/mock-dabs.py` ProductDetail scenario covered:
  - the happy path, and an unchanged re-check that advanced verified_at with observed_at unchanged;
  - a short list or extra bottle giving `incomplete` with no writes;
  - bad shape three times giving `failed`;
  - HTTP 500 giving a stop plus backoff;
  - the kill switch;
  - the sweep-not-complete skip;
  - the stale flag at > 36 h.
- Production: Worker version `5cfbda30-ae80-4730-b1ee-5cd52418046d` (commit ba1c176).
  - Gate redirects are intact for /search, /product/017920, /product/016850 and /stores/0001.
  - /health is ok with 3 crons, unchanged caps, and `perstore.mode = allocated`, `limited_b2 = false`.
- A manual admin re-check of 016850 (3 requests) returned 41 stores, 0 changed. verified_at was set on all 41 rows (observed_at stayed Oct 21), and the product page shows "Per-store counts last checked Oct 22, 1:46 PM MDT".
- The first real B1 run is **Fri Oct 23, 2026, 04:00 MDT**.

## 2026-10-22: Popular-100 per-store refresh (built and enabled)

Owner approved the starter list as-is (`docs/popular-100-starter.csv`, commit 9cb1268) and widening the early-morning pass. Plan and list: `docs/popular-100.md`. Code: commit 19fd8c0; Worker version `11261afe-db52-47fb-910f-ca59dfb70aea`.

### Data (migration `0007_perstore_popular.sql`, additive)
- `perstore_popular(sku PK, rank, locked, source, note, added_at, updated_at)`, seeded with the 100 CSV rows (rank = CSV rank).
- **Active list** = every locked row + the best-ranked unlocked rows, 100 in total (computed at query time). Extra rows are inactive reserve, kept rather than deleted.
- Trigger `perstore_popular_keep_locked` aborts any DELETE of a locked row. Admin remove returns 409 for locked rows, and any future weekly rotation must only rewrite unlocked rows.
- `perstore_state` gains `b1_total`, `popular_total` and `popular_note`. The queue stays one frozen list per Mountain-time day: B1 SKUs first, then popular.
- **Blanton's:** the catalog has four Blanton's SKUs. Only **016850** (Single Barrel, status A) is a current product, so it is the only one locked. 016873 (Gold SBS), 016874 (Sazerac Barrel Select) and 921500 (Barrel Select) are status U (unavailable) and were not locked.
  - 016850 is status A with 0 store qty and 90 on order, so B1 already fetches it (the dedupe means no second fetch). Once B1 stops covering it, the lock keeps it in the popular list.
  - Locking it pushed CSV rank 100 (026484 Willett 4yr Rye) into reserve.

### Schedule
- Per-store cron `*/5 10 * * *` → **`*/5 10-12 * * *`**: 36 ticks, 10:00–12:55 UTC = **04:00–06:55 MDT** (through Nov 1, 2026), then 03:00–05:55 MST. It is in both `wrangler.jsonc` and `EXPECTED_CRONS`; the old expression is now rejected.
- Unchanged: sweep `*/5 8 * * *`, catalog `30 9 2-8 * *`, per-tick caps of 12 requests and a 10 s gap.
- At most ~143 SKUs at 6 per tick is ~24 ticks. The first tick (04:00 MDT) finds the sweep complete, so the run should finish ~06:00 MDT. The remaining ticks are 1-row-read no-ops (each charges no run).

### Guards
- Separate daily SKU limits: B1 `PERSTORE_MAX_SKUS` = 60 and popular `POPULAR_MAX_SKUS` = 100.
- `PERSTORE_DAY_REQUEST_CEILING` 400 → **500**. A SKU only starts if today's DABS requests (sweep included) + 2 ≤ min(500, the day cap of 700, or 1,600 on the 3rd Saturday). Otherwise the day is `capped`.
- Fetch order: B1, then popular, which runs locked first and then by rank.
- Popular skips SKUs already in that day's B1 queue and SKUs with statewide store qty 0 (they stay in the list).
- Popular is skipped on 3rd-Saturday drop days (`isDropDay`).
- On/off without a deploy: KV `perstore:v1:popular` = `on`/`off` (a missing key means off). It is read every tick, so turning it off mid-run stops after the B1 part. It was set to `on` 2026-10-22 via `POST /internal/popular/flag`.
- Unchanged: kill switch, `dabs` lock, budgets (`runs` 60/day is enough: sweep ~12 plus per-store ~24), 429/5xx backoff, the sweep-complete prerequisite, and fail-closed `validateStoreList`/`writeStoreDetail`. A failure writes nothing, doesn't advance verified_at and never zeroes; 3 consecutive non-incomplete failures fail the day.
- Product pages render store counts straight from D1 (no DABS call). The "Verify with the store before you travel" notice stays directly above the store table; its wording now says "allocated and popular bottles".

### Admin (ADMIN_TOKEN, 404 otherwise; D1/KV only, never DABS)
- `GET /internal/popular` lists entries.
- `POST /internal/popular/{lock,unlock,add,remove}` takes `{"sku":...}` validated against `products`.
- `POST /internal/popular/flag` takes `{"popular":"on|off"}`.
- More than 100 locks is refused. curl usage is in docs/OPERATIONS.md ("Popular-100 admin").

### Verification (2026-10-22)
- **Local (mock DABS, local D1):**
  - B1 6 + popular 95 = 101 SKUs. The 2 dedupes (an A popular item and Blanton's) and 3 zero-qty skips were correct.
  - Injected `short` → `incomplete` and `badshape` → `invalid_shape`, both with no writes.
  - Flag off at queue build gave B1 only. Flag off mid-run gave `complete` after B1, with a note.
  - Ceiling: from 492 used, the day capped at exactly 500.
  - The old cron was rejected, and the admin 400/404/409 paths worked.
- **Production:**
  - /health ok, 3 crons including `*/5 10-12 * * *`, popular flag on, 101 entries / 100 active / 1 locked.
  - Gate 302 for /search and /product/016850.
  - Admin 404 without or with a wrong token; with the token, 100 active and 016850 locked.
  - TTFB with the age cookie ~0.11–0.22 s (018006, 088739, 905253, 016850).
  - **Zero DABS requests** were made (fetch_budget for 2026-10-22 still 119).
- The first real run is **Fri Oct 23, 2026, from 04:00 MDT**. Expect ~43 B1 + ~99 popular ≈ 142 SKUs ≈ 284 requests, plus a ~116-request sweep ≈ 400 of 500/700.

Checks for that run (UTC timestamps; the run is 10:00–12:55 UTC):
```sql
-- day row: split, ok/failed, requests (B1+popular), finish time
SELECT day,status,total,b1_total,popular_total,popular_note,next_idx,ok,failed,requests,stores_verified,stores_changed,error,started_at,completed_at FROM perstore_state WHERE day='2026-10-23';
-- all DABS requests today (sweep + per-store) vs cap 700; per-store alone must stay <= 500 - sweep
SELECT day,dabs_requests,runs,d1_rows_written,kv_writes,exhausted_reason FROM fetch_budget WHERE day='2026-10-23';
-- SKUs ok/failed by list (each attempted SKU = 2 requests)
SELECT CASE WHEN query LIKE '%;list=b1' THEN 'b1' ELSE 'popular' END AS list, status, COUNT(*) AS skus FROM fetch_log WHERE kind='perstore_detail' AND started_at >= '2026-10-23T09:00:00Z' AND started_at < '2026-10-23T14:00:00Z' GROUP BY 1,2 ORDER BY 1,2;
-- fail-closed events (per-SKU failures + day-level skipped/failed/capped/budget/locked)
SELECT id,kind,query,status,http_status,error,started_at FROM fetch_log WHERE ((kind='perstore_detail' AND status<>'ok') OR kind='perstore') AND started_at >= '2026-10-23T09:00:00Z' AND started_at < '2026-10-23T14:00:00Z' ORDER BY id;
-- verified_at rows written by the run, and distinct SKUs verified
SELECT COUNT(*) AS store_rows, COUNT(DISTINCT sku) AS skus FROM inventory_latest WHERE store_key<>'' AND verified_at >= '2026-10-23T09:00:00Z' AND verified_at < '2026-10-23T14:00:00Z';
-- first/last per-store fetch (finish time)
SELECT MIN(started_at) AS first, MAX(finished_at) AS last FROM fetch_log WHERE kind='perstore_detail' AND started_at >= '2026-10-23T09:00:00Z' AND started_at < '2026-10-23T14:00:00Z';
```
Run each with `npx wrangler d1 execute utah-remedy-db --remote --json --command "..."`. Also check `curl -s https://utahremedy.com/health | python3 -m json.tool` → `fetcher.perstore.last_run` and `fetcher.budget.dabs_requests` (used vs cap).

## Resources (Cloudflare account `ca827b3a832159e95f29d5d1d14e9b79`, Quazar16 LLC)

| Resource | Name | ID |
|---|---|---|
| Worker | `utah-remedy` | first version `b37ee902-297e-4cfa-a67d-d5137a89bbf0` |
| D1 | `utah-remedy-db` | `f091ef43-8380-41c7-937c-b1168027c392` |
| KV | `UTAH_REMEDY_CACHE` | `a7e009a216034c4e8b194af12e60b473` |
| Custom domains | `utahremedy.com`, `www.utahremedy.com` | managed by Workers Custom Domains (workers.dev subdomain disabled 2026-10-21) |

Worker secret: `ADMIN_TOKEN` (value not recorded here).

D1 migrations `0001` through `0008_perstore_retry.sql` applied remotely (0008 adds the retry/skipped columns on `perstore_state`) (0006 adds `inventory_latest.verified_at` and `perstore_state`; 0007 adds `perstore_popular` and the perstore_state split columns) (0005 adds `products.data_source` and `catalog_import`) (0003 adds `inventory_latest`, `fetch_budget`, `fetch_lock`, `sweep_state`; 0004 adds `product_search` (FTS5), `product_search_source`, the `products_search_*` triggers, and `idx_latest_store`). The 0001 tables are `users`, `products`, `stores`, `inventory_snapshots`, `user_reports`, `watches`, `alerts`, `concierge_requests`, `remedies_transactions`. As of the prototype run, products, stores, inventory_snapshots, and fetch_log contain prototype data; the other tables are empty.

## File locations
- Worker: `src/index.ts` · Config: `wrangler.jsonc` · Pages: `public/*.html` · CSS: `public/assets/style.css`
- Fetcher: `src/fetchers/{dabs-locator,guard,store,sweep,catalog-list}.ts` · Mock: `scripts/mock-dabs.py`, `scripts/mock-state.py`
- Catalog UI: `src/web/{catalog,pages,router}.ts` · Local seed: `scripts/seed-catalog.py`
- Migrations: `migrations/` · Docs: `README.md`, `DECISIONS.md`, `docs/DATA-SOURCES.md`, `ai-context/plan/`

## 2026-10-22 — Cloudflare analytics read token stored on the Worker
- Owner created a custom API token `utah-remedy-analytics-read` with only **Account → Account Analytics → Read**, scoped to the Quazar16 LLC account.
- Verified active via `/user/tokens/verify`; a test Analytics Engine SQL query (`SHOW TABLES`) succeeded (no datasets yet).
- Stored as Worker secret `CF_ANALYTICS_TOKEN` (`wrangler secret put`). Never committed or logged. Used only by `GET /internal/stats` (2026-10-25 entry below).
- Purpose: the future weekly popular-100 rotation will read product-page view counts from Workers Analytics Engine. Building the view logging + rotation still needs owner approval.
- To revoke: delete the token in the Cloudflare dashboard (API Tokens) and `npx wrangler secret delete CF_ANALYTICS_TOKEN`.

## 2026-10-23 — Per-store: retry a single temporary 5xx later in the window (owner-approved)
**Incident.** 2026-10-23 06:05 MDT: one HTTP 522 on SKU 027100 started the global 1 h DABS backoff (KV `dabs:v1:backoff_until`), which outlasted the 06:55 window end. 027100 failed; 088915, 924209 and 015863 were never checked; the `perstore_state` row stayed `running`. (Fail-closed held: nothing was written for those SKUs.)

**Rules now (src/fetchers/perstore.ts, soft path in dabs-locator.ts).**
- Transient 5xx = 500, 502, 503, 504, 520-527 (`TRANSIENT_5XX`). On one of these the SKU is requeued with a 15 min delay in the same window and the pass continues with the rest of the queue; no global backoff is set. Each retry re-runs the whole SKU (GetDetailUrl + ProductDetail = 2 requests). A due retry goes before new SKUs.
- **Max 3 retries per SKU per day** (so at most 4 attempts). After that the SKU is marked failed for the day, nothing is written, and the pass moves on.
- **Global retry limit: 40 DABS requests per MT day** (`PERSTORE_RETRY_REQUEST_LIMIT`, counted on actual requests, stored in `perstore_state.retry_requests`). When fewer than 2 are left, all pending retries are abandoned as failed (`fetch_log` kind `perstore`, status `retry_limit`).
- **3 consecutive distinct SKUs hitting a transient 5xx** means DABS is probably down: fall back to the old behavior (1 h backoff, stop the tick). Retries are kept pending; they resume if the backoff ends inside the window.
- Hard failures are unchanged: 429 and any 5xx not in the transient set (e.g. 501) still start the 1 h backoff, fail the SKU and stop. **403 never started the backoff and still does not** (the SKU just fails; 3 consecutive failures end the day). Other errors are unchanged.
- Unchanged: fail-closed (`validateStoreList`/`writeStoreDetail`), the 10 s PoliteClient gap, robots crawl-delay, 12-request tick cap, kill switch, flags, locks, popular list, cron schedule.

**Budget math.** Ceiling stays `min(500, caps.dabs_requests)` for sweep + per-store (700/day cap above it; 1600 on drop day), checked before every first try *and* every retry (`used + requests + 2 > ceiling` -> `capped`). Oct 23 baseline = 391 requests (sweep ~114 + per-store ~277). Retries can add at most 40 -> 431 < 500 < 700. Worst case on a long day with all 160 SKUs (~320 + sweep ~114 = ~434 before retries) is ~474-478 with the full 40 retries, still under 500, and the ceiling check would stop it regardless. 40 retry requests = 20 SKU-retries, enough for 3 retries on ~6 SKUs.

**Run rows finish.** `perstore_state` gains `skipped`, `retried`, `recovered`, `retry_requests`, `transient_errors`, `retry_json` (migration `0008`, additive). New terminal statuses: `window_ended` (last scheduled tick of the window, 12:55 UTC, with work left or a backoff active) and `expired` (a stale `running` row from an earlier MT day is closed by the next tick that runs). ok + failed + skipped = total for closed rows. Manual (admin) ticks never count as the last tick.
- Today's (2026-10-23) row will be closed `expired`, skipped=3, by the first tick on 2026-10-24.

**Tests.** `python3 scripts/test-perstore-retry.py` (local mock + `wrangler dev --local`, throwaway D1/KV, zero real DABS requests): 50 checks - single 522 then success; 3 retries then failed with no writes; global limit; 429/403/501 hard behavior; 3-distinct-SKU pause; ceiling at 494/498; stale row; window end.

**Note.** `docs/.~lock.per-store-estimate.md#` is a stale LibreOffice lock (no soffice process, from 2026-10-22). It was deliberately left untouched, so `docs/per-store-estimate.md` was not edited.

## 2026-10-23 — docs/per-store-estimate.md refreshed; stale lock removed (owner-approved)
- `docs/per-store-estimate.md` no longer says "ON HOLD". It now describes what is live (B1 + popular-100, cron, limits, transient-5xx retry), the first real run (138 of 142 SKUs, 391/700 requests, 1,223 store rows over 117 products, the 522 incident) and an actual-vs-estimate note. The original estimate and risk sections are kept and labeled as the original.
- Verified no LibreOffice process was running (`pgrep -a -i office` empty), then deleted the stale lock `docs/.~lock.per-store-estimate.md#` (superseding the earlier "leave it alone" note). It was never committed.
- Docs only; no deploy.

## 2026-10-25 — Sweep: retry a single temporary 5xx later in the window (owner-approved)
**Why.** The nightly sweep had no retry: any failed page marked the sweep `failed` for the day, and per-store (which only runs after a `complete` sweep) was skipped too. 2026-10-24: one HTTP 522 did this. 2026-10-25: one timeout did it.

**Rules now (src/fetchers/sweep.ts; mirrors the per-store design from 2026-10-23).**
- Transient 5xx = 500, 502, 503, 504, 520-527 (same `TRANSIENT_5XX` set). Nothing is written for that page. The page is requeued with a **>= 5 min delay** (`SWEEP_RETRY_DELAY_MS`), so it is retried on the same tick if the tick is still running then, otherwise on the next one. The main cursor moves on to the next page. A due retry goes before the next main page. No global backoff is set.
- **Max 3 retries per page per day** (4 attempts). After the 3rd retry fails, the sweep is `failed` for the day (old behavior).
- **Global sweep retry limit: 20 DABS requests per MT day** (`SWEEP_RETRY_REQUEST_LIMIT`; 1 request per page retry; stored in `sweep_state.retry_requests`). This is separate from per-store's 40. When it is reached, the sweep is `failed` (`fetch_log` kind `sweep`, status `retry_limit`).
- **3 distinct pages in a row hitting a transient 5xx** = the old 1 h backoff (`paused` event), and the tick stops. Pending retries are kept; they only resume if the backoff ends inside the window, which in practice it won't.
- **429 and every other failure are unchanged.** 429 and non-transient 5xx (e.g. 501) still start the 1 h backoff and fail the sweep. 403, bad shape, empty, suspicious and count-drop fail it as before.
- **Timeouts are not retried (unchanged).** A thrown fetch error, including the `REQUEST_TIMEOUT_MS` AbortSignal timeout, is `network_error`. It fails the sweep at once, with no backoff and no retry.
- **Completion:** the sweep is `complete` (and vanish-to-zero + freshness `last_ok_at` run) only when the main cursor reached the total AND no page is waiting for a retry. Pages that succeeded are written as before (existing partial-sweep behavior, unchanged). A failed page writes nothing. No out-of-stock marks happen unless the sweep completes.
- **Window end:** on the last scheduled tick (08:55 UTC; `scheduledTime` from the cron event; manual/admin ticks never count), a sweep still `running` that had any transient 5xx is closed `failed` (`window_ended`). This covers retries still pending, a pause still in effect, or not finished. Sweeps with no transient 5xx keep their old end-of-window behavior.
- Unchanged: per-store pass, cron schedule, kill switch, flags, locks, popular list, 12-page tick cap, 10 s gap, ceilings.

**Budget math.** Sweep ≈ 114 requests + at most 20 retries = **134**. Per-store ≈ 277 (Oct 23) + at most 40 retries = 317. Typical worst day = 451 < 500 < 700. Hard bound: per-store still stops at min(500, cap) *including* the sweep's requests, so sweep + per-store ≤ 500 whatever the sweep used, and the 700/day cap (1600 on drop day) is still reserved atomically before every request. In addition, every sweep retry checks `used + 1 > cap` first (`budget_exhausted`, retry kept pending, no request sent).

**Trade-off.** The window has only ~24 spare page slots (114 pages over 12 ticks × 12 pages; Oct 23 finished on the 08:55 tick). A retry uses a slot. A page that fails late, or several retries, can therefore push completion past 08:55. Then the sweep is `failed` (fail-closed) and per-store skips that day, the same result as before this change.

**Schema.** Migration `0009_sweep_retry.sql` (additive): `sweep_state.retry_json`, `retried`, `recovered`, `retry_requests`, `transient_errors`. `/health` → `fetcher.sweep` shows these plus `retries_pending` and `retry_limits`.

**Tests.** `python3 scripts/test-sweep-retry.py` (local mock + `wrangler dev --local`, throwaway D1/KV in /tmp, zero real DABS requests): 45 checks.
- single 522 → recovered → complete;
- 3 retries → failed, with no writes, no vanish and no freshness advance;
- 3 distinct pages → pause;
- 429/501 (backoff) and 403/bad-shape (no backoff) unchanged;
- global cap at 20 (and 19 → exactly 20);
- the 700 cap checked before a retry;
- window end (pending → failed, pause → failed, clean sweep still completes).

`scripts/test-perstore-retry.py` still passes 50/50.

## 2026-10-25 — Sweep: request timeouts retried like transient 5xx (owner-approved)
**Why.** The 2026-10-25 sweep died on one timeout at start=0 (`network_error ... TimeoutError: The operation was aborted due to timeout`). This builds on 910dd30, in the sweep only.

**What counts as retryable now (sweep only).** Our own per-request timeout and nothing else. `PoliteClient` aborts each request with `AbortSignal.timeout(20 s)`. When that fires, fetch rejects with a DOMException named `TimeoutError`, which `isRequestTimeout` (dabs-locator.ts) matches. `fetchTablePage` tags those `network_error` results with `timeout: true`.
- **Not retried (unchanged):** other `network_error` variants, such as a connection dropped or reset, connection refused, DNS, TLS, or a generic `TypeError`/"internal error". The same goes for any other `AbortError` and for bad data (invalid_shape / empty / suspicious / count drop). These still fail the sweep at once with no backoff.
- **Why timeouts only:** a timeout is cleanly distinguishable by name. Workers fetch reports reset, refused, DNS and TLS failures as generic errors that cannot be told apart reliably, so per the owner's scope they stay hard failures. (Cloudflare-side DNS/origin problems usually come back as HTTP 52x/530, which are handled by the status code.)

**Shared limits.** A timeout follows exactly the 5xx path:
- the same requeue with a ≥ 5 min delay;
- the same 3 retries per page;
- the same 20-request/day sweep retry cap (`retry_requests`);
- the same "3 distinct pages in a row" streak, with timeouts and 5xx mixed. Hitting it gives the 1 h pause, and so does a 429.

A timed-out attempt is a request already reserved against the daily budget (`reserveRequest` runs before fetch), so it counts against the 700/day cap and the 500 sweep+per-store ceiling. `transient_errors` counts timeouts and 5xx together; `fetch_log` keeps the actual error text.

**Timing.** A timeout holds a tick for up to 20 s. A tick has at most 12 pages × 10 s gap. Before the streak pause there are a few timeouts at most, so a tick stays around 3–4 min. That is within the 6 min lock TTL and the 5 min cron spacing. Window-end, fail-closed, completion and ceiling rules are unchanged from 910dd30.

**Test-only knob.** `DABS_TEST_REQUEST_TIMEOUT_MS` (ignored unless DABS_BASE_URL points at a non-DABS host). The mock has `page_mode` `sleep:<ms>:<n>` (stall) and `drop:<n>` (close with no response), and is now threaded.

**Tests.** `scripts/test-sweep-retry.py`: 64/64. That is the 45 existing checks plus 19 new ones:
- single timeout, then recovered;
- page-0 timeout recovers (the Oct 25 case);
- timeout + 522 + timeout on distinct pages → pause;
- timeout × 4 attempts → failed, with no writes, no vanish and no freshness advance;
- timed-out attempts counted in `fetch_budget`;
- the 20 cap (19 → 20 → retry_limit);
- a dropped connection still fails at once with no retry.

`scripts/test-perstore-retry.py`: 50/50.

## 2026-10-25 — Anonymous unique-visitor counting (Workers Analytics Engine, owner-approved)
Goal: count real people using Utah Remedy (toward the 1,000-combined-users target for Jan 1 2027) without accounts and without storing personal data.

**Method: daily-salted hash (chosen over a random anonymous-ID cookie).**
- Visitor id = first 16 hex chars (64 bits) of `SHA-256(daily_salt | CF-Connecting-IP | User-Agent)`.
- `daily_salt` = 32 random bytes from `crypto.getRandomValues`, stored ONLY in KV `analytics:v1:salt:<Utah day>` with a KV absolute expiration ~1 h after that America/Denver day ends; the previous day's key is also deleted whenever a salt is written. It is never logged, never derived from a persistent secret (no HMAC of ADMIN_TOKEN etc.), so once deleted the day's ids cannot be recomputed or linked to an IP/UA or to any other day.
- Each day's salt is created AHEAD of time, during the previous day (each isolate checks for tomorrow's key at most every 30 min). Reason: KV has no put-if-absent and is eventually consistent (missing keys can read as missing for ~60 s), so creating the salt at the first visit of the day let parallel isolates pick different salts. On the first deploy (version fddb14ca, commit dfdad1c) one scripted test visit got 6 ids in 8 s. Part of that was this race, and part was the test client: the agent box's egress IP changes on every request (6 different IPs in 6 requests), which also explains the distinct ids after the fix (version 3c7fa819). So the 2026-10-25 numbers (13 uniques, 11 views, 2 gate passes) are entirely the owner-side verification traffic, overcounted. AE data can't be edited; it ages out after about 3 months. Real browsers usually keep one IP for a session. Visitors whose IP changes per request, such as some privacy relays and carrier NAT pools, will be overcounted. That is a known limit of the no-cookie method. Racing writes for tomorrow's key now settle long before it is used. On-demand creation remains only as a fallback after a day with zero traffic. Isolates cache today's salt and re-read KV every 5 min.
- Why not a random ID cookie: it would add a new persistent identifier to every browser and allow cross-day tracking for its lifetime; the hash adds nothing to the browser, rotates daily by construction, and needs no consent banner logic. Trade-offs we accept: people behind one IP with an identical browser count once; one person changing networks (phone wifi → LTE) counts twice that day; the same person on two days counts twice (so the total is "unique-visitor-days", not people). `gate_passes` (the age cookie lasts 30 days) is the better proxy for new browsers.

**What is stored** (Analytics Engine dataset `utah_remedy_events`, binding `EVENTS`; ~3 months retention by Cloudflare):
- `index1` = the 16-hex daily visitor id; `blob1` = `gate_pass` | `visit`; `blob2` = `home` | `search` | `product` | `store` | `other` | `gate`; `blob3` = product SKU for product views (seed data for a future popular-100 rotation — NOT built), else empty; `blob4` = Utah day `YYYY-MM-DD`; `double1` = 1; plus the AE timestamp.
- Never stored anywhere: IP address, User-Agent, birthdate, cookie values, query strings/search terms. No D1 writes per view. KV holds only the current day's salt.

**When events are written** (`src/analytics.ts`, wired in `src/index.ts`):
- `gate_pass`: successful (21+) `/gate` POST. Under-21 submissions are not counted.
- `visit`: gated (non-public) GET with status 200 and `text/html`, i.e. `/`, `/search`, `/product/N`, `/stores`, `/stores/N`. Logged in `index.ts` after `handleWeb`/`ASSETS` returns, so Cache API HITs are counted too. Not counted: public pages (gate, legal), `/api/*`, `/internal/*`, HEAD, redirects, 404s, static assets, requests without the age cookie (they are redirected to the gate first).
- All hashing / KV / `writeDataPoint` runs inside `ctx.waitUntil` with try/catch: a page is never slowed or failed by analytics. Rate limiting, caching, the gate, the static-asset bypass and `/health` are unchanged.

**Admin read: `GET /internal/stats`** (`Authorization: Bearer $ADMIN_TOKEN`, 404 otherwise; 503 if `CF_ANALYTICS_TOKEN` is missing). Two AE SQL API queries (POST `/accounts/ca827b3a.../analytics_engine/sql` with `CF_ANALYTICS_TOKEN`) + one small D1 read for SKU names. Counts are weighted by `_sample_interval`; uniques are `count(DISTINCT index1)` per Utah day (exact while unsampled; each day row reports `sampled`). Shape:
`{ ok, dataset, generated_at, note, totals: { unique_visitor_days_30d, page_views_30d, gate_passes_30d, unique_visitor_days_all, page_views_all, gate_passes_all, first_day }, daily: [{ day, unique_visitors, page_views, gate_passes, sampled }] (last 30 Utah days, newest first, only days with data), top_products_7d: [{ sku, name, views }] (top 20) }`.

**Cost** (Workers Paid; AE pricing page Apr 2026: 10M data points written + 1M read queries per month included, then $0.25/M and $1.00/M; AE is not yet billed at all):
| Gated page views/day | Data points/month (views + gate passes) | Share of 10M included | Cost |
|---|---|---|---|
| 1,000 | ~30k–35k | ~0.3% | $0 |
| 10,000 | ~300k–350k | ~3.5% | $0 |
| 100,000 | ~3.0M–3.5M | ~35% | $0 |
Overage would only start around ~330k gated views/day. Read queries: 2 per `/internal/stats` call (even 100 calls/day = 6k/month vs 1M included). KV: 1 salt write + 1 delete per day, salt reads at most once per isolate per 5 min (well inside the included 10M reads). CPU: one SHA-256 per view (sub-millisecond).

**Privacy page**: one sentence added to "What we collect now" ("Visit counts: we count anonymous visits using a daily-changing code that can't identify you, and we don't store IP addresses or birthdates."). Nothing else in the legal pages changed; still draft pending legal review. Open for legal review: the existing line "We do not currently have ... analytics trackers ..." (true for third-party trackers, but counsel may want it reworded) and the "Last updated" date (left at October 21, 2026 per instruction).

**Tests**: `python3 scripts/test-analytics.py` (local `wrangler dev`, no DABS/CF API calls; `ANALYTICS_TEST_LOG=1` echoes data points only when `DABS_BASE_URL` points at the mock): gate_pass/visit emitted incl. Cache HIT, categories/SKU, exclusions, no IP/UA/birthdate/cookie in data, 16-hex ids, no D1 writes, only today's + tomorrow's salt keys in KV, `/internal/stats` 404 without token.

## 2026-10-26 — Privacy page: analytics wording reconciled (owner-approved)
- Resolved the contradiction flagged on 2026-10-25. Old: "We do not currently have accounts, sign-up forms, analytics trackers, or advertising cookies." New: "We do not currently have accounts or sign-up forms, and we don't use advertising cookies, tracking cookies, or third-party trackers. The only measurement we do is the anonymous daily-code visit count described above."
- "Last updated" changed from October 21, 2026 to October 26, 2026. Nothing else changed; the page is still a draft pending legal review. Privacy page only (no code, cron, sweep, per-store or flag changes).


## 2026-10-26 — Sweep: 15 min streak pause; sweep moved to 09:xx UTC; catalog import moved to 13:30 UTC (owner-approved)
Scope: the nightly sweep only (plus the catalog cron, moved to avoid a collision). Per-store logic, its cron (`*/5 10-12 * * *`), budgets, the popular list, locks, flags and the kill switch are unchanged.

**Pause after 3 distinct pages in a row fail transiently (5xx in the retry set or our 20 s timeout): 1 h → 15 min.**
- Why 15, not 10: 15 is what the owner suggested, and it still leaves room for retries. For example, a streak at 03:00–03:01 pauses until ~03:16, the 03:20 tick runs the queued retries, a second streak can pause again until ~03:36–03:41, and the 03:45/03:50/03:55 ticks can still retry. 10 min would allow one more cycle but sends requests to a struggling DABS more often, and the retry caps bind first anyway.
- **Streak reset:** the 3-in-a-row list is cleared when the pause starts. Without the reset, every failure after the pause would re-pause after a single request, because the list was only cleared by a successful page. With it, each post-pause tick can try up to 3 distinct pages before pausing again. It can't loop forever. The limits are: max 3 retries per page (then the sweep fails), 20 sweep retry requests per day, the daily request ceiling checked before every retry, and the 09:55 UTC last tick, which closes an unresolved sweep as `failed`. With 12 pages, the worst case is 20 retry requests, then `failed`.
- Unchanged: a 429, non-transient 5xx and other hard errors (via `maybeBackoff`) still set the **1 h** backoff and fail the sweep immediately. Fail-closed is unchanged: an incomplete sweep writes no counts for failed pages, applies no vanish-to-zero and doesn't advance `last_ok_at`. The 5 min retry delay is unchanged. Per-store still calls `startBackoff` with the 1 h default.
- Code: `startBackoff(env, meter, ms = 1 h)` (KV TTL still 7200 s). Sweep uses `SWEEP_STREAK_PAUSE_MS = 15 min`. `sweepStatus().retry_limits.streak_pause_min` = 15. There's a mock-only override, `DABS_TEST_SWEEP_PAUSE_MS`, which is ignored unless `DABS_BASE_URL` points away from DABS.

**Sweep cron `*/5 8 * * *` → `*/5 9 * * *`:** 09:00–09:55 UTC = 03:00–03:55 MDT now, 02:00–02:55 MST after Nov 1 (UTC crons don't follow DST). `WINDOW_LAST_TICK_UTC_MIN` is now 09:55, and `EXPECTED_CRONS` and `wrangler.jsonc` are updated. Per-store still requires `sweep_state.status = 'complete'` for the same America/Denver day (`mtDay()`). 09:xx and 10–12 UTC are always the same Utah day (03–06 MDT / 02–05 MST), so that gate still works. The gap between the sweep's last tick and per-store's first tick shrinks from 65 to 5 min. A sweep tick is ~2 min (12 pages × 10 s gap), so the run lock is free by 10:00. If the sweep isn't complete, per-store skips the day as before.

**Catalog import `30 9 2-8 * *` → `30 13 2-8 * *`** (13:30 UTC = 07:30 MDT / 06:30 MST, days 2–8). 09:30 UTC is now inside the sweep window. Both take the single-run lock and share the daily budget and the DABS backoff key, so on days 2–8 one of the two would lose the tick (`locked`), and a sweep pause would block the import. 13:30 is the first free half-hour after the per-store window (10:00–12:55 UTC). The import logic is unchanged (once per day, first tick of the month that finds the list). Nov 2 is the first day on the new time.

Tests: `scripts/test-sweep-retry.py`. T3 and T10 now assert a ~15 min backoff and the streak reset, and T4 asserts that 429/501 still give ~1 h. New tests: T14 (short pause, then the queued retries run and the sweep completes; with a persistent outage each cycle retries all 3 pages before re-pausing and fails after 3 retries/page, fail-closed) and T15 (crons, `EXPECTED_CRONS`, last tick, `/health` schedule). `scripts/test-perstore-retry.py` was re-run because `dabs-locator.ts` changed.

Results: `test-sweep-retry.py` 77/77, `test-perstore-retry.py` 50/50, typecheck and check-assets OK. No DABS requests were made (local mock only), and no manual sweep was run.

## 2026-10-27 — Sweep maintenance window 07:30–10:55 UTC; per-store moved to 11:00–13:55 UTC; catalog to 14:30 UTC (owner-approved)
Why: the Oct 27 sweep (09:03–09:56 UTC) got 60 of 114 pages. The 15 min pause recovered 3 pages, but more 522s at 09:55 UTC left it incomplete. A clean sweep at the 10 s gap needs ~53 of the old 55 minutes, so a single bad stretch ended the day. No complete sweep since Oct 23.

**Schedule** (UTC crons don't follow DST; MDT = UTC−6 until Nov 1, MST = UTC−7 after):

| Job | Cron(s) | UTC | MDT | MST (after Nov 1) | Ticks |
|---|---|---|---|---|---|
| Sweep | `30-55/5 7 * * *` + `*/5 8-10 * * *` | 07:30–10:55 (hard stop = 10:55 tick) | 01:30–04:55 | 00:30–03:55 | 42 |
| Per-store (B1 + popular) | `*/5 11-13 * * *` | 11:00–13:55 (last tick 13:55) | 05:00–07:55 | 04:00–06:55 | 36 |
| Catalog import (days 2–8) | `30 14 2-8 * *` | 14:30 | 08:30 | 07:30 | 1/day |

- Start 07:30, not 07:00: after Nov 1, 07:00 UTC is exactly 00:00 MST, the Utah-day boundary used by the budget, `sweep_state.day` and the per-store "sweep complete today" gate. 07:30 keeps everything from the first sweep tick to the catalog tick on the same Utah day in both MDT and MST, with a 30 min buffer. Cloudflare cron can't express "every 5 min from 07:30 to 10:55" in one line, so the sweep uses two entries (4 Cron Triggers total, account limit 250).
- Per-store starts 5 min after the sweep's hard stop. A sweep tick is ≤ ~2 min (12 pages × 10 s), so the run lock is free by 11:00. The per-store logic, budgets, retry rules and the "sweep must be complete for the same `mtDay()`" gate are unchanged. Only the window hours and its last-tick constant moved (`WINDOW_LAST_TICK_UTC_MIN` 12:55 → 13:55), so the 1 h-pause/backoff/budget `window_ended` close and the pending-retry close now happen at 13:55. Stale rows from earlier days are still closed `expired` (day-based, not hour-based).
- The catalog moves to 14:30 because 13:30 is now inside the per-store window and both take the single-run lock. Nov 2 is the first day on the new time.

**Resume / no second sweep.** The cursor (`next_start`) and the retry queue live in `sweep_state`, so every tick resumes where the last one stopped, including after a 15 min or 1 h pause. Once the day's row is `complete` or `failed`, the pre-check returns `noop` before the lock, the run charge or any request, so there is never a second sweep the same Utah day. Retry rules are unchanged: 3 retries/page, 20 retry requests/day, ≥ 5 min delay, a 15 min pause after 3 distinct pages in a row, 1 h for 429. The 10 s gap and 12 requests/tick are unchanged.

**Hard stop (10:55 UTC tick).** Any sweep still `running` at that tick is now closed `failed` (`window_ended`). Before, only sweeps that had seen a transient 5xx/timeout were closed. Now it also covers a sweep cut short by the runs cap, including on the budget-exhausted path. Fail-closed is unchanged: no counts from failed pages, no vanish-to-zero, no `last_ok_at` advance.

**Run charging (change beyond the brief).** The runs cap is 60/day and per-store also uses it (up to 36). A 42-tick sweep window where every pause/idle tick still charged a run (the old order: `startRun` before the backoff check) could have pushed the day past 60. That would set `exhausted_reason` and stop per-store for the day. Sweep ticks that can't send a request now return before `startRun`:
- (a) DABS backoff or the 15 min pause is active;
- (b) the main pages are done and the only pending retries aren't due yet (`waiting`).

`Budget.openDay()` creates the day's budget row first, without charging, so `flush()` still records metered D1 usage. `startRun()` now calls it, with the same SQL as before. Typical run use: ~10–14 sweep + ~25 per-store + ≤ 1 catalog ≈ 40 of 60.

**Requests (unchanged volume; the wider window adds none).** Sweep = 1 request per page + ≤ 20 retries.
- Today ~114 pages, so **≤ 134**.
- Per-store ≈ 277–286 (≤ ~143 SKUs × 2) + ≤ 40 retries = **≤ ~317–326**. It is hard-bounded: no per-store SKU or retry starts if today's requests, sweep included, would pass min(500, cap).
- Catalog: ≤ 2 (page + XLSX) once a month, else 1 page check/day on days 2–8. It runs after per-store, under the 700 cap.

| Day | Sweep | Per-store | Catalog | Total | vs 500 / 700 |
|---|---|---|---|---|---|
| Normal (Oct 23 baseline) | ~114 | ~277 | 0–2 | **~391–393** | under both |
| Retry-heavy (all 20 + 40 retries) | 134 | ~317 | 0–2 | **~451–453** | under both |
| Absolute worst | 134 | stops at the 500 combined ceiling | ≤ 2 | **≤ 502** | ≥ 198 under 700 |
| 3rd-Saturday drop day (cap 1,600, popular skipped) | ≤ 134 | B1 only ≤ 120 + 40 | 0–2 | **≤ ~296** | ceiling still min(500, 1600) = 500 |

Tests:
- `scripts/test-sweep-retry.py`:
  - T15 updated: crons, `EXPECTED_CRONS`, both last-tick constants, tick counts / no overlap / same Utah day in MDT and MST, and the `/health` schedule.
  - New T16: a `waiting` tick and pause ticks charge no run and send nothing; a complete sweep's later ticks are `noop` with no run, no request and no lock; a backoff on a day with no budget row opens the row with runs 0 and doesn't exhaust.
  - New T17, real `scheduled()` ticks with `scheduledTime`:
    - 07:30 starts and 09:00 resumes;
    - 10:50 is not the hard stop, 10:55 closes it `failed`;
    - retired crons `*/5 9`, `*/5 10-12` and `30 13 2-8` are rejected;
    - a clean run completes;
    - an unfinished sweep without 5xx is closed at 10:55.
- `scripts/test-perstore-retry.py`, new S9 with real scheduled ticks:
  - the 10-12 cron is rejected;
  - 11:00 runs;
  - 12:55 and 13:50 don't close the row;
  - 13:55 closes it `window_ended` with the pending SKU unwritten.

Results: `test-sweep-retry.py` 92/92, `test-perstore-retry.py` 56/56, `test-analytics.py` 26/26, typecheck and check-assets OK. Local mock only; no DABS requests and no manual sweep. Tonight (Oct 28, 07:30 UTC = 01:30 MDT) is the first run on the new window.

## 2026-10-28: sweep page rest (spread retries over the window instead of failing early)

**Why.** On Oct 28 pages 576, 624 and 672 answered 522 on every attempt. Page 576 used its 3 retries at 2:36 AM MDT and that failed the whole sweep with more than 2 h of window left (12 of 114 pages done, 7 of 20 retries used).

**Change (owner-approved).**
- When a page has used its 3 retries and fails again, it no longer fails the sweep. It **rests 30 min** (`SWEEP_PAGE_REST_MS`) and is re-queued for **one more attempt** later in the same window. If that fails it rests again, and so on until the 10:55 UTC (4:55 AM MDT) hard stop.
- **Non-blocking:** the rested page sits in the retry queue with a due time 30 min out. The main cursor and other due retries keep going in the same tick, so one resting page never holds up the others. If only resting pages are left, ticks return `waiting` with no run charged and no request sent (existing path).
- **Counter choice:** the per-page counter does **not** reset after a rest. Attempts after a rest are extra attempts (retry 4, 5, ...; logged `start=N;retry=K;rest=R`), one per rest, and every one counts against the **20 sweep retry requests/day**. When that cap is reached the sweep is `failed` (`retry_limit`), as before. Resetting to 3 more retries per rest was rejected because one bad page could then use the whole cap in quick bursts.
- **Pause interaction:** post-rest attempts don't add to the 3-distinct-pages-in-a-row streak. A known-bad page coming back every 30 min therefore can't keep re-triggering 15 min pauses for everyone else. Attempts up to and including the 3rd retry still count, as before, and a 429 still means a 1 h backoff. A success still clears the streak.
- **Unchanged:** 5 min retry delay, 3 retries/page before resting, 20 retry requests/day, the 700 daily cap and the 500 combined ceiling (checked before every attempt, including post-rest ones), the 10 s gap, 12 requests/tick, the 15 min / 1 h pauses, non-retryable errors failing at once, and fail-closed. An incomplete sweep writes no counts for the failed pages, marks nothing out of stock and doesn't advance freshness. At the hard stop an unresolved sweep is `failed` (`window_ended`), and the error now names the resting pages (`resting: start=576 x2`). Per-store logic is unchanged.
- **Volume:** each page is still fetched once plus ≤ 20 retries in total, so the sweep stays ≤ 114 + 20 = **134** worst case. Resting adds no requests.

**Response-time logging.** `PoliteClient.lastResponseMs` measures send → response headers, or → error/timeout, excluding the 10 s gap wait. It is stored:
- per request in `fetch_log.response_ms` for every `sweep_page` row (ok and failed);
- per day in `sweep_state.page_failures_json` for every failed page attempt (5xx, timeout, other): `{start: {fails, rests, last_status, last_ms, max_ms, ms: [last 8], at}}`;
- `sweep_state.rest_cycles` counts rests started today. A `fetch_log` kind `sweep`, status `page_rested` event is written per rest, with the page, retries used, error, ms and next try.
- `/health` → `fetcher.last_sweep` shows `rest_cycles`, `pages_resting` (`start`, `rests`, `next_try_at`), `failed_pages`, and `retry_limits.page_rest_min` = 30. The daily status can read failed-page response times from there.

**Schema.** Migration `0010_sweep_rest.sql`, additive: `sweep_state.rest_cycles` (DEFAULT 0), `sweep_state.page_failures_json`, `fetch_log.response_ms`. Mock-only override `DABS_TEST_SWEEP_REST_MS` (ignored unless `DABS_BASE_URL` is the local mock).

**Tests** (`scripts/test-sweep-retry.py`):
- T2, T11 and T14b now expect a rest instead of `failed after 3 retries`, plus response-time checks (5xx a few ms; timeouts ~1500 ms = the mock request timeout).
- New T18:
  - a) a 42-page catalog where page 48 fails 4 times: it rests, the remaining main pages are fetched in the same tick right after the rest starts, the next tick is `waiting`, the post-rest attempt succeeds and the sweep completes (46 requests = 42 + 4);
  - b) a persistent outage on one page: rests every cycle until retry_requests = 20, then `failed` `retry_limit`. That is 21 hits on the page and 25 requests in total = 5 pages + 20. There are 17 rests and no pause;
  - c) a page resting at the 10:55 UTC hard stop: `failed` `window_ended`, naming the resting page.


Results:
- `test-sweep-retry.py`: full run 110/113. The 3 misses were a T18a test-timing issue: the 6 s mock rest expired inside a slow 12-request tick. T18a now uses a 60 s mock rest, and `python3 scripts/test-sweep-retry.py t18_rest_nonblocking` passes 13/13. All T1–T17 checks (incl. the updated T2/T11/T14b) and T18b/c passed in the full run.
- `test-perstore-retry.py`: 56/56.
- `test-analytics.py`: 26/26.
- typecheck and check-assets: OK.

Local mock only; no DABS requests, no manual sweep. Tonight (Oct 29, 07:30 UTC = 1:30 AM MDT) is the first live run.

## 2026-10-29: sweep retry cap 20 → 40 requests/day (owner-approved)

**Why.** In the Oct 29 run, 7 failing pages all recovered on their 4th try, but together they used all 20 sweep retry requests. A timeout on page 3360 at 4:01 AM MDT then had no retry left, which ended the sweep (`retry_limit`) with about 1 h of window still left. The 30-min page rest (2026-10-28) was doing its job. The cap was what stopped the sweep.

**Change (exact scope).** `SWEEP_RETRY_REQUEST_LIMIT` 20 → **40** (`src/fetchers/sweep.ts`). That is the same as per-store's 40/day, but the two are separate budgets. A page that needs more retries can keep going, including the 30-min rested-page re-queues (`SWEEP_PAGE_REST_MS`), until the 10:55 UTC (4:55 AM MDT) hard stop or until the 40 cap is reached. Reaching 40 still means `failed` (`retry_limit`). `/health` → `fetcher.last_sweep.retry_limits.request_limit_per_day` = 40, `page_rest_min` still 30.

**Unchanged:** the 10 s gap, 12 requests/tick, ≥ 5 min retry delay, 3 retries/page before a rest, the 30 min rest, the 15 min pause after 3 distinct consecutive 5xx/timeout pages (post-rest attempts still don't count toward it), the 1 h pause for 429 and other non-retryable 5xx, the 60 runs/day cap, the 700/day cap and the 500 combined ceiling (checked before every request, including every retry), fail-closed (an incomplete sweep writes no counts for failed pages, marks nothing out of stock and doesn't advance freshness), the 10:55 UTC hard stop, crons, and all per-store logic.

**Requests.** Sweep = 1 request per page + ≤ 40 retries, so today (~114 pages) it is **≤ 154** (was ≤ 134).

| Day | Sweep | Per-store | Catalog | Total | vs 500 / 700 |
|---|---|---|---|---|---|
| Normal (Oct 23 baseline) | ~114 | ~277 | 0–2 | **~391–393** | ~107 under 500, ~307 under 700 |
| Retry-heavy (all 40 sweep + 40 per-store retries) | 154 | ~317 | 0–2 | **~471–473** (was ~451–453) | ≥ 27 under 500, ≥ 227 under 700 |
| Absolute worst | 154 | stops at the 500 combined ceiling | ≤ 2 | **≤ 502** (unchanged) | ≥ 198 under 700 |
| 3rd-Saturday drop day (cap 1,600, popular skipped) | ≤ 154 | B1 only ≤ 120 + 40 | 0–2 | **≤ ~316** (was ≤ ~296) | ceiling still min(500, 1600) = 500 |

If per-store reaches its 143-SKU high end (~286 + 40 = 326), the retry-heavy day is ~480–482, which is still under 500.

**The 500 ceiling still bounds the true worst case.** The sweep runs first (07:30–10:55 UTC) and can use at most pages + 40 = 154, well under 500. Per-store (11:00–13:55 UTC) won't start a SKU or a retry if today's requests, sweep included, would pass min(500, cap). So sweep + per-store ≤ 500 no matter how much the sweep used, and the catalog check (14:30 UTC, ≤ 2) brings the total to ≤ 502. The 700/day cap is still reserved atomically before every request, and every sweep retry checks it first.

**Tests** (`scripts/test-sweep-retry.py`, local mock only, no DABS requests):
- T5 and T12: the cap is now 40 (39 → 40 → `retry_limit`).
- New T5c: with 20 retries already used, retry 21 is still sent, the sweep stays `running`, the page is re-queued, and no `retry_limit` event is logged.
- T18b: a persistent outage on one page keeps resting and retrying past 20. At retry_requests = 21 the sweep is still `running`, the page is resting, and rest_cycles = 19. It ends `failed` `retry_limit` at exactly 40: 41 hits on the page, 45 requests in total (5 pages + 40), 37 rests, no pause.
- T2: `/health` shows `request_limit_per_day` 40 and `page_rest_min` 30.
- T18c (unchanged) still shows a resting page closed `window_ended` at the 10:55 UTC hard stop.

Results: `test-sweep-retry.py` 116/116, `test-perstore-retry.py` 56/56, `test-analytics.py` 26/26, typecheck and check-assets OK. Local mock only; no DABS requests and no manual sweep. Tonight (Oct 30, 07:30 UTC = 1:30 AM MDT) is the first live run with the 40 cap.

## 2026-10-30 — Per-store: 15 min streak pause (was 1 h), same as the sweep (owner-approved)

**Why.** On Oct 30 per-store reached only **35 of 139 bottles** (`window_ended`, 27 ok, 5 failed, 107 skipped, 71 requests). Streaks of HTTP 522 on 3 distinct SKUs at **5:20, 6:26 and 7:35 AM MDT** (11:20, 12:26, 13:35 UTC) each started a **1 h** pause, so most of the 05:00–07:55 MDT window was spent paused. The last pause ran until 8:36 AM MDT, past the window end.

**Change (exact scope, `src/fetchers/perstore.ts`).**
- 3 distinct SKUs in a row hitting a transient 5xx (500, 502–504, 520–527) → `startBackoff(env, meter, PERSTORE_STREAK_PAUSE_MS)` with **`PERSTORE_STREAK_PAUSE_MS = 15 min`** (was the 1 h default). This is the same as the sweep's `SWEEP_STREAK_PAUSE_MS`.
- **Streak reset when the pause starts** (`retry_json.streak = []`), as in the sweep. Without it, the first failure after the pause would re-pause right away, because the list was otherwise cleared only by a success or a non-transient answer. Pending retries are kept and resume after the pause (due retries go first, as before).
- A `fetch_log` event (kind `perstore`, status `paused`) is logged with the 3 SKUs and the pause length. The tick result detail now reads `... DABS looks down, 15 min pause`.
- `/health` → `fetcher.perstore.limits.streak_pause_min` = 15 (new). `streak_pause` stays 3.
- Mock-only test knob `DABS_TEST_PERSTORE_PAUSE_MS`. Like the other `DABS_TEST_*` knobs, it is ignored unless `DABS_BASE_URL` points away from DABS.

**Unchanged.**
- 429 and any 5xx outside the transient set (e.g. 501) still set the full **1 h** backoff via `maybeBackoff`, fail the SKU and stop the tick. 403 still sets no backoff.
- Per-SKU retries: ≥ 15 min requeue, 3 retries per SKU, 40 retry requests/day.
- Caps: the 500 combined sweep + per-store ceiling (checked before every SKU and every retry), the 700/day cap, the 10 s gap, 12 requests/tick and 60 runs/day.
- Window and crons: per-store `*/5 11-13 * * *` (11:00–13:55 UTC). Per-store runs only after that Utah day's sweep is `complete`.
- Fail-closed: an incomplete fetch never writes counts, never marks anything out of stock and never advances `verified_at`.
- Run accounting is unchanged. Per-store ticks still charge a run even while paused, unlike the sweep, whose pause/waiting ticks charge none. That doesn't block the 15 min pause: every tick in the window was already charged during the 1 h pause, so a shorter pause uses the same number of runs per tick, or fewer if the queue finishes sooner.
- Timeouts are not changed for per-store. Our 20 s `TimeoutError` is still a plain `network_error` there: that SKU fails for the day, the streak is cleared and it counts toward the 3-consecutive-failures stop. Only the sweep retries timeouts (2026-10-25). Oct 30 had 2 per-store timeouts (017766 retry 1 at 6:25 AM MDT, 022179 at 7:35 AM MDT).

**Requests: the worst case is unchanged.** The pause length only decides *when* inside the window work happens. No limit depends on it:
- first tries ≤ 2 × the frozen queue (≤ 160 SKUs);
- retries ≤ 40 requests/day;
- every SKU and every retry checks `used + 2 ≤ min(500, cap)`, and the 700 cap is reserved atomically before each request;
- ≤ 12 requests/tick over ≤ 36 ticks.

So sweep + per-store stays **≤ 500**, and ≤ 502 with the catalog check, as before. On a bad DABS morning, more of the queue gets done than the 71 requests of Oct 30, but only within those same caps. The streak reset means each post-pause tick can try up to 3 distinct SKUs before pausing again, and those attempts are bounded by the same per-SKU, retry and ceiling limits.

**Example timeline (Oct 30 pattern, MDT).** Streak at 5:20 → pause until ~5:36 → the 5:40 tick runs the queued retries (due 5:35+) and continues the queue. With the 1 h pause, the next attempt was at 6:25.

**Tests** (`scripts/test-perstore-retry.py`, local mock only, no DABS requests):
- S4: a 429 or 501 backoff is the full 1 h (55–60 min left).
- S5 is now a 522/503/500 mix on 3 distinct SKUs, checking:
  - the tick stops with "15 min pause", and the KV backoff is 13–15 min;
  - `streak = []` and the 3 SKUs are pending;
  - nothing is written for those SKUs, and SKU 4+ is untouched;
  - a `paused` event is logged, and no requests are sent during the pause;
  - `/health` `streak_pause_min` = 15 and the other limits are unchanged.
- New S10, with the mock pause shortened to 4 s and retries not due:
  - the tick after the pause resumes;
  - a single new 503 does not re-pause, and the remaining SKUs are checked;
  - nothing is written for the 4 failed SKUs, and only one `paused` event is logged;
  - with the override active, a 429 still sets the full 1 h backoff.

## 2026-10-30 (later): per-store timeouts are retried like a transient 5xx, and paused or waiting ticks no longer charge a run (owner-approved)

This replaces two bullets in the entry above, under "Unchanged": the one on timeouts and the one on run accounting. The per-store pass now matches the sweep on both.

**Why.** On Oct 30, two per-store timeouts each failed a SKU for the day: 017766 (retry 1) at 6:25 AM MDT and 022179 at 7:35 AM MDT. Each timeout also cleared the 5xx streak and counted toward the 3-consecutive-failures stop. A timeout on DABS is the same outage signal as a 522/504, and the sweep has retried it since 2026-10-25. That day per-store also charged every one of its 36 ticks, including ticks that only sat out a pause or waited for a retry to come due, so the day used 51 of 60 runs.

**Change (`src/fetchers/perstore.ts`, `src/fetchers/dabs-locator.ts`).**
- `fetchStoreDetailPage` marks a `network_error` caused by our 20 s `TimeoutError` with `timeout: true`. This covers GetDetailUrl, ProductDetail and the ProductDetail body read, using `isRequestTimeout`, the same check the sweep uses.
- Per-store: `transient = transient 5xx || timeout`. A timed-out SKU is therefore:
  - requeued at least 15 min later, under the same 3 retries per SKU and 40 retry requests/day (the timed-out request counts toward the 40);
  - added to the distinct-SKU streak, so any 3 timeouts or 5xx errors in a row trigger the 15 min pause;
  - no longer a reason to clear the streak or count toward the 3-hard-failures stop.
- The `fetch_log` row stays `network_error` with the TimeoutError text, plus "retry n/3 queued".
- Run accounting matches the sweep. The tick opens the budget day without charging (`budget.openDay()`). It then returns without charging a run in two cases:
  - KV backoff is active ("backoff");
  - nothing can be sent: the queue is done and every pending retry is still not due ("waiting").
  Only a tick that goes on to send requests calls `budget.startRun()`. On the last window tick, either case closes the row `window_ended`, as before.
- `/health` → `fetcher.perstore.limits.timeout_retryable = true` and `paused_or_waiting_ticks_charge_run = false`.

**Unchanged.**
- 429s and non-transient 5xx errors keep the 1 h backoff. 403 sets no backoff.
- A non-timeout network error is still a hard failure.
- Caps: 700/day, the 500 sweep + per-store ceiling, 40 retry requests/day, 3 retries per SKU, the 10 s gap, 12 requests/tick and 60 runs/day.
- Windows and crons are unchanged. Per-store still runs only after a complete sweep for the same Utah day.
- Fail-closed: an incomplete fetch never writes counts, never marks anything out of stock and never advances `verified_at`.

**Requests: the worst case does not increase.** A timeout now uses a retry instead of failing the SKU, but every retry is still checked before it is sent:
- 3 retries per SKU and 40 retry requests/day;
- `used + 2 ≤ min(500, cap)`;
- the 700 reservation;
- 12 requests per tick.

First tries are still at most 2 per SKU. So sweep + per-store stays at **≤ 500** (≤ 502 with the catalog check). The total runs used can only go down.

The wall time per tick is still bounded. The timeouts in a tick can come from at most 3 distinct SKUs in a row before the pause starts, and the tick lock prevents overlapping ticks.

**Tests** (`scripts/test-perstore-retry.py`, local mock only). The mock gained `sleep:` and `pdsleep:` stall modes.
- S9 now also checks runs: waiting ticks do not add a run.
- S11: a timeout is requeued, not counted as failed, and does not reset the streak. Nothing is written while it waits. The retry then recovers it.
- S12: 522, then a GetDetailUrl timeout, then a ProductDetail timeout gives the 15 min pause. The backoff tick charges no run and sends nothing. S12b: 3 timeouts alone also give the pause, and the day is not marked failed.
- S13: an always-timing-out SKU uses 3 retries, then fails, and each retry counts as a retry request. With 38 of 40 used, the next timed-out retry is still counted, and then the daily limit fails the SKU with no writes.
- S14: sending ticks charge a run and waiting ticks don't; a due retry tick does; the `/health` flags are present and the other limits are unchanged.

## 2026-10-31: per-store retry order, fresh bottles first with at most 1 retry between them (owner-approved)

**Why.** On the Oct 31 morning, due retries still ran first after every 15 min pause. Bottles 021986, 022167 and 022179 failed together again each time and re-triggered the pause 4 times in a row from 6:45 to 7:46 AM MDT. No fresh bottle was checked in that time, so per-store reached only 33 of 140.

**Change (`src/fetchers/perstore.ts`, ordering only).**
- While fresh (never-tried) SKUs remain in the frozen queue, at most **one** due retry is worked between two fresh SKUs (fresh, retry, fresh, retry, …). The next attempt after a retry is always fresh.
- The first attempt after a streak pause (or a 429 / non-transient 5xx 1 h backoff) is fresh. `retry_json.lr` is set when the pause starts and survives across ticks.
- Once the queue is drained, due retries run back to back (earliest due first), as before.
- Retries still wait their ≥ 15 min delay.
- Streak: a fresh success between two failing retries clears the streak as before, so persistent failures alone can no longer pause the pass while fresh SKUs are left. If DABS is really down, fresh SKUs fail too, and 3 distinct failures in a row still pause for 15 min.
- `/health` → `fetcher.perstore.limits.retry_order = "fresh_first_max1_interleave"`.

**Unchanged.**
- Retry limits: 3 retries per SKU and 40 retry requests/day.
- Pauses: the 15 min pause after 3 distinct transient failures (5xx/timeouts) in a row. 429s and non-transient 5xx still get the 1 h backoff.
- Caps: 700/day, the 500 sweep + per-store ceiling, 12 requests/tick and the 10 s gap.
- Runs: the run accounting from fa94115.
- Schedule: windows and crons. Per-store still runs only after a complete sweep.
- Fail-closed: an incomplete fetch never writes counts, never marks anything out of stock and never advances `verified_at`.

**Requests: the worst case is unchanged.** The same SKUs and retries are attempted under the same per-request checks (3 per SKU, 40/day, `used + 2 ≤ min(500, cap)`, the 700 reservation, 12 per tick). Only the order changes. The waiting/backoff shortcuts are unchanged.

**Tests** (`scripts/test-perstore-retry.py` S15, local mock):
- Setup: 3 persistently failing SKUs pause tick 1 with 5 fresh SKUs left.
- After the pause, the first attempt is fresh, and the tick makes fresh progress without re-pausing.
- While fresh SKUs remained, there were never 2 retries in a row, and there was only one pause before the queue was drained.
- Every fresh SKU was tried once, in order, and retries still ran after the queue was drained.
- Day complete: ok 5, failed 3, retried 9, retry_requests 9. Each failing SKU was requested exactly 4 times, and nothing was written for them.
- `/health` shows `retry_order`, and the other limits are unchanged.
- Negative control: with the old order, S15 fails.

First live test: the per-store pass at 4:00 AM MST on Nov 1 (DST ends that day; 11:00 UTC).

## 2026-11-01 — Per-store window widened to 11:00–15:55 UTC (4:00–8:55 AM MST); catalog import moved to 16:30 UTC (owner-approved)
**Why.** The per-store pass keeps ending `window_ended` with bottles unchecked when DABS has a bad stretch: 15 min pauses, 1 h 429 backoffs and 15 min retry delays eat most of a 3-hour window. Two more hours give the same work (same SKUs, same retries, same caps) time to finish. No new requests.

**Schedule** (UTC crons don't follow DST; MST = UTC−7 from Nov 1, MDT = UTC−6 from Mar 8, 2027):

| Job | Cron(s) | UTC | MST | MDT | Ticks |
|---|---|---|---|---|---|
| Sweep (unchanged) | `30-55/5 7 * * *` + `*/5 8-10 * * *` | 07:30–10:55 (hard stop = 10:55 tick) | 00:30–03:55 | 01:30–04:55 | 42 |
| Per-store (B1 + popular) | `*/5 11-13 * * *` → **`*/5 11-15 * * *`** | 11:00–15:55 (last tick 15:55) | 04:00–08:55 | 05:00–09:55 | 36 → 60 |
| Catalog import (days 2–8) | `30 14 2-8 * *` → **`30 16 2-8 * *`** | 16:30 | 09:30 | 10:30 | 1/day |

- `wrangler.jsonc` crons and `EXPECTED_CRONS` (`src/index.ts`) are updated; the old `*/5 11-13 * * *` and `30 14 2-8 * *` are now rejected and logged like any unknown cron.
- `WINDOW_LAST_TICK_UTC_MIN` (`src/fetchers/perstore.ts`) 13:55 → **15:55 UTC**. Every `window_ended` close (backoff/pause active, budget exhausted, retries pending, queue unfinished) now happens at the 15:55 tick; 13:55 is an ordinary tick. Manual/admin ticks still never count as the last tick. Stale rows from earlier days are still closed `expired` by the next day's first tick (day-based, not hour-based), and 15:55 UTC is 08:55 MST / 09:55 MDT, the same Utah day as the 11:00 UTC start, so `mtDay()`, the budget day and the "sweep complete today" gate are unaffected.
- **Catalog to 16:30 UTC** because 14:30 is now inside the per-store window and both take the single "dabs" run lock (lock TTL 6 min; a per-store tick is ≤ ~2.5 min, so the lock is free well before 16:30). 16:30 UTC is 35 min after the last per-store tick, the same gap as before (13:55 → 14:30). Its gating is America/Denver based: `mtPeriod()` (Utah month) and "already tried today" (`mtDay(updated_at)`). For UTC days 2–8 at 16:30, the Utah date is the same day and month in both MST (09:30) and MDT (10:30), so the once-per-day and ≤ 3 failed attempts/month rules behave exactly as at 14:30. It shares the same daily budget (700 requests, 60 runs), lock and DABS backoff key as before, and still costs ≤ 2 requests/day (page + XLSX only when a new list is posted; 1 page check/day otherwise). As before, a 1 h backoff still active at 16:30 (only possible if it started ≥ 15:30) makes that day's catalog tick a no-request `backoff`, and it tries again the next day (days 2–8). Nothing in the code needed a different slot. Nov 2 is the first day on the new time.

**Unchanged (verified in code and by tests).** 500 combined sweep + per-store ceiling, 700 requests/day (1,600 drop day), 60 runs/day (150 drop day), 40 per-store retry requests/day, 3 retries per SKU, 2 requests per SKU, 12 requests per tick, the 10 s gap, the 15 min pause after 3 distinct transient failures, the 1 h pause for 429 and other hard errors, the fresh-first retry order (`fresh_first_max1_interleave`), the fail-closed rule, the sweep window and crons, and the per-store "sweep must be complete" gate.

**Worst case: unchanged.** The day is bounded by the caps, not by the number of ticks. Per-store can't start a SKU or a retry once sweep + per-store would pass min(500, cap); its own work is at most (60 + 100) SKUs × 2 + 40 retry requests = 360; the catalog adds ≤ 2; and everything is under the 700/day reservation and 60 runs/day. More ticks only give the same bounded work more time to finish; idle ticks (queue done, pause/backoff, retries not due) send nothing and charge no run, and a finished day is a 1-row-read no-op.

**Tests** (local mock only, zero DABS requests): `test-perstore-retry.py` S9 now uses `*/5 11-15 * * *`; the 12:55, 13:55 and 14:30 ticks no longer close the row and the 15:55 tick does (`window_ended`, pending retry counted as skipped, nothing written); the retired `*/5 11-13` and `*/5 10-12` crons are rejected with no request. New S16 checks the crons, `EXPECTED_CRONS`, the 15:55 constant, the 16:30 catalog Utah-day mapping in MST and MDT, `/health` schedule and unchanged limits, and that the retired `30 14 2-8 * *` is rejected. `test-sweep-retry.py` T15/T17 were updated for the new per-store/catalog crons (sweep code unchanged).

First live test: the per-store pass at 4:00 AM MST on Mon Nov 2 (11:00 UTC), which is also the first day the catalog runs at 9:30 AM MST.

## 2026-11-02 — Per-store: narrow missing-store acceptance rule `prev_day_same_stores` (owner-approved)
**Why.** Six B1 SKUs (016009, 017920, 018537, 021297, 021986, 102996) have been stuck for days: DABS returns a clean store list whose quantities add up exactly to the sweep's statewide count but leaves out one or two stores we still hold with stock (two of them list 0 stores). Fail-closed kept the old counts, so the site showed stock DABS no longer reports. The owner approved one narrow exception and nothing else.

**Rule (implemented exactly).** A per-store list is accepted only when ALL hold:
1. DABS returned a clean 200 that parsed;
2. no store appears twice;
3. the quantities sum EXACTLY to today's sweep statewide count;
4. the ONLY problem is that stores we hold with stock are absent;
5. every currently-absent store was in the absent set recorded for that SKU on the previous Utah (America/Denver) day (a superset that day is fine).

Then the listed stores are written as a normal ok (counts, `verified_at`, freshness) and each absent store is written as qty 0, `inferred = 1`, `inferred_reason` = "absent from the DABS store list on <prev day> and <day> (list otherwise clean …)", plus an inferred snapshot row. A later list that includes the store again clears the flag.

**Unchanged, still fail-closed.** A store absent for the first time (no previous-day record, an older record only, or a previous-day set that lacks one of today's absent stores), any total mismatch (above or below), duplicates, a missing statewide count or parse problems write nothing, zero nothing and advance no freshness. Incomplete answers are still never retried. The admin `storeDetailSkus` path never applies the exception. No change to caps (700/day, 60 runs, 500 combined, 40 per-store retries/day, 3 per SKU, 2 requests/SKU, 12/tick), the 10 s gap, the 15 min streak pause, the 1 h 429 backoff, the fresh-first order, windows/crons or any sweep code. **Zero added requests:** the previous-day lookup and the record are D1 only.

**Storage (migration 0011).** `perstore_missing (sku, day, stores_json, listed, list_sum, statewide, outcome, source, fetch_id, recorded_at)`, PK (sku, day): written whenever "absent stores" is the only problem (`outcome` = `held` or `accepted_inferred`), so a chain of days keeps qualifying. `inventory_latest.inferred_reason`. `perstore_state` counters `accepted_inferred`, `inferred_stores`, `held_first_day_missing`, `qty_mismatch_above`, `qty_mismatch_below`, `dup_parse`, `transient_exhausted`, `retry_cap_dropped`, `other_failed`. `fetch_log.category`.

**Backfill.** The Nov 2 absent sets were derived read-only from that day's `fetch_log` `perstore_detail` rows (status `incomplete`, "absent" errors; every set had ≤ 10 stores, so the error text holds the full set) and written once as `perstore_missing` rows with `source = 'backfill'`, `outcome = 'held'` — exactly what the new code would have recorded. Quantity-mismatch SKUs were not backfilled (they never qualify).

**Reporting.** `/health → fetcher.perstore.missing_store_accept = "prev_day_same_stores"` and `fetcher.perstore.categories` (latest Utah day): `ok`, `accepted_inferred`, `inferred_stores`, `held_first_day_missing`, `qty_mismatch` (+ `_above` / `_below`), `dup_parse`, `transient_exhausted_522_timeout`, `retry_cap_dropped`, `other_failed`, `skipped`. Missing-store cases, quantity mismatches, 522/timeout exhaustion and retry-cap drops are reported separately (cap drops are no longer lumped under "522s/timeouts").

**UI.** The product page counts inferred stores among the stores without the bottle and says "(N of the stores without it are inferred out of stock: missing from the DABS list two days running)"; the JSON API exposes `inferred` per store. Store pages only list stores with stock, so inferred zeros drop off them.

**Tests** (local mock only, zero DABS requests): `test-perstore-retry.py` S17 accepted (superset previous day; listed store written, absent store 0 inferred with reason, freshness advanced, snapshot, product-page note, a later clean list clears the flag), S18 held when absent for the first time (no record / only a 2-days-old record) and the next day accepts, S19 held when the previous-day set lacks one of today's absent stores, S20 held on qty mismatch above and below even with a previous-day record, S21 held on duplicates, S22 zero-store list with statewide 0 and the same store absent the previous day accepted (and held without the record). Every scenario checks: no retry spent, 16 requests for 8 SKUs, one GetDetailUrl + one ProductDetail for the SKU, and the `/health` counters and `fetch_log.category`. New mock detail modes `drop1`, `drop1above`, `drop1below`, `drop12`, `dup`.

First live pass: Nov 3, 4:00 AM MST (11:00 UTC).

## 2026-11-03 — Catalog: automatic monthly import paused after 403s (owner-approved)
**Why.** The monthly catalog import (cron `30 16 2-8 * *`, 9:30 AM MST) got HTTP 403 on the abs.utah.gov product-list page on Nov 2 (`fetch_log` 1512) and again on the single owner-approved retry on Nov 3 (`fetch_log` 1763, 16:30:43 UTC; `catalog_import` 2026-11 = `failed`, attempts 2, `http_error: page HTTP 403`). The owner's rule: if the Nov 3 retry got another 403, pause the automatic import and do not keep retrying into a block. Without a change, the Nov 4 tick would have made attempt 3, and the December days 2–8 would have started fresh.

**Mechanism (smallest reversible, catalog only).** New KV flag `catalog:v1:auto` (`CATALOG_AUTO_KEY` in `src/fetchers/catalog-list.ts`). The cron path (`runCatalogTick(env, { cron: true })`) runs only when the flag is exactly `"on"`; absent or any other value = **paused** (default). A paused tick sends no request, takes no lock, charges no run or request, and logs one `fetch_log` row (kind `catalog`, status `paused`). The admin `{"catalogImport": true}` path is unchanged (owner-only, manual). Production KV has no `catalog:v1:auto` key, so the deploy is paused with no KV write. Re-enable with `npx wrangler kv key put --remote --binding UTAH_REMEDY_CACHE catalog:v1:auto on` (turn it back off by deleting the key). `/health → fetcher.catalog_auto_import = { state, key, scope: "monthly catalog cron only" }`.

**Unchanged.** Crons (including `30 16 2-8 * *`, still scheduled and now a no-op), the sweep, per-store, the global kill switch `dabs:v1:kill`, `FETCHER_ENABLED`, all caps (700/day, 500 combined, 60 runs, 40 sweep retries, 40 per-store retry requests, 3 per SKU, 2 requests/SKU, 12/tick), the 10 s gap, 15 min streak pause, 1 h 429 backoff, fresh-first order and the `catalog_import` row (attempts stay 2, nothing rewritten).

**Manual pull (prepared, not performed).** The November list is pulled by hand (owner downloads the XLSX in a browser), validated locally with the same guards as `download()` / `validateCatalog`, staged in KV `dabs:v1:catalog:staged:2026-11`, the `catalog_import` row set to `applying`, then applied by the admin path from KV with no DABS request. No request to abs.utah.gov was made for this change.

**Tests** (local mock only, zero DABS / abs.utah.gov requests): `test-perstore-retry.py` S23 — a `complete` row is pre-inserted for the current Utah month so a broken flag could never reach abs.utah.gov; `/health` shows `paused` with the key absent; the `30 16 2-8 * *` cron logs `catalog/paused` with no mock request, no run, no request charge and no lock; `off` stays paused; `on` shows `on` and reaches the normal complete no-op; the admin path returns its normal no-op both ways; the same per-store day gives an identical result with the flag absent and `on`. Results (separate jobs): `test-perstore-retry.py` S1–S22 195/195 pass, S23 initially failed on a hard-coded ok=8 that S22's leftover statewide 0 broke (test pollution, not product code); the check now compares paused vs on, and `s22 s23` re-run 16/16 pass. `test-sweep-retry.py` 116/116 pass.

## 2026-11-03 — Per-store: re-pause rule after a failed first request, window widened to 11:00–17:55 UTC (4:00–10:55 AM MST); catalog cron moved to 18:30 UTC (owner-approved, option C)

**Why.** Nov 1–3 per-store data: most 15 min streak pauses ended into a DABS that was still down, and the pass then spent 3 more failed requests (3 distinct SKUs) before pausing again (Nov 3: 13 pauses). Replaying the rule on the logs would have avoided 5 fresh + 5 retry failed attempts on Nov 1, 4 + 4 on Nov 2 and 8 + 6 on Nov 3. Retries recover late in the morning (retry 1: 36/67, retry 2: 15/19), so the window gets two more hours.

**1. Re-pause rule** (`PERSTORE_REPAUSE_RULE = "first_transient_after_pause"`, `src/fetchers/perstore.ts`). When a 15 min streak pause starts, `perstore_state.retry_json.probe = true`. The first request after the pause is the probe (still a fresh SKU first, as since 2026-10-31):
- probe fails with a transient error (500/502–504/520–527 or our 20 s timeout) → another 15 min pause starts immediately (`fetch_log` perstore/`paused`, "first request after a pause failed … re-pause 15 min"), the tick stops, `probe` stays on;
- probe succeeds, or DABS answers anything non-transient → `probe` off, normal running (3 distinct SKUs in a row → pause) resumes;
- a 429 (or other hard error) on the probe → the existing 1 h backoff, `probe` off.
**Retry accounting (decided):** the failed probe is counted exactly like the failure that triggers a pause today, i.e. like any transient failure: `transient_errors + 1`, the SKU's retry counter n + 1, requeued ≥ 15 min later (or failed for the day as `transient_exhausted` after 3 retries); if the probe was itself a retry it is charged to the 40/day retry requests as any retry. It never counts toward the 3-consecutive-failures stop. Only the 15 min streak pause arms the probe (not the 1 h backoff). The sweep is untouched.

**2. Window.** Per-store cron `*/5 11-17 * * *` = 11:00–17:55 UTC = 4:00–10:55 AM MST / 5:00–11:55 AM MDT, 84 ticks; `WINDOW_LAST_TICK_UTC_MIN = 17 * 60 + 55`, so `window_ended` closes at 17:55 (15:55 no longer does). The retired `*/5 11-15 * * *` is rejected by `EXPECTED_CRONS`. Sweep crons unchanged.

**3. Catalog.** Cron moved to `30 18 2-8 * *` = 11:30 AM MST / 12:30 PM MDT (same Utah day/month), clear of per-store. **Still paused**: KV `catalog:v1:auto` was not written; `30 16 2-8 * *` is now rejected.

**4. Volume (unchanged caps: 700/day, 60 runs, 500 combined ceiling, 40 sweep retries, 40 per-store retry requests, 3/SKU, 2 requests/SKU, 12/tick, 10 s gap).** Per-store requests are bounded by the frozen queue, not by the number of ticks: ≤ (60 B1 + 100 popular) × 2 + 40 retries = 360. Sweep ≤ ~115 pages + 40 = ~155. No per-store SKU or retry starts once the day's DABS requests (sweep included) + 2 would pass min(500, cap), so sweep + per-store ≤ 500 whatever the window length. Catalog is paused (0); if re-enabled it adds ≤ 2/day (+1 page check) at 18:30 UTC, after the ceiling-gated per-store window (absolute worst ≤ 502, still < 700, as before). Runs: `Budget.startRun` is fail-closed at 60/day (sweep + per-store + catalog); paused/backoff and waiting ticks return before a run is charged, so the 24 extra ticks only cost runs when they send requests (Nov 2: 51 runs, Nov 3: 35). The re-pause rule can only remove requests (it replaces up to 2 failed attempts per pause with a pause).

**/health.** `fetcher.perstore.limits.repause_rule = "first_transient_after_pause"`, `repause_min = 15`; `fetcher.schedule` lists the new crons; `catalog_auto_import.state = "paused"`.

**Daily status routine:** the owner moved the daily status to ~11:15 AM MT (routine change, outside this repo).

**Tests** (local mock only, zero DABS / abs.utah.gov requests; each suite run as separate, shorter chunked jobs). New/updated in `test-perstore-retry.py`: S9 (real ticks in `*/5 11-17`: 15:55/16:30/17:50 keep the row open, 17:55 closes it `window_ended`, waiting ticks charge no run, retired 10-12/11-13/11-15 crons rejected), S10 (pause → first request succeeds → probe off, normal running; a later single 5xx does not re-pause), S16 (crons, 17:55, 84 ticks, catalog 18:30 UTC = 11:30 MST / 12:30 MDT same Utah day, retired `30 14`/`30 16` catalog crons rejected), S23 (catalog still paused at the new cron), S24 (pause → first request 503 → immediate re-pause, counted as a transient failure, tick during the re-pause = backoff with no run charged, then a successful probe resumes), S25 (probe that is a due retry: re-pause, charged to the retry budget, n → 2), S26 (429 after a pause → 1 h backoff and probe off; 429 in normal running still 1 h; `/health` repause fields, other limits unchanged). S24–S26 first failed when run after S17–S22 because those scenarios change statewide qty and therefore the queue order (`ORDER BY store_total_qty`); they now re-read the real queue first (`resync_order()`), test pollution only, no product-code change. A first full run also hit a test-client socket timeout in S13 (S13 then passed alone). Results: per-store 216/216 pass (chunks S1–S8 54, S9–S10 24, S11–S13 18, S14–S18 56, S19–S23 46, S24–S26 18); `test-sweep-retry.py` (T15 updated for 17:55 / 84 ticks / 18:30) 116/116 pass (chunks T1–T6 48, T7–T12 22, T13–T17 32, T18 14 run alone).

## 2026-11-04 — Per-store: popular part of the queue goes stalest first (owner-approved, option D)

**Why.** The Nov 4 retry-budget review found 9 of the 11 bottles dropped at the 40-retry cap were popular bottles ~50 h old that first failed only after the cap was reached: they were late in the queue (rank order) and had not been reached the day before. Reserving retry budget (options A–C) would have saved ~0 of them and A/C hurt B1; reordering popular (D) would have reached up to 9 of them earlier at no cost to B1 and no extra requests.

**Rule.** B1 part unchanged (statewide qty DESC, SKU) and still first. Popular part: never-updated bottles first, then by last good per-store update, oldest first; ties → higher statewide quantity, then SKU. "Last good update" = newest `fetch_log` row with kind `perstore_detail` and status `ok` (includes category `missing_store_accepted_inferred`, which is logged as `ok`), the same definition as the review. Failed / held / mismatch rows don't count. One extra read query per day, at queue build (`popularLastGood` in `src/fetchers/popular.ts`, pure sort `sortStalestFirst`). Membership (locks, ranks, B1 dedup, zero-qty skip, ≤ 100) is unchanged.

**/health.** `fetcher.perstore.popular_order = "stalest_first"` (also `fetcher.perstore.popular.order`).

**Unchanged.** 40 retries/day, 3 per bottle, 2 requests per SKU, 12 per tick, 500 ceiling, 700 cap, 60-run cap; pause / re-pause rules, 1 h 429 backoff, 10 s gap, fail-closed, missing-store rule, fresh-first retry interleave; window 4:00–10:55 AM MST and all crons; sweep untouched; catalog import still paused.

**Note.** Bottles that stay stale for validation reasons (missing_store_held / qty_mismatch, e.g. 088709, 006155, 005350, 005242) will now sit at the front of popular every day until they validate; they cost 2 requests each and are not retried, so the effect is small.

**Tests.** New S27 in `scripts/test-perstore-retry.py` (local mock, zero DABS requests): stale before fresh, never-updated (incl. only-failed history) first, accepted_inferred counts as good, ties by qty then SKU, B1 unchanged and first, /health field, caps unchanged. All existing per-store and sweep scenarios re-run in chunks.

## 2026-11-05 — Popular auto-prune: stocked in every public DABS store (owner-approved)

**Why.** Bottles that show up in all ~50 open-to-the-public DABS stores are not scarce hunts and waste two DABS requests a day on the popular list. The owner pruned Michter's US*1 Bourbon (019880) by hand and asked for the same rule to run automatically.

**Rule.** When the daily popular queue is built (`selectPopularSkus` / `autoPrunePopularAllPublicStores` in `src/fetchers/popular.ts`):
- `publicStoreCount` = stores whose name is **not** a club store (`isClubStore` / `/club store|licensed operations only/i`, shared via `src/club-store.ts` with the UI).
- For each **unlocked** row in `perstore_popular`, `publicStoresWithStock` = inventory_latest rows for that SKU with `store_key <> ''`, `quantity > 0`, joined to a public store.
- If `publicStoreCount > 0` AND `publicStoresWithStock >= publicStoreCount`, DELETE the row (`DELETE … AND locked = 0`; the `perstore_popular_keep_locked` trigger still blocks locked deletes).
- Locked popular rows are never auto-removed. Club stores count in neither the denominator nor the numerator. If there are zero public stores, the rule is a no-op.
- Pruned SKUs are excluded from that day's frozen fetch list. An event is logged (`fetch_log` kind `perstore`, status `popular_auto_pruned`, detail includes skus / public_stores / rule).

**/health.** Under `fetcher.perstore.popular`: `auto_prune_rule = "all_public_stores"`, `public_stores` (live count), `last_auto_prune` `{ at, skus, count, public_stores }` from the latest event (or null).

**Unchanged.** Caps (B1 60, popular 100, 500 ceiling, 700 day, 40 retries/day, 3/SKU, 2 req/SKU, 12/tick), pause / re-pause, 1 h 429 backoff, fail-closed, missing-store rule (`prev_day_same_stores`), B1 selection and order, popular `stalest_first` order, windows/crons, catalog pause, admin lock/unlock/add/remove.

**Tests.** New S28 in `scripts/test-perstore-retry.py` (local mock, zero DABS requests): prune at all-public; keep at N−1; keep locked; club-only stock does not satisfy; zero public stores no-op; /health fields; caps and `stalest_first` unchanged. Per-store and sweep suites run as separate jobs.

## 2026-11-10 — Per-store: raise daily retry-request cap 40 → 50 (owner-approved)

**Why.** A read-only review of the last 10 days (Nov 1–10) found the 40-request per-store retry cap was reached on 8 days, and 7 of those days dropped bottles (74 drops across 65 bottles; almost all popular bottles that hit a 522 after the cap ran out). Retries recover well when they are allowed (171 of 202, 85%). Raising the cap to 50, not 60, was recommended: on the days with slack it would have peaked around 447 combined requests, well under 500, and would likely have saved about 6 bottles on mornings such as Nov 6 and Nov 10. A 60 cap added little more and risked turning a complete run into `window_ended` when extra 15 min pauses stacked near the end of the window. On the three mornings that already ran out of time, a bigger cap would not have helped.

**Change (exact scope).** `PERSTORE_RETRY_REQUEST_LIMIT` 40 → **50** (`src/fetchers/perstore.ts`). `/health` → `fetcher.perstore.limits.retry_request_limit_per_day` = 50. Status output (`retry requests x/50`) and the `retry_cap_dropped` category still use the live constant. The two budgets stay separate: the sweep retry cap is still 40.

**Unchanged.** 3 retries per bottle, the 15-minute pause and re-pause rules, the 429 one-hour pause, the 10-second gap, fresh-bottles-first / stalest-popular-first ordering, fail-closed behavior, and the 4:00–10:55 AM MST window (`*/5 11-17 * * *`, last tick 17:55 UTC). The 500 combined ceiling remains the hard limit: no request may be started that would exceed it (`used + 2 > min(500, day cap)` is unchanged). The 700/day cap, 60 runs/day, 2 requests/SKU, 12 requests/tick, the sweep (including its 40 retry cap, 30 min page rest, crons and window), and the paused catalog import are unchanged.

**Requests.**

| Day | Sweep | Per-store | Catalog | Total | vs 500 / 700 |
|---|---|---|---|---|---|
| Normal (Oct 23 baseline) | ~114 | ~277 | 0–2 | **~391–393** (unchanged) | ~107 under 500, ~307 under 700 |
| Retry-heavy (all 40 sweep + 50 per-store retries) | 154 | ~327 (was ~317) | 0–2 | **~481–483** (was ~471–473) | ≥ 17 under 500, ≥ 217 under 700 |
| Absolute worst | 154 | stops at the 500 combined ceiling | ≤ 2 (paused today = 0) | **≤ 502** (unchanged) | ≥ 198 under 700 |
| 3rd-Saturday drop day (cap 1,600, popular skipped) | ≤ 154 | B1 only ≤ 120 + 50 | 0–2 | **≤ ~326** (was ≤ ~316) | ceiling still min(500, 1600) = 500 |

If per-store reaches its 143-SKU high end (~286 + 50 = 336), the retry-heavy day is ~490–492, which is still under 500. The 500 ceiling still bounds the true worst case: per-store will not start a SKU or a retry if today's requests, sweep included, would pass min(500, cap). A higher retry cap can only use requests that are still free under that ceiling.

**Tests** (`scripts/test-perstore-retry.py`, local mock only, no DABS requests):
- S3: with 49 of 50 used, the pending retry is failed and not sent; `retry_requests` never exceeds 50.
- S13b: a timed-out retry is charged 48 → 49, then the cap fails the SKU with no further request (`retry_requests` ≤ 50).
- S16 (and S5, S14, S15, S26, S27, S28 `/health` assertions): `retry_request_limit_per_day` = 50; other limits unchanged (3/SKU, 15 min delay/pause, 500 ceiling, 2 requests/SKU, 700/day, 60 runs).
- S6a/S6b still assert `used <= 500` on the first-try and retry ceiling paths.

Sweep tests are unchanged (cap still 40). Suites are run as separate jobs.

First live pass with the 50 cap: Nov 11, 4:00 AM MST.

## 2026-11-12 — Feedback form, bot triage endpoints and "Tip the dev" link (owner-approved)

**Scope.** Two user-facing additions. No change to data fetching (sweep, per-store, catalog), caps, pauses, retry limits, crons, fail-closed behavior, the 21+ gate, the DABS disclaimers or analytics counting rules. `src/fetchers/*` and `src/analytics.ts` are untouched. Structure follows Agenda Watch's feedback design (Agenda Watch `web/app.py`, read-only reference), ported to the Worker + D1.

**Files.** `src/feedback.ts` (new), `src/tip.ts` (new), `migrations/0012_feedback.sql` (new, additive), `src/index.ts` (routing + Env only), `wrangler.jsonc` (`send_email` binding `EMAIL`, var `NOTIFY_TO`), `public/assets/style.css` (appended classes), `scripts/feedback-bot.sh` (new), `scripts/test-feedback.py` (new).

**Existing pages.** The only change is a footer "Feedback" link on every HTML page, plus the tip link on the home and product pages. Both are injected with HTMLRewriter after the Cache API (so a config change needs no cache purge); page sources are unchanged.

**Tip the dev.** Rendered only when `CASHAPP_HANDLE` holds a valid cashtag (1–20 letters/digits/`_`/`-`, a leading `$` is stripped): `https://cash.app/$<handle>`, `target=_blank rel="noopener noreferrer external"`. Unset/empty/invalid means nothing renders. Home: inside the hero, under the search box. Product pages (`/product/:sku`, 200 only): a card at the end of the page. To turn it on with no code change: `npx wrangler secret put CASHAPP_HANDLE` (takes effect immediately), or add it to `vars` and `npm run deploy`.

**/feedback.** Public (in `PUBLIC_PATHS`, like `/terms` and `/privacy`): it is not alcohol content, and an under-21 visitor can still report a problem. It gets the injected disclaimer and is never counted (public paths never are). CSP is widened on `/feedback` only, and only when Turnstile is configured (`script-src`/`frame-src https://challenges.cloudflare.com`); every other page keeps `script-src 'none'`.
- Fields: category (Irrelevant alert, Missed alert, Suggest a source, Bug, Other), message (≤ 2,000), optional city (free text ≤ 80), link (http/https ≤ 500), email.
- Spam layers in order: CSRF (double-submit `__Host-` cookie, SameSite=Strict) → Turnstile (required; siteverify unreachable = not accepted) → honeypot `website` → HMAC-signed timed token (≥ 3 s, < 1 h) → 5 per IP per hour (D1 `feedback_hits`, IP stored only as an HMAC hash, purged after 1 h) → content filter (Agenda Watch spam phrases + outside links; utahremedy.com and *.utah.gov don't count) → 100 stored per Utah day.
- Honeypot, bad or missing token, too fast and content spam are dropped quietly: the normal Thanks page, nothing stored, no email. Turnstile failure, rate limit and the daily cap show an error (as Agenda Watch). Every drop keeps a 200-char sample in `feedback_spam` (14 days, max 300 rows).
- **Fails closed:** until `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` + `UR_FEEDBACK_BOT_TOKEN` all exist, the form renders with a "temporarily unavailable" note and POST returns a friendly 503; nothing is stored. Turnstile is never skipped.
- `user_id` comes only from a signed-in session. Utah Remedy has no sign-in, so it is always NULL; the reply address is the typed email.

**Owner notice.** One short email per stored item to `NOTIFY_TO` (hello@utahremedy.com) from `Utah Remedy <hello@utahremedy.com>`, Reply-To hello@: id, category, city, sender line, first 300 characters, link to `/__ur/admin#fb-<id>`. No email to the submitter. Feedback emails (notices + replies, shared like Agenda Watch) are capped at 30 per Utah day, and never use the last 10 sends of the daily quota (`EMAIL_DAILY_QUOTA`, default 100). Utah Remedy has no sign-in-link mail yet; the reserve is kept for it. Every attempt (sent / error / suppressed) is logged in `feedback_mail_log`. A failed send never blocks storage.

**Bot endpoints.** Header `X-UR-Feedback-Token` = secret `UR_FEEDBACK_BOT_TOKEN` (timing-safe compare; 404 when the secret is unset, 403 when wrong). Handled before the gate and analytics, like `/internal/*`.
- `GET /__ur/feedback?status=new|needs-you|needs-owner|replied|reviewed` (comma list ok).
- `POST /__ur/feedback/{id}/status` `{"status":"needs-you"|"reviewed","note"?}`; refused (409) once replied.
- `POST /__ur/feedback/{id}/reply` `{"text"}`: one plain-text email from hello@ with Reply-To hello@. Refused if there is no reply address (409). A replied item is a no-op (`already: true`, no email). A D1 lock row stops concurrent double sends. A failed send returns 502 (429 when suppressed by a cap), is NOT marked replied, and releases the lock.
- `GET /__ur/admin`: read-only HTML with every item, status, owner note, reply sent, recent email attempts, 14-day spam sample. Auth: the same header, or browser Basic auth with any username and the token as the password.
- Helper: `scripts/feedback-bot.sh` reads the header from `~/.config/utah-remedy/feedback-bot.header` (chmod 600) via `curl -H @file`, so the secret never appears in argv or logs.

**Email path status.** Utah Remedy had no outbound email before this change. Email Routing (inbound, hello@ → owner Gmail) was already set up. The new `send_email` binding uses Cloudflare Email Service. Until utahremedy.com is onboarded for Email Sending, sends to non-verified addresses (including hello@ itself and any user) fail; they are logged and fail closed.

**Tests.** `scripts/test-feedback.py` (local only; mock Turnstile, local email simulator, throwaway token, zero DABS) phases a/b/c: 83 checks. Per-store, sweep and analytics suites re-run as separate jobs.


## 2026-11-13 — Automatic same-day sweep catch-up (owner-approved, t79u)

**Why.** The 2026-11-13 nightly sweep ended incomplete (84/115 pages ok, 28 never tried, 3 failed 3×; 26 × 522 + 1 timeout, 9 streak pauses; a pause ran past the 10:55 UTC hard stop), so per-store was skipped and statewide data went stale at 1:57 PM MST. The owner approved a one-time catch-up that evening and an automatic rule for future days.

**One-off (2026-11-13, sweep 5:38–5:53 PM MST; per-store from 5:53 PM, hard stop 11:30 PM MST).** The day's `sweep_state` row was reopened from `failed` to `running` (one guarded UPDATE: `day = '2026-11-13' AND status = 'failed' AND next_start = 4176`, plus a `fetch_log` note `catchup_reopened`), then driven with the existing admin `{"sweepTick":true}` endpoint at cron cadence (5 min). Same code path, lock, budget, caps; counters continued (retry requests 24 → 27 of 40). After completion the skipped per-store row was deleted and the existing `{"perstoreTick":true}` endpoint was driven every 5 min. Driver: `logs/catchup-1113/drive.sh` (token only via a 0600 header file, UA `UR-ops-catchup/1113`). No schedule or permanent limit changed for it. Result: 31/31 pages ok (3 retries, 0 transients, 0 pauses), 31 requests, total 5,516, vanished_applied 11, source status ok (stale/failed banner cleared). Twice (01:00 and 01:15 UTC) a manual per-store invocation ended mid-SKU with no response; the SKU was not advanced or written, the lock expired after 6 min, and the next tick re-did that SKU (fetch_log rows 4687/4697 marked `aborted`). After migration 0013 the day's row was backfilled (`catchup_status = complete`, baselines 84 pages / 24 retries / 111 requests) so `/health → sweep_catchup` and the next daily status show it. The driver was restarted once (drive2.sh, per-store only, start-to-start 5 min) after the box paused.

**Rule (automatic).**
- *What counts as incomplete:* only a nightly sweep closed by the 10:55 UTC hard stop (`closeWindowEnded`, error `window_ended: …`): pages never tried and/or pages still waiting for a retry/rest. In the same UPDATE `catchup_status` becomes `queued`. Not queued (fail closed, owner decides): `retry_limit` (40/day used), 429, other hard HTTP / network errors, bad shape, the count-collapse check, a disabled fetcher.
- *State used:* the same day's `sweep_state` row: `next_start`, `total_last`, `retry_json.pending` (unfinished = main-cursor pages left + pending retries), `retry_requests`, plus `fetch_budget.dabs_requests`.
- *When:* cron `*/5 20-22 * * *` = 20:00–22:55 UTC = 1:00–3:55 PM MST (after the 04:00–10:55 MST per-store window and the 11:30 MST catalog tick). First tick that sees `queued` starts it; hard stop at the 22:55 UTC tick.
- *Start conditions:* the row is still `failed`; at least one page succeeded overnight (total known: otherwise it would be a full sweep → `skipped`); with retries pending, `retry_requests + 1 ≤ 40` (else `skipped`); `dabs_requests + unfinished pages ≤ min(500, day cap)` (else `skipped`; headroom can't grow later the same day). Kill switch / `FETCHER_ENABLED` stop it like any run.
- *How:* the row is reopened (`running`, `catchup_status = running`, the nightly error kept in `catchup_note`, baselines stored) and the unchanged `runSweepTick` runs it with two catch-up-only options: last tick = 22:55 UTC instead of 10:55, and no sweep request starts past min(500, cap). Everything else is the nightly code: 10 s gap, 12 requests/run, 3 retries/page then 30 min rest, 3 distinct pages in a row → 15 min pause and re-pause, 429 → 1 h, fail-closed validation, drift/coverage/vanish safety checks, vanish-to-zero only on a complete sweep. Counters continue (never reset). Never a second full sweep: the cursor continues at `next_start`.
- *End:* `complete` (normal finalization incl. vanish-to-zero, source status ok, stale/failed banner clears) or `failed` (a hard error / retry_limit during the catch-up, or still unresolved at 22:55 UTC). A failed catch-up is never re-queued.
- *Per-store follow-on:* only if the catch-up sweep completed, today's per-store row is `skipped` with "nightly sweep not complete", and `dabs_requests + 2 ≤ min(500, cap)`. The skipped row is replaced by a normal per-store pass (`perstore_state.catchup = 1`): same frozen-queue rules (B1, popular stalest-first, auto-prune), 50 retry requests/day, missing-store rule, fail closed, 500 ceiling; closes `window_ended` at 22:55 UTC. At most one per day; never when the normal pass already ran.
- *Idle cost:* every other catch-up tick is one D1 row read: no lock, no run, no DABS request.
- *Reporting:* `/health → fetcher.sweep_catchup.{today, previous_day}`: status, note, start/finish, unfinished pages, pages ok, retries used (and day total), transients, pauses, sweep requests, in-stock total, vanished applied/skipped, pages still failed, per-store status/ok/failed/inferred/qty mismatch/cap drops/requests, day DABS requests. The daily status runs ~11:15 AM MT, before the window, so it reports the **previous** day's catch-up.

**DST.** Crons are UTC. During MDT (second Sunday of March – first Sunday of November) the same window is 2:00–4:55 PM MDT, like every other window (they all shift one hour later). Still the same Utah day, still after per-store (last tick 11:55 AM MDT). Not changed automatically; if the owner wants 1:00–4:00 PM local in summer, that's a cron change (`*/5 19-21 * * *` during MDT) for approval.

**Unchanged.** Nightly window 07:30–10:55 UTC, per-store window 11:00–17:55 UTC, catalog 18:30 UTC, sweep retry cap 40, per-store retry cap 50, 3 retries per page/bottle, 15 min pause/re-pause, 429 1 h, 10 s gap, 60 runs/day, 700/day cap, 500 combined ceiling, fail-closed rules, missing-store rule.

**Files.** `src/fetchers/catchup.ts` (new), `migrations/0013_sweep_catchup.sql` (additive), `src/fetchers/sweep.ts` (queue on window end; catch-up options; catch-up status on complete/fail), `src/fetchers/perstore.ts` (optional last-tick override), `src/index.ts` (cron, admin `catchupTick`, /health), `wrangler.jsonc` (cron).

**Tests.** Sweep suite `scripts/test-sweep-catchup.py` (C1–C8, 38 checks) and per-store suite `scripts/test-perstore-catchup.py` (P1–P6, 15 checks), each its own job; existing sweep and per-store suites re-run as separate jobs with the new cron in their schedule checks.

## 2026-11-13 — Pin all scheduled windows to America/Denver local time (owner-approved, t80u)

**Why.** Cron Triggers are UTC-only, so every window shifted one hour later in Utah during MDT. The owner asked for the same local clock times all year. Nothing else changes: caps, pause rules, fail-closed behavior, the day key and counters, and the logic of when each job acts are untouched. Only the clock time each tick is judged against changed (UTC → America/Denver).

**Local windows (America/Denver, all year).** Sweep 12:30–3:55 AM, hard stop at the 3:55 AM tick. Per-store 4:00–10:55 AM, hard stop at 10:55 AM. Catalog 11:30 AM on local days 2–8 (cron path still paused unless KV `catalog:v1:auto` = `on`). Same-day catch-up 1:00–3:55 PM, hard stop at 3:55 PM. The daily status (~11:15 AM) is a Grok Bot routine pinned with CRON_TZ, not in the Worker.

**How.** `src/schedule.ts`: `LOCAL_WINDOWS`, `localTime()` (Intl, `timeZone: "America/Denver"`, `hourCycle: "h23"`; no hardcoded offsets), `inLocalWindow(job, ms)`, `isLocalLastTick()`. Each cron covers the union of the window's MST (UTC-7) and MDT (UTC-6) hours:

| Job | Cron (UTC) | MST acting ticks (UTC) | MDT acting ticks (UTC) |
| --- | --- | --- | --- |
| sweep | `30-55/5 6 * * *`, `*/5 7-10 * * *` | 07:30–10:55 | 06:30–09:55 |
| per-store | `*/5 10-17 * * *` | 11:00–17:55 | 10:00–16:55 |
| catalog | `30 17,18 2-8 * *` | 18:30 | 17:30 |
| catch-up | `*/5 19-22 * * *` | 20:00–22:55 | 19:00–21:55 |

`scheduled()` first checks the exact-string allowlist (`EXPECTED_CRONS`, unchanged behavior), then the local gate: if the tick's `scheduledTime` in America/Denver is outside the job's window, it logs one console line and returns. No D1 or KV access, no lock, no run charged, no DABS request, no state change. Hard stops moved from UTC minutes (10:55 / 17:55 / 22:55 UTC) to local minutes (3:55 AM / 10:55 AM / 3:55 PM) via `isLocalLastTick`; catch-up passes its 3:55 PM local hard stop exactly as it passed 22:55 UTC before. The local windows are disjoint, so on the shared UTC minutes (10:00–10:55 UTC: sweep in MST, per-store in MDT; 17:30 UTC on days 2–8: per-store in MST, catalog in MDT) exactly one job acts and the other is a pure no-op. Cron count stays 5 (Workers Paid limit: 250 per account).

**Day key.** Unchanged: `guard.ts mtDay()` = the America/Denver date at execution time (used by the budget, sweep_state, perstore_state and catch-up). The first sweep tick is 12:30 AM local, never on the Utah-day boundary.

**MST equivalence.** In MST the set of acting (UTC minute, job) ticks is exactly the pre-2026-11-13 schedule (`30-55/5 7`, `*/5 8-10`, `*/5 11-17`, `30 18 2-8`, `*/5 20-22`), checked minute by minute for 2026-11-14, 2026-12-03, 2027-01-05 and 2027-01-15. So nothing changes in behavior until 2027-03-14.

**DST transitions.**
- *Spring forward, Sun 2027-03-14 (2:00 MST → 3:00 MDT).* Local 2:00–2:59 doesn't exist. Sweep acts 12:30–1:55 AM MST (07:30–08:55 UTC) and 3:00–3:55 AM MDT (09:00–09:55 UTC): 30 ticks instead of 42; hard stop once at 3:55 MDT (09:55 UTC). Per-store 4:00–10:55 MDT (10:00–16:55 UTC, 84 ticks); catch-up 1:00–3:55 PM MDT (19:00–21:55 UTC). A clean sweep needs ~11 ticks, so 30 is enough unless DABS is unhealthy; an unfinished sweep is closed `window_ended` at 3:55 and the catch-up rule applies as usual.
- *Fall back, Sun 2027-11-07 (2:00 MDT → 1:00 MST).* Local 1:00–1:55 happens twice. Sweep acts 12:30–1:55 AM MDT (06:30–07:55 UTC) then 1:00–3:55 AM MST (08:00–10:55 UTC): 54 ticks, all the same Utah day, same `sweep_state` row and counters. The repeated hour is just more ticks: the cursor/retry queue continue, a complete/failed row makes later ticks no-ops (never a second sweep), and the hard stop happens once, at 3:55 MST (10:55 UTC); the repeated 1:xx ticks are below 3:55 so they can't trigger it. The 60 runs/day cap, 40 sweep retries, 500 ceiling and 700 cap are unchanged and still enforced; ticks that can't send don't charge a run. Worst case a struggling sweep could spend more of the shared 60 runs that night than on a 42-tick night, leaving fewer for per-store (fail closed at the cap, as always).
- Per-store, catalog and catch-up never touch a transition hour.

**Cost.** 198 cron invocations/day instead of 162 (199 vs 163 on days 2–8): about 36 extra pure no-op invocations a day, zero DABS requests, zero D1/KV operations from them.

**/health.** `fetcher.local_schedule`: time zone, gate description, `now_local`, and per job the local window, first/last tick, UTC crons, `open_now` and `next_open` (UTC and local). `fetcher.sweep_catchup.window` now reports `local`/`hard_stop_local` ("15:55") instead of UTC.

**Tests.** New `scripts/test-schedule-dst.ts` (pure logic, `node --experimental-strip-types`): Jan 15 2027 MST, Jul 15 2027 MDT, Mar 13/14/15 2027, Nov 6/7/8 2027, catalog days, out-of-window no-ops, `/health` next-open, MST equivalence with the old schedule, every day 2026-11-14..2027-12-31. Sweep suite T19 fires the real `scheduled()` at DST instants (out-of-window no-ops leave rows/logs/budget/lock/mock hits unchanged; Mar 14 hard stop at 09:55 UTC; Nov 7 repeated 1:30 continues the same row; hard stop at 10:55 UTC). Existing suites now fire `scheduled()` on a fixed MST date (2027-01-05) and the new cron strings; the five pre-2026-11-13 expressions are checked as rejected.

**Files.** `src/schedule.ts` (new), `src/index.ts` (EXPECTED_CRONS, gate, /health), `src/fetchers/sweep.ts`, `src/fetchers/perstore.ts`, `src/fetchers/catchup.ts` (local hard stops), `wrangler.jsonc` (crons), README, tests.

**Deployed** 2026-11-13 11:21 PM MST with `npm run deploy`: commit `1d751d0`, worker version `b25f7fd9-bdae-45a8-a442-264c95616bd3` (before the 12:30 AM sweep; nothing was running). `/health` shows commit 1d751d0, the 5 new crons and `local_schedule` (next opens: sweep 2026-11-14 00:30 MST, per-store 04:00 MST, catch-up 13:00 MST, catalog 2026-12-02 11:30 MST). Test results, each its own job (logs/t80u/): typecheck ok; DST logic 82/0; sweep T15+T17+T19 31/0, T1–T6 48/0, T7–T12 22/0, T13/T14/T16 18/0, T18 14/0; sweep catch-up 38/0 (first run 37/1: C8 still looked for the old UTC constant; fixed before commit, rerun passed); per-store catch-up 15/0; per-store S1–S8 54/0, S9–S10 24/0, S11–S13 18/0, S14–S18 56/0, S19–S23 46/0, S24–S26 18/0, S27 8/0, S28 17/0; feedback 83/0; analytics 26/0.

## 2026-11-15 — t84u: privacy wording + owner admin password (owner-approved)
**Deployed** 2026-11-15 11:15 PM MST with `npm run deploy`: commit `f8375e2`, worker version `9029c5af-1d9b-4839-96a4-8b630be57a70` (no data window open).
- Privacy page: describes the feedback form as it works today. The optional email is used only to reply. A salted HMAC of the IP is kept for the 5/hour limit, and rows older than 1 h are purged on the next limit check. Spam samples (200 chars, topic, reason, IP hash) are kept 14 days and purged on the next drop. The page also covers Turnstile and the 2 h CSRF cookie. "Later" no longer says email arrives with alerts. Last updated is Nov 15, 2026.
- `ADMIN_OWNER_PASSWORD` (secret, set by the owner, >= 12 chars): Basic auth with any username opens read-only GET /__ur/admin only. It is refused on /__ur/feedback, all POSTs and the bot header. Unset or short disables it, and no bot secret means 404. Constant-time compare, never logged.
- Tests (logs/t84u/, each its own job, all 0 failed): typecheck ok; feedback 106; sweep sched 31, w1 48, w2 22, w3 18, w4 14; sweep catch-up 38; per-store catch-up 15; per-store c1 54, c2 24, c3 18, c4 56, c5 46, c6 18, c7 8, c8 17; analytics 26.
- Live checks (UR-ops-verify UA): /health ok, commit f8375e2; /privacy shows the new text. /__ur/admin: no auth 401, bogus 401, owner 200. Owner credentials on GET /__ur/feedback, POST status, POST reply and POST /__ur/admin got 403/403/403/401, and as the bot header 403. No DABS requests.

## 2026-11-16 — t85u: tip section at the bottom, /tip page, Venmo, QR codes (owner-approved)

**Deployed** 2026-11-16 6:21 PM MST with `npm run deploy`: commit `c48c5b8`, worker version `8587b203-0141-4a62-b485-25f4b510c202` (no data window open). Secret `VENMO_HANDLE` set with `wrangler secret put` (piped from a 0600 file). `CASHAPP_HANDLE` was already set. No cap, window, cron, pause, or DABS-logic change.

**Bottom tip section.** The Cash App / Venmo tip card is injected at the end of `<main>` on public HTML 200s (home, product, search, stores, terms, privacy, disclaimer, feedback, and other public pages), after the age gate for gated pages. It is not shown on `/gate`, `/not-eligible`, 404s, or `/tip` itself (that page has the larger layout). Copy is low-pressure: tips are optional and help cover hosting and data costs. Each configured method gets a labeled button (`rel="noopener noreferrer external"`, new tab) and a compact QR.

**Header link.** A small "Tip the dev" link is appended to the header nav, next to Disclaimer, and goes to `/tip`. Hidden when no valid tip method is configured.

**`/tip`.** Age-gated (not a public path). Title "Tip the dev — Utah Remedy". Polite, low-pressure wording: independent solo project, free tool, tips help cover hosting/data costs, entirely optional, no perks, nothing changes if you don't tip, not affiliated with DABS. No urgency copy and no feature promises. Larger QRs, mobile layout, CSP unchanged (`script-src 'none'`). The persistent DABS disclaimer and 21+ footer stay on the page.

**Methods.** `CASHAPP_HANDLE` (cashtag, leading `$` stripped) → `https://cash.app/$<handle>`. `VENMO_HANDLE` (bare handle, `@handle`, or a venmo.com profile URL) → `https://www.venmo.com/u/<handle>`. Unset or invalid omits that method only.

**QR codes.** Generated at request time as inline SVG (`uqr`, ECC M, presentation attributes only so they stay within `style-src 'self'`). Labeled Cash App / Venmo, with alt text. Payloads were decoded from the owner's screenshots, then the same URLs were encoded into clean QRs and scan-verified:
- Cash App screenshot → `https://cash.app/$Quazar16?qr=1` (profile URL plus `?qr=1`).
- Venmo screenshot → `https://www.paypal.com/qrcodes/venmocs/51db6324-8b39-48c1-b215-9ad07680ee72?created=1794872698`. This is the official PayPal/Venmo business QR for @Quazar16, not the public profile URL. The clickable Venmo link is still `https://www.venmo.com/u/Quazar16`. That PayPal payload is used only when the configured handle is Quazar16; any other handle falls back to its profile URL.

**Privacy.** Short "Tips" section added: tip links and QR codes go to Cash App and Venmo (third parties); no payment details are entered on or sent through this site. Last updated November 16, 2026.

**Files.** `src/tip.ts` (rewritten), `src/index.ts` (`/tip` route + `VENMO_HANDLE`), `src/feedback.ts` (admin tip line), `public/assets/style.css`, `public/privacy.html`, `wrangler.jsonc` (comment), README, `scripts/test-feedback.py`, `scripts/test-tip-qr.ts` (new). Dependency: `uqr` 0.1.3. Dev dependency: `@zxing/library` 0.21.3 (QR scan test only).

**Tests** (logs/t85u/, each its own job, all 0 failed): typecheck ok; tip-qr 2; DST logic 82; feedback 124; sweep sched 31, w1 48, w2 22, w3 18, w4 14; sweep catch-up 38; per-store catch-up 15; per-store c1 54, c2 24, c3 18, c4 56, c5 46, c6 18, c7 8, c8 17; analytics 26.

**Live checks** (UA `UR-ops-verify/tip`): `/health` ok, commit `c48c5b8`. `/tip` without the age cookie → 302 `/gate?next=/tip`; with the cookie, 200 with the wording, both links, both QR payloads, DABS disclaimer, and 21+ footer. Home and `/product/021986` show the header link and the bottom section with both links and both inline QR SVGs. Privacy page has the new Tips section. Gate has no tip section or `/tip` nav. No DABS requests.

## 2026-11-18 — t88u: owner notices and user replies on (Email Sending onboarded, owner-approved)

**Deployed** 2026-11-18 5:26 PM MST with `npm run deploy`: commit `93636a8`, worker version `31a3ae1f-4210-4ab0-9fca-cdcdc773f46f` (no data window open). No cap, window, cron, pause, or DABS-logic change.

**Email Sending.** utahremedy.com was onboarded on 2026-11-17 (enabled, DKIM selector `cf-bounce`, return-path `cf-bounce.utahremedy.com`). The existing `send_email` binding `EMAIL` (allowed sender `hello@utahremedy.com` only) and `env.EMAIL.send()` path in `src/feedback.ts` did not need an API change. Owner notices and bot replies, which had been failing closed until the domain was onboarded, are now on.

**Owner notices.** One short email per stored feedback item to `NOTIFY_TO` (`hello@utahremedy.com`, the project inbox; Email Routing already forwards that address to the owner's verified Gmail) from `Utah Remedy <hello@utahremedy.com>`, Reply-To hello@. No confirmation email to the submitter. Caps unchanged: 30 feedback emails per Utah day, last 10 of `EMAIL_DAILY_QUOTA` (default 100) reserved. Failures are logged in `feedback_mail_log` and never block storage.

**User replies.** `POST /__ur/feedback/{id}/reply` (bot token header only) sends one plain-text reply from + Reply-To hello@. Idempotent; no reply address → 409; failed send → 502 (429 if suppressed), not marked replied. Automatic bot replies stay limited to the routine category; everything else waits for an explicit owner yes. Reply text describes only how the product works today and does not promise new features.

**Test-send.** `POST /__ur/feedback/test-send` (bot token header only; owner password refused) sends one clearly-labeled owner notice (`TEST - Remy outbound email check`) to `NOTIFY_TO` only. Any `to` in the body is ignored. Helper: `scripts/feedback-bot.sh test-send` (header file only).

**Live test send** 2026-11-18 5:27 PM MST via `scripts/feedback-bot.sh test-send` (header from `~/.config/utah-remedy/feedback-bot.header`, chmod 600; token never on the command line or in logs). HTTP 200, `sent: true`, kind `notice`, Cloudflare message id `UMzZ7M7F38xV8mHy6Ebe5ijmOQNmtB6Mps5W@utahremedy.com`. No email was sent to a user or third party.

**Files.** `src/feedback.ts` (test-send + comments), `wrangler.jsonc` (onboarded comment), `scripts/feedback-bot.sh`, `scripts/test-feedback.py`, README.

**Tests** (logs/t88u/, each its own job, all 0 failed): typecheck ok; feedback 133; sweep sched 31, w1 48, w2 22, w3 18, w4 14; sweep catch-up 38; per-store catch-up 15; per-store c1 54, c2 24, c3 18, c4 56, c5 46, c6 18, c7 8, c8 17; analytics 26.

**Live checks** (UA `UR-ops-verify/email`): `/health` ok, commit `93636a8`; EMAIL binding present; `NOTIFY_TO` set. No DABS requests from this deploy or the test send.

## 2026-11-21 — Sign-in (watches design step 1) + shared email budget (owner-approved t99s544)

**What.** Email magic-link sign-in per `ai-context/WATCHES-DESIGN.md` section 2 with all recommended defaults: `/signin` (email, required "21 or older and agree" box, Turnstile using the existing `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET`, CSRF cookie, timed form token, honeypot), `/auth/verify` (GET shows a "Finish signing in" button and never consumes the link; POST is single-use via one `UPDATE ... WHERE used_at IS NULL AND expires_at > now`), 15-minute links (only SHA-256 stored), 30-day absolute session cookie `__Host-ur_session` (HttpOnly, Secure, SameSite=Lax; only SHA-256 stored; max 5 per user), `/signout`, `/account/signout-all`, `/account/delete` (sessions, watches, alerts, pending links and the user row in one batch; feedback kept but unlinked), minimal `/account` page, header "Sign in"/"Account" link (cookie presence only, no D1 read). Limits with salted HMAC hashes only: per IP 5/h + 20/day, per email 3/h + 6/day, bad verify 20/IP/h. The POST /signin response is identical for every address; limits, token and email run after the response. Retention purges run after sign-in requests (links/hits 24 h, expired sessions, alert rows 90 days, accounts inactive 12 months with no active watches). Auth pages are behind the 21+ gate, `no-store`, and never counted in analytics. Watches UI and alerts are NOT built.

**Email budget** (`src/mail-budget.ts`): Email Sending limit 200/day, treated as account-wide. Alerts 120 (reserved, unused), sign-in 40, feedback 30, spare 10; hard site-wide stop 190; a non-sign-in send also needs room for the sign-in links not yet sent today. One atomic conditional INSERT per send (reserve, send, settle). Feedback mail now reserves through the same budget (cap 30 unchanged); `EMAIL_DAILY_QUOTA` default 100 -> 200.

**Privacy/Terms.** Section 6 wording published in the same deploy (last updated November 21, 2026).

**Migration** `0014_auth.sql` (additive): users.terms_version, users.last_signin_at, auth_tokens, sessions, auth_hits, mail_log. Applied remotely 2026-11-21 ~3:20 PM MST.

**Deploy.** Commit `7fffbca` (on top of the owner-IP analytics commit `d0ca5ae`), worker version `a4305ada-29ec-4462-90b2-4ad946a473d1`, `npm run deploy` at 3:20 PM MST.

**Tests** (logs/step1-auth/, by scope per t94u; slow per-store and sweep suites not run, job code untouched): typecheck ok; `scripts/test-mail-budget.ts` 26/0; `scripts/test-auth.py` 86/0; `scripts/test-feedback.py` 225/0.

**Live checks** (UA `UR-ops-verify/1.0 (step1-auth)`): `/health` ok, commit `7fffbca`; `/signin`, `/account`, `/auth/verify` redirect to the gate without the age cookie; `/signin` 200 behind the gate with Turnstile, no-store, Turnstile-only CSP; fake Turnstile token -> 400 "could not verify", nothing stored or sent (remote: 0 tokens, 0 mail_log, 0 users); header Disclaimer / Tip the dev / Sign in on home, /tip, /stores, all 200; `/account` signed out -> /signin; Privacy and Terms show the new wording. No live sign-in email sent (no safe automated path past real Turnstile).

## 2026-11-22 — Sign-in: used link while signed in continues silently; "Utah Remedy Home" (owner-approved t101u/t102u)

**Why.** The owner's second sign-in showed "This link isn't valid": "Finish signing in" was pressed twice ~0.25 s apart; the first POST signed in, the second found the link used. **What.** A link that can't be used (`deadLink` in `src/auth.ts`, both GET and POST `/auth/verify`): if the request carries a valid session, 303 to the link's `next` page with no error and no new session (t102u). A real, already-used link without a session 303s once to the new `GET /auth/used?next=…` (behind the age gate, no-store): if the double-click's session cookie has landed by then it continues silently to `next`, otherwise it shows "This link was already used" (links to /account and /signin; grants nothing, no rate-limit hit). Unknown/malformed/expired links keep the generic "isn't valid" page and one bad-verify hit. All "Back to Utah Remedy" links read "Utah Remedy Home". **Deploy.** Commit `3126df5`, worker version `c6f705ff-757f-4885-b5c3-c337984e2cb7`, `npm run deploy` 2026-11-22 11:58 PM MST. **Tests** (UI/auth scope, t94u): typecheck ok; `test-mail-budget.ts` 26/0; `test-auth.py` phase a 80/0 (b+c 18/0); `test-feedback.py` 226/0. **Live:** /signin, /auth/verify, /auth/used redirect to the gate without the age cookie; bogus token -> 400 "isn't valid"; /auth/used without session -> 400 "already used"; signed-out page shows "Utah Remedy Home"; /health commit 3126df5.

## 2026-11-22 — Per-store: empty store list accepted when today's complete sweep says statewide 0 (owner-approved t102u)

**Why.** Nov 22: Eagle Rare 10 (017766), E.H. Taylor Small Batch (021602) and Weller Special Reserve (021986) returned a clean, EMPTY DABS store list while that morning's complete 116-page sweep recorded statewide store qty 0 (warehouse stock only). Fail-closed held them (`missing_store_held`, first day), so the site kept the previous days' store stock.

**Rule (implemented exactly; second narrow exception to fail-closed).** Only when the 2026-11-02 missing-store rule did NOT accept, a per-store list is accepted when ALL hold:
1. DABS returned a clean 200 that parsed (product header/SKU, status, warehouse/on-order found; table or explicit "no stores" text);
2. the list has ZERO store rows (so sum 0 = the cross-checked statewide 0) and the only problem is stores we hold with stock;
3. TODAY's (America/Denver) `sweep_state` row is `complete` with `completed_at`, not `degraded`, and vanish-to-zero not skipped;
4. the product-level `inventory_latest` row has `store_total_qty = 0` (seen at 0 or vanished) and was last written no later than that sweep's `completed_at`.

Then each held store is written qty 0 (observed: `inferred = 0`, no reason, `verified_at` now) with one snapshot row each; `fetch_log.category = 'empty_accepted'` with error text starting `empty-accepted:` and listing the stores; `perstore_missing.outcome = 'empty_accepted'`; `/health → fetcher.perstore.empty_list_accept = "complete_sweep_today_statewide_0"` and `categories.empty_accepted` (excluded from `ok`). A held empty list names why in its error (`empty list not accepted: …`).

**Unchanged.** Everything else stays fail-closed exactly as before: non-empty lists, sum/statewide mismatch (incl. sweep statewide > 0), incomplete/failed/degraded sweep, a sweep only from a prior day, a product row changed after the sweep, parse failures, 5xx/timeouts. The missing-store rule keeps priority. No change to caps, retries (50/day, 3/SKU), pauses, the 429 rule, gaps, windows, ordering or request counts; the check is D1 reads only (zero added DABS requests). No migration.

## 2026-11-23 — Feedback: owner-notice recipient moved to the `NOTIFY_TO` Worker secret (owner-approved public-repo plan, t103u/t105u)
**Why.** Preparing the public GitHub repo: no inbox address should be configured in committed code. **What.** `NOTIFY_TO` was a plaintext var in `wrangler.jsonc` plus a code default in `src/feedback.ts`; both removed. It is now a Worker secret with no default. Missing or invalid: feedback is still stored and the visitor still sees Thanks, but no owner notice is sent (logged `ok=0`, `no NOTIFY_TO secret`), `test-send` answers 503, and the bot list shows `email_today.notify_to_set: false`. `scripts/feedback-bot.sh` defaults its header path to `$HOME/.config/utah-remedy/feedback-bot.header`. **Tests** (feedback scope, t94u): typecheck ok; `test-feedback.py` 234/0 (8 new NOTIFY_TO checks); `test-auth.py` a b c 98/0; `test-mail-budget.ts` 26/0. **Deploy.** Commit `0198832`, `npm run deploy` 2026-11-23 3:21:54 PM MST (worker version `e868f441-1cb2-43c2-b903-35172c3a925a`), then the previous var value (the project inbox) piped on stdin into `wrangler secret put NOTIFY_TO` at 3:22:05 PM MST (secret-change version `5dbcff5f-3e66-4764-bc8a-8334bb6444b6`). No feedback arrived in the ~10 s gap (0 `no NOTIFY_TO` log rows). **Live:** `/health` ok, commit `0198832`; bot list `notify_to_set: true`, intake accepting. No test email sent.

## 2026-11-23 — Code moves to the public GitHub repo DotSlashChris/UtahRemedy (owner-approved t103u/t105u)
**What.** One fresh commit (no old history: old commits carried the owner's personal email as author), author `Utah Remedy <hello@utahremedy.com>`. Scrubbed of personal info (gitleaks + trufflehog clean; value search for owner IP, tokens, owner password, owner emails and home address: 0 hits). Cloudflare account/D1/KV ids kept in `wrangler.jsonc` (not credentials). No license (all rights reserved). New: `db/schema.sql` + `db/reference-data.sql` + `db/build_schema.py` (verified identical to the migrations), `.dev.vars.example`, a public README, `AGENTS.md` and `ai-context/` (this log, the assistant memory export, handoff, routines, plan, watches design) so another AI can pick up the project. **Workflow from now on:** every change goes on a branch and a pull request; after the owner merges, deploy from `main` with `npm run deploy`. Keep `ai-context/` current after every approved change.
