# Utah Remedy: Data Source Inventory

Researched 2026-10-21. All sources below are **public with no login**. Nothing login-gated or private was used or probed (no licensee/vendor portals, no RHDP drawing entry, no special-order form submission). Research traffic was a few dozen requests, spaced about 10 s apart, sent with an identifying User-Agent (`UtahRemedyBot/0.1 (+https://utahremedy.com; …)`).

## Recommendation

**Primary source: the DABS Product Locator** (`webapps2.abc.utah.gov/ProdApps/ProductLocatorCore`). Specifically, these are the JSON/HTML endpoints the locator page itself calls from the browser.

Why:
- **Structured data.** It returns structured JSON for every one of the ~26,340 SKUs (5,456 in stock today): SKU, name/size, category, status code, current price, SPA flag, warehouse qty, statewide store qty, and on-order qty.
- **Store-level detail.** The product detail page lists every store that carries the item, with quantity, address, phone, and lat/lng. Store sums matched the statewide `storeQty` exactly in testing.
- **Official source.** It is DABS's own live inventory tool, so it is the most authoritative and freshest public view.
- **Reachable from Cloudflare.** It responds normally to requests from Cloudflare Workers (tested from production).
- **Same source as existing tools.** It is also what existing independent tools observably use (see below).

**Secondary sources:** the monthly Product List XLSX (#5, **built 2026-10-22**: catalog baseline, see `src/fetchers/catalog-list.ts`) and the allocated-drop list on the Allocated & Rare page (the 3rd-Saturday drop schedule, quantities per store; not built yet).

## Source list

| # | Source | URL | Data | Format | Public / no login | Update frequency (observed/apparent) |
|---|---|---|---|---|---|---|
| 1 | **Product Locator: product table** | `POST https://webapps2.abc.utah.gov/ProdApps/ProductLocatorCore/Products/LoadProductTable` | name (incl. size), SKU (6-digit CSC), displayGroup (category), status (code + label), warehouseQty, storeQty (statewide), onOrderQty, currentPrice, onSpa, newItem, inStock | JSON (DataTables server-side protocol; form-encoded POST; filters: item_code, item_name, category, sub_category, price range, status, in_stock, on_spa, new_items; page size 10/25/50 in UI) | Yes | Appears live or near-live (the detail page and table agree). Exact backend refresh cadence unknown; to be measured via fetch_log diffs. |
| 2 | **Product Locator: product detail (store quantities)** | `GET …/Products/GetDetailUrl?sku=NNNNNN` (sets a `.AspNetCore.Mvc.CookieTempDataProvider` cookie), then `GET …/ProductDetail/Index` with that cookie | Product header (SKU, status, warehouse qty, on-order qty, price) and a table of every carrying store: store #, name, address, city, phone, store qty (including 0), lat/lng (Google Maps link) | HTML (server-rendered table `#storeTable`) | Yes | Same as #1 |
| 3 | Product Locator: helpers | `…/Products/GetItemsForTerm?term=` (autocomplete), `…/Products/GetSubcategories?categoryCode=` | Name suggestions; subcategory list | JSON | Yes | n/a (not needed) |
| 4 | **Allocated & Rare High Demand Products** | https://abs.utah.gov/shop-products/allocatedandrare/ | The allocated drop list for the 3rd Saturday: item name, bottle quantity, bottle price, store address, county (e.g. the list "for sale on October 17, 2026"). RHDP drawing announcements and windows (e.g. a DRC drawing Apr 10–19, 2026). No SKUs; matching is by name. | HTML (WordPress page table) | Yes (drawing *entry* is a form; we don't touch it) | Posted "in the week leading up to the 3rd Saturday"; quantities are initial and "will not be updated as they are sold". |
| 5 | Product Lists (fiscal-period export) | https://abs.utah.gov/shop-products/interactive-product-list/ → e.g. `https://abs.utah.gov/wp-content/uploads/Oct-2026-Product-List-FY27-P3.xlsx` (~950 KB) | One worksheet, header on row 2: CSC (SKU), Description (name + size), Div/Dept/Class codes, Size (ml), Retail Price, Item Status, On Spa, Vendor Name/Cd, Div/Dept/Class names. Class name = the locator's `displayGroup`. **9,994 rows** (Oct 2026), status codes S 5,312 / 1 2,814 / L 1,504 / T 282 / D 69 / X 13: it is the *current fiscal period* list, so allocated (A), unavailable (N/U) and retired SKUs are NOT on it (the locator's 26,340 includes those). No quantities. | XLSX (inline strings) | Yes | Once per DABS fiscal period (about monthly; Oct file Last-Modified 2026-10-01 13:37 UTC) |
| 6 | Monthly Price Books | https://abs.utah.gov/vendors/monthly-price-books/ → e.g. `Oct2026AlphaPriceList.pdf`, `Oct2026NumericPriceList.pdf`, `Oct2026MasterCategoryList.pdf` | Price lists by name, by number, and by category | PDF | Yes | Monthly |
| 7 | Special Orders | https://abs.utah.gov/shop-products/special-orders/ | Program rules: full cases only; no allocated/RHDP; wholesale-available products only; ~45 days after price quote; 14 business days to pick up; prices may change. Submission is a form (not used). | HTML | Yes | Rarely changes (reference content for Concierge) |
| 8 | Find a Store | https://abs.utah.gov/shop-products/find-store/ | Store locations via the WP Store Locator plugin (likely also hours). Not probed beyond the page; we already get store number, address, phone, and lat/lng from #2. | HTML + plugin AJAX (unverified) | Yes | Rarely changes |
| 9 | WordPress REST / sitemap | https://abs.utah.gov/wp-json/, https://abs.utah.gov/wp-sitemap.xml | Page metadata/content (e.g. `wp/v2/pages/<id>` for the allocated page). This could be a cleaner way to read #4 than HTML scraping. Not yet tested. | JSON / XML | Yes | Per page edit |
| 10 | New item listings | e.g. https://abs.utah.gov/vendors/new-item-listings/fall-2026-product-listing/ | Seasonal new listings | HTML/PDF | Yes | Seasonal |

### robots.txt and Terms

- **abs.utah.gov/robots.txt:** `User-agent: * / Disallow:` (everything allowed), **`Crawl-delay: 10`**, plus the sitemap.
- **webapps2.abc.utah.gov/robots.txt:** there is no robots file. The request 302-redirects to the abs.utah.gov homepage. We apply abs.utah.gov's `Crawl-delay: 10` to webapps2 as well.
- **Terms:** abs.utah.gov has no site-specific terms of use that we could find. The statewide Utah.gov Terms of Use / Disclaimer (https://www.utah.gov/support/disclaimer.html) applies. It:
  - provides information "as a public service… on a strictly 'as is' basis";
  - allows anyone to "view, copy, or distribute information found within these web pages… for personal or informational use… if the documents are not modified";
  - says systems are monitored, and the State may act against anyone attempting to "modify, deface, delete, or otherwise tamper with or abuse" a State system;
  - puts disputes under Utah law and Utah courts.
- **There is no language prohibiting automated access.** The practical constraint is not to *abuse* the system: keep the rate low, identify ourselves, and back off on errors. ⚠️ "Personal or informational use… not modified" is the closest thing to a restriction. We transform the data (snapshots, alerts) for an informational service. The owner may want counsel to confirm this, or may ask DABS for a data feed (help desk: dabshelpdesk@utah.gov, 801-977-6939).
- Separately, the Utah UGRC imagery service explicitly bans automated scraping. That is a different agency and service, not DABS, but it shows the State is willing to add such terms, so re-check the DABS/Utah.gov terms periodically.

### How existing independent tools appear to source data (observed only from their public homepages, which we did not scrape)

- **utahdrops.com:** "Updated today at 12:20 PM from DABS, Utah's liquor agency · Independent site". Shows statewide bottle counts ("DABS count today at 12:20 PM"), price drops, and the next allocated drop date. This matches the Product Locator (#1/#2) polled at least daily, plus the allocated page (#4).
- **utahneat.app:** "Data updates daily at midnight." Shows per-store unit totals and "Most Active Today: inferred from inventory changes — DABS doesn't report sales." This matches a nightly Product Locator snapshot with day-over-day diffs.

## Proposed polite polling cadence (requires owner approval before any Cron is enabled)

Ground rules apply to every cadence below:
- ≥ 10 s between requests (single worker, serialized) and ≤ 12 requests per invocation.
- 1 h backoff on 429/5xx; stop the run at the first failure. *(Superseded for the nightly sweep: transient 5xx/timeouts are retried in the window, 3 retries/page, then a 30 min rest per page and one more try per rest (2026-10-28), ≤ 40 retry requests/day since 2026-10-29 (was 20); see README and ai-context/DECISIONS.md. Per-store since 2026-10-30: transient 5xx/timeouts are requeued (≥ 15 min, 3/SKU, 50/day since 2026-11-10, was 40), 3 in a row → 15 min pause; 429/other 5xx still 1 h.)*
- 30 min KV cache, and identifying User-Agent.
- Target well under ~1,000 requests/day on normal days.

| Job | Normal cadence | Drop window cadence | Requests |
|---|---|---|---|
| **In-stock catalog sweep** (#1, `in_stock=true`, 50/page) | **Live:** maintenance window 07:30–10:55 UTC (01:30–04:55 MDT / 00:30–03:55 MST), crons `30-55/5 7 * * *` + `*/5 8-10 * * *`; ~10 ticks needed, resumes from the D1 cursor, hard stop 10:55 UTC | same | ~110/day |
| **Allocated/limited watchlist** (#1, by status A/L/P and watched SKUs) | Every 2 h, 08:00–20:00 | Every 15 min, 07:00–14:00 on the 3rd Saturday | ~10–50/run |
| **Store-level detail** (#2) | Only for watched SKUs and allocated items whose statewide qty changed; cap ~100 SKUs/day (2 req each) | On the 3rd Saturday, every 15 min for that drop's allocated SKUs (~10–20 SKUs, ≤ 40 req per cycle, which fits at 10 s spacing) | ≤ 200/day normal, ≤ ~1,500 on drop day |
| **Allocated list page** (#4) | Daily | Hourly, Mon–Fri of the week before the 3rd Saturday (to catch the posting) | 1–24/day |
| **Product list XLSX** (#5) | **Live (cron path paused since 2026-11-03, KV `catalog:v1:auto`):** cron `30 18 2-8 * *` = 18:30 UTC (`30 9 2-8 * *` until 2026-10-26, `30 13 2-8 * *` until 2026-10-27, `30 14 2-8 * *` until 2026-11-01, `30 16 2-8 * *` until 2026-11-03); page + file once per new list | n/a | 2/month (page + XLSX), +1 page check per day until a new list is posted |
| Price books (#6), special-order rules (#7) | Monthly checks for changes (reference only) | n/a | a few/month |

The next allocated drop is the 3rd Saturday of November 2026: **Sat Nov 21, 2026**.

## Known quirks

- The detail page relies on a short-lived TempData cookie set by `GetDetailUrl`. The fetcher confirms the SKU on the page matches the requested one, failing closed on a mismatch.
- The detail page lists every store that carries the item, **including qty 0**. Example: 018006 Buffalo Trace showed 51 stores, 5 of them with stock, summing to 40, which equals the table's `storeQty`.
- Some stores are not open to the public. Example: "STATE STORE #34 (Club store for licensed operations only)". The UI must flag or filter these.
- Product names include the size (`… 750ml`), with irregular spacing. The size is parsed into `size_ml`.
- The allocated page has no SKUs, so name matching will be needed. Its quantities are starting quantities only.
