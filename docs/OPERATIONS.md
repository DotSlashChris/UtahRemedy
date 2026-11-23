# Utah Remedy

Utah-only, independent web service for tracking Utah DABS liquor availability.
**Phase 0 (foundation)** plus the **data-source prototype:** a single Cloudflare Worker with static assets, a 21+ age gate, a persistent disclaimer, draft legal pages, the D1 schema, a KV namespace, `/health`, and one fetcher for the DABS Product Locator.
**Option B is live:** a nightly in-stock sweep runs in a **maintenance window** on the crons `30-55/5 7 * * *` + `*/5 8-10 * * *` (07:30–10:55 UTC = 01:30–04:55 MDT now / 00:30–03:55 MST after Nov 1; 42 ticks, hard stop at the 10:55 UTC tick; `*/5 8 * * *` until 2026-10-26, `*/5 9 * * *` until 2026-10-27), protected by hard caps. It resumes page by page across ticks and pauses, and once the day's sweep is `complete` or `failed` every later tick is a no-op (no second sweep the same day). Ticks that can't send anything (pause/backoff, or only retries that aren't due yet) don't charge a run. **Transient 5xx on a sweep page (500, 502–504, 520–527) and our own 20 s request timeout (`TimeoutError`) are retried later in the same window** (≥ 5 min delay, 3 retries per page; since 2026-10-28 a page that used its 3 retries **rests 30 min and is re-queued** for one more try, again after every further rest until the 10:55 UTC hard stop, while the other pages carry on; max 40 retry requests/day shared by all of them (20 until 2026-10-29; reaching it = sweep failed), 3 distinct pages in a row with any mix of the two = 15 min pause, after which the streak restarts and queued retries continue (was 1 h until 2026-10-26); 429 (still 1 h backoff) and other errors, including non-timeout network errors such as dropped/refused connections or DNS/TLS, unchanged = sweep failed). The sweep is only `complete` when every page succeeded; if it is still unfinished at the 10:55 UTC tick (retries pending, paused, or otherwise incomplete) it is closed `failed` (fail-closed, no vanish-to-zero, no freshness advance). See `docs/DATA-SOURCES.md` and `docs/COST-PROJECTION.md`.
**Full-catalog import is live:** the DABS monthly Product List XLSX is imported on the cron `30 18 2-8 * *` (18:30 UTC = 11:30 MST / 12:30 MDT, days 2–8, after the per-store window; 09:30 UTC until 2026-10-26, 13:30 UTC until 2026-10-27, 14:30 UTC until 2026-11-01, 16:30 UTC until 2026-11-03, so it never collides with the sweep or per-store windows; no-op once the month is done). Catalog-only products are searchable with name, status and category but **no quantities** (shown as unknown). Same caps, kill switch, lock and fetch_log as the sweep.
**Per-store refresh is live (B1 + popular-100):** once daily, after the sweep has completed, the cron `*/5 11-17 * * *` (11:00–17:55 UTC = 04:00–10:55 MST / 05:00–11:55 MDT, 84 ticks, last tick 17:55 UTC; `*/5 10-12 * * *` until 2026-10-27, `*/5 11-13 * * *` (11:00–13:55 UTC) until 2026-11-01, `*/5 11-15 * * *` (11:00–15:55 UTC) until 2026-11-03, widened so pauses/retries have more time, caps unchanged) refreshes per-store counts, first for status-A (allocated) SKUs with any stock (B1, ≤ 60 SKUs, ~43 today), then for the owner-approved popular-100 list (D1 `perstore_popular`, ≤ 100 SKUs including admin locks; SKUs already in B1 and items with 0 statewide store qty are skipped). 2 requests per SKU; no SKU starts once the day's DABS requests (sweep included) would pass min(500, the day cap). Popular is skipped on 3rd-Saturday drop days and can be turned off without a deploy (KV `perstore:v1:popular`, see below). It is fail-closed: an incomplete or invalid store list writes nothing. **One narrow, owner-approved exception (2026-11-02, `missing_store_accept = prev_day_same_stores`):** a store list is accepted when DABS answered a clean 200 that parsed, no store appears twice, the quantities add up exactly to today's sweep statewide count, the only problem is that stores we hold with stock are absent, and every one of those absent stores was also in the absent set recorded for that SKU on the previous Utah (America/Denver) day (a superset is fine; D1 `perstore_missing`, one row per SKU per Utah day). Then the listed stores are written normally and each absent store is recorded as qty 0 with `inferred = 1` and an `inferred_reason`; the product page says how many stores are inferred out of stock. A store absent for the first time, any total mismatch, duplicates or parse problems still write nothing, zero nothing and advance no freshness, and incomplete answers are still never retried (no added requests). Unchanged re-checks advance `inventory_latest.verified_at`, and the UI uses that for the 36 h freshness rule. **Transient 5xx (e.g. a single 522) and, since 2026-10-30, our own 20 s request timeout (`TimeoutError`) are retried later in the same window** (15 min delay, max 3 retries per SKU/day, max 50 retry requests/day (40 until 2026-11-10), 3 distinct SKUs in a row failing with any mix of the two = 15 min pause, after which the streak restarts and queued retries continue (1 h until 2026-10-30, same as the sweep now); 429, non-timeout network errors and other hard errors unchanged (1 h backoff / fail the SKU); the day's total stays under min(500, cap)). Since 2026-10-30, per-store ticks that only sit out a pause/backoff or only wait for retries that aren't due yet don't charge a run (same as the sweep); ticks that send requests still do. **Since 2026-10-31 retries no longer go first:** while fresh (not yet tried) SKUs remain, at most one due retry is worked between two fresh SKUs, and the first SKU after a pause is fresh, so a few SKUs that keep failing can't re-trigger the pause back to back with no fresh progress; once the queue is done, due retries run as before (only the order changed, no limit changed). **Since 2026-11-03 (re-pause rule, `/health` `limits.repause_rule = first_transient_after_pause`):** after a 15 min streak pause the first request is a probe; if it fails with a 522/5xx/timeout another 15 min pause starts at once instead of spending two more failures, and the failed probe counts like any transient failure (requeued with the SKU's retry count +1, or failed for the day after 3 retries). A probe that succeeds, or any non-transient answer, returns to normal running; a 429 still gives the 1 h backoff. No limit changed. **Since 2026-11-04 (popular order, `/health` `fetcher.perstore.popular_order = stalest_first`):** the popular part of the frozen daily queue is ordered by each bottle's last good per-store update (newest `fetch_log` row of kind `perstore_detail` with status `ok`, which includes `missing_store_accepted_inferred`), oldest first; bottles never updated go first of all; ties go to higher statewide quantity, then SKU. Which bottles are on the list (locks, ranks, B1 dedup, zero-qty skip) is unchanged; only the order changed. B1 is unchanged and still first. No limit, rule, schedule or cron changed. **Since 2026-11-05 (popular auto-prune, `/health` `fetcher.perstore.popular.auto_prune_rule = all_public_stores`):** unlocked popular bottles with stock in every open-to-the-public DABS store (club stores excluded; locked rows never) are removed from `perstore_popular` automatically when the daily queue is built. Caps, windows, B1, `stalest_first`, missing-store rule, and catalog pause are unchanged. Run rows now always finish (`complete`, `capped`, `failed`, `window_ended`, `expired`). Limited-item (all-L) refreshes (B2) are **off and not implemented** (`PERSTORE_REFRESH` accepts only `allocated`).
**Same-day sweep catch-up is live (2026-11-13, owner-approved):** if the nightly sweep's 10:55 UTC hard stop closes it `failed` with `window_ended` (pages never tried and/or still waiting for a retry), the same UPDATE sets `sweep_state.catchup_status = 'queued'`. The cron `*/5 20-22 * * *` (20:00–22:55 UTC = **1:00–3:55 PM MST** / 2:00–4:55 PM MDT, 36 ticks, hard stop at the 22:55 UTC tick) then reopens that same day's row and runs the normal sweep code on the **unfinished pages only** (the cursor continues at `next_start` plus the pending retries; never a second full sweep). Same-day counters continue (40 sweep retry requests, 60 runs, daily DABS requests); 10 s gap, 3 retries/page + 30 min rest, 15 min streak pause and re-pause, 429 = 1 h, fail-closed validation and vanish-to-zero (only on a complete sweep) are all unchanged. It starts only if today's requests + unfinished pages fit **min(500, day cap)** and, with retries pending, the 40 cap has room; otherwise `skipped`. No sweep request starts past min(500, cap). Not queued: `retry_limit`, 429, other hard HTTP/network errors, bad shape, count collapse (fail closed, owner decides), or a day with no successful page (would be a full sweep). If the catch-up sweep completes and today's per-store row is `skipped` (sweep wasn't complete at 4 AM) and requests + 2 still fit the 500 ceiling, **one** normal per-store pass follows in the same window (same queue rules, 50 retry requests, missing-store rule, 500 ceiling; closes `window_ended` at 22:55 UTC). Every other tick is a one-row read (no lock, no run, no request). `/health → fetcher.sweep_catchup` shows `today` and `previous_day` (the daily status runs ~11:15 AM MT, before the window, so it reports the previous day's catch-up). Manual (same code path): `{"catchupTick":true}` on `/internal/fetch/dabs`. Code: `src/fetchers/catchup.ts`; migration `0013_sweep_catchup.sql`.
**All DABS windows are pinned to America/Denver local time (2026-11-13, owner-approved t80u; `src/schedule.ts`).** Cloudflare Cron Triggers are UTC-only, so each window's cron covers the union of its MST and MDT UTC hours, and `scheduled()` runs a job only when the tick's `scheduledTime`, read in America/Denver with `Intl` (no hardcoded offsets), is inside the local window. Any other tick returns immediately: no D1/KV access, no lock, no run charged, no DABS request. Local windows, all year: **sweep 12:30–3:55 AM** (hard stop at the 3:55 AM tick), **per-store 4:00–10:55 AM** (hard stop 10:55 AM), **catalog 11:30 AM on days 2–8** (still paused unless KV `catalog:v1:auto` = `on`), **catch-up 1:00–3:55 PM** (hard stop 3:55 PM). Crons: `30-55/5 6 * * *` + `*/5 7-10 * * *` (sweep, 06:30–10:55 UTC), `*/5 10-17 * * *` (per-store), `30 17,18 2-8 * *` (catalog), `*/5 19-22 * * *` (catch-up). The local windows don't overlap, so where two expressions fire in the same UTC minute (10:xx UTC; 17:30 UTC on days 2–8) only one acts. In MST the acting ticks are exactly the old UTC schedule's ticks; in MDT they are one UTC hour earlier. DST nights: on spring-forward (e.g. 2027-03-14) local 2:00–2:59 doesn't exist, so the sweep gets 30 ticks (12:30–1:55 MST, 3:00–3:55 MDT) instead of 42; on fall-back (e.g. 2027-11-07) local 1:00–1:55 occurs twice, so the sweep gets 54 ticks, all on the same Utah day and `sweep_state` row, with the hard stop once at 3:55 MST. Caps (60 runs, 40/50 retries, 500 ceiling) are unchanged on those nights. About 36 extra no-op invocations a day (37 on days 2–8). `/health → fetcher.local_schedule` shows each window, its UTC crons and its next local opening. UTC times in older paragraphs below describe the MST equivalents. Tests: `node --experimental-strip-types scripts/test-schedule-dst.ts` (pure logic, Jan/Jul/Mar 14 2027/Nov 7 2027 and every day through 2027) and `python3 scripts/test-sweep-retry.py t19_local_time_gate`.

### Kill switch (stops ALL DABS fetching within ~60 s, no deploy needed)

```bash
npx wrangler kv key put --binding UTAH_REMEDY_CACHE dabs:v1:kill 1 --remote
# undo:  npx wrangler kv key delete --binding UTAH_REMEDY_CACHE dabs:v1:kill --remote
```

For a hard stop at deploy time, set `"FETCHER_ENABLED": "false"` in `wrangler.jsonc` and run `npm run deploy`. `/health` → `fetcher` shows `enabled`, `kill_switch`, lock state, today's budget usage, and the last sweep (including `retried`, `recovered`, `retry_requests`, `transient_errors`, `retries_pending`, `retry_limits`, and since 2026-10-28 `rest_cycles`, `pages_resting` and `failed_pages`: per failed page start, `fails`, `rests`, `last_status`, `last_ms`, `max_ms`, last 8 response times `ms`). Each sweep page's DABS response time is also in `fetch_log.response_ms` (kind `sweep_page`; send → response/error, excluding the 10 s gap).

Live: https://utahremedy.com (www redirects to apex). The workers.dev address and preview URLs are disabled.

**Beta pages (21+ gated):** `/search`, `/product/:sku`, `/stores`, `/stores/:id`, plus JSON at `/api/search`, `/api/product/:sku`, `/api/stores`, `/api/stores/:id`.
- **Data source:** served from D1 only, with the Cache API in front. Never from DABS.
- **Freshness:** every count carries an America/Denver "as of" time. Stale (>36 h) or missing data is labeled unknown, never shown as zero.
- **Details:** ai-context/DECISIONS.md, "Beta phase 2".

## Node

This project needs **Node 22+** (current wrangler requires it). The box's system `/usr/bin/node` is v20 and is shared with other projects, so **don't replace it**. Node 22 is installed user-scoped via nvm at `~/.nvm`.

```bash
unset NPM_CONFIG_PREFIX            # box env sets this; nvm refuses to run with it
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm use   # reads .nvmrc (22)
npm ci
```

(nvm warns about `prefix`/`globalconfig` in `~/.npmrc`. That's harmless for local project installs. Don't edit the shared `~/.npmrc`.)

`wrangler` is pinned as a devDependency (exact version in `package.json`). Always use `npx wrangler`, never a global install.

## Commands

| Task | Command |
|---|---|
| Local dev (http://localhost:8787) | `npm run db:migrate:local && npm run dev` |
| Type-check | `npm run typecheck` |
| Deploy (stamps git short SHA into `/health`) | `npm run deploy` |
| Apply D1 migrations remotely | `npm run db:migrate:remote` |
| Tail logs | `npx wrangler tail utah-remedy` |

Commit before deploying so `/health.commit` matches the deployed code. Wrangler auth is the OAuth login in `~/.config/.wrangler/config/default.toml` (account `ca827b3a832159e95f29d5d1d14e9b79`, Quazar16 LLC).

## Bindings (wrangler.jsonc)

| Binding | Type | Resource |
|---|---|---|
| `ASSETS` | Static assets | `./public` (`run_worker_first`: Worker first on `/*` except exact static files `/assets/style.css`, `/favicon.svg`, `/robots.txt`; checked by `scripts/check-assets.sh`) |
| `DB` | D1 | `utah-remedy-db` (`f091ef43-8380-41c7-937c-b1168027c392`) |
| `UTAH_REMEDY_CACHE` | KV | `a7e009a216034c4e8b194af12e60b473` (also holds the daily analytics salt `analytics:v1:salt:<day>`) |
| `EVENTS` | Analytics Engine | dataset `utah_remedy_events`: anonymous `gate_pass` / `visit` events (see ai-context/DECISIONS.md 2026-10-25) |
| `CF_ANALYTICS_TOKEN` | secret | Account Analytics Read token, used only by `GET /internal/stats` |
| `APP_VERSION` | var | `0.1.0` |
| `GIT_COMMIT` | var | set at deploy via `--var` |
| `ADMIN_TOKEN` | secret | `wrangler secret put ADMIN_TOKEN`; box copy at `~/.config/utah-remedy/admin-token` (0600, not in git) |
| `FETCHER_ENABLED` | var | `"true"` in production. Anything else disables cron and admin fetching |
| `DABS_BASE_URL`, `DABS_TEST_MIN_GAP_MS`, `DABS_TEST_LOCK_TTL_MS` (also `DABS_TEST_SWEEP_PAUSE_MS` etc. for tests) | vars (local only) | `.dev.vars` only, for the mock. The test overrides are ignored unless `DABS_BASE_URL` points away from the real DABS host. Never set in production. |
| `PERSTORE_REFRESH` | var | `"allocated"` enables B1. Anything else turns per-store refresh off. There is no setting for limited (B2) |
| Cron | trigger | Pinned to America/Denver since 2026-11-13: `30-55/5 6 * * *` + `*/5 7-10 * * *` (sweep, acts 12:30–3:55 AM local), `*/5 10-17 * * *` (per-store B1 + popular-100, acts 4:00–10:55 AM local), `30 17,18 2-8 * *` (monthly catalog, acts 11:30 AM local on days 2–8; cron path paused unless KV `catalog:v1:auto` = `on`) and `*/5 19-22 * * *` (same-day catch-up, acts 1:00–3:55 PM local). Ticks outside the local window are no-ops (`src/schedule.ts`). They must match `EXPECTED_CRONS` in `src/index.ts`; any other expression is rejected and logged |
| `DABS_CATALOG_URL` | var (local only) | `.dev.vars` only: product-list page URL for local tests; ignored unless `DABS_BASE_URL` points away from DABS |
| Limits | platform | `cpu_ms: 5000`, `subrequests: 300` |

Routes: custom domains `utahremedy.com` and `www.utahremedy.com`.

## Layout

```
src/index.ts                     Worker: gate, www->apex, disclaimer injection, /health, /internal/fetch/dabs, security headers
src/fetchers/dabs-locator.ts     DABS Product Locator fetcher (parsers, validation, polite budgeted client, admin run)
src/fetchers/guard.ts            Hard caps: kill switch, D1 daily budget, single-run lock, Mountain-time day helpers
src/fetchers/store.ts            D1 writes with change detection (inventory_latest), fetch_log helpers
src/fetchers/sweep.ts            Nightly in-stock sweep (cursor, overlap, drift checks, vanish-to-zero)
src/fetchers/perstore.ts         Daily per-store refresh: B1 allocated SKUs, then popular-100 (after the sweep; fail-closed)
src/fetchers/catchup.ts          Same-day catch-up of an incomplete nightly sweep (unfinished pages only) + optional one per-store pass, 1:00-3:55 PM America/Denver
src/schedule.ts                  America/Denver local windows, scheduled() gate, local hard stops, /health next-open (2026-11-13)
src/fetchers/popular.ts          Popular-100 roster: active-list selection, KV on/off flag, admin lock/unlock/add/remove
src/fetchers/catalog-list.ts     Monthly DABS Product List XLSX import (zip/sheet parser, validation, KV stage, chunked change-only apply)
src/web/catalog.ts               Read-only catalog queries, freshness classification, DABS status words, type mapping helpers
src/web/pages.ts                 Server-rendered search / product / store HTML (no client JS)
src/web/router.ts                Catalog routes + JSON API, Cache API caching, rate limiting
src/analytics.ts                 Anonymous visit counting (daily-salted hash -> Analytics Engine) + /internal/stats queries
scripts/seed-catalog.py          Synthetic catalog for LOCAL search tests (never --remote)
scripts/mock-state.py            Builds/modifies the mock catalog state for tests
scripts/cost-model.py            Usage/cost model (pre-fix projection)
scripts/mock-dabs.py             Local mock DABS server for fail-closed tests
docs/DATA-SOURCES.md             Data source inventory, robots/ToS, cadence
public/                          Static pages (index, gate, not-eligible, terms, privacy, disclaimer, 404) + assets/style.css
migrations/0001_initial_schema.sql   D1 schema skeleton
migrations/0002_fetch_log_and_locator_fields.sql   fetch_log + locator fields
migrations/0003_caps_latest_sweep.sql   inventory_latest, fetch_budget, fetch_lock, sweep_state; rebuilt snapshots/fetch_log
migrations/0004_search.sql   product_search (FTS5) + triggers, product_search_source view (type mapping), idx_latest_store
migrations/0005_catalog_import.sql   products.data_source ('catalog' = list-only), catalog_import (monthly cursor/state)
migrations/0006_perstore_verified.sql   inventory_latest.verified_at, perstore_state (daily B1 queue)
migrations/0007_perstore_popular.sql   perstore_popular (seed 100 + 016850 locked, delete-guard trigger), perstore_state b1_total/popular_total/popular_note
migrations/0008_perstore_retry.sql   perstore_state retry/skipped columns (transient-5xx retries, window_ended/expired statuses)
migrations/0009_sweep_retry.sql   sweep_state retry_json/retried/recovered/retry_requests/transient_errors (sweep transient-5xx retries)
migrations/0010_sweep_rest.sql   sweep_state rest_cycles/page_failures_json, fetch_log.response_ms (30 min page rest, failed-page response times)
migrations/0011_perstore_missing.sql   perstore_missing (absent-store set per SKU per Utah day), inventory_latest.inferred_reason, perstore_state category counters, fetch_log.category (2026-11-02)
scripts/test-perstore-retry.py   simulated retry tests (local mock, no real DABS requests): python3 scripts/test-perstore-retry.py
scripts/test-analytics.py   local analytics test (events emitted, nothing identifying stored): python3 scripts/test-analytics.py
scripts/test-sweep-retry.py   simulated sweep 5xx/timeout retry tests (local mock, no real DABS requests): python3 scripts/test-sweep-retry.py
wrangler.jsonc                   Worker config + bindings
ai-context/DECISIONS.md                     Decisions, resource IDs, open items
ai-context/plan/                       Project description, plan, design outline
```

## Routes

- `/health`: JSON `{ ok, service, version, commit, timestamp, d1, kv, data_sources }`, not gated, returns 503 if D1 or KV is down. `data_sources["dabs-locator"]` shows `last_ok_at` and `stale`.
- `/internal/fetch/dabs`: POST only, `Authorization: Bearer $ADMIN_TOKEN`. Anything else gets 404. Body is `{"queries":[...],"storeDetailSkus":[...]}`, `{"sweepTick":true}` (same code path as the sweep cron tick) or `{"perstoreTick":true}` (same code path as the per-store B1 + popular cron tick; optional `"maxSkus":1|2` caps a manual run; this creates/advances that MT day's queue) or `{"catchupTick":true}` (same code path as the 1:00–3:55 PM America/Denver catch-up cron tick; acts only when today's sweep row is `queued`/`running` for catch-up; never the hard-stop tick) or `{"catalogImport":true}` (same code path as the monthly catalog tick; add `"force":true` to skip only the once-per-day/attempt gating). It is subject to the same kill switch, lock, and budget as cron.
- `/internal/popular` (GET) and `/internal/popular/{lock,unlock,add,remove,flag}` (POST): popular-100 admin, `Authorization: Bearer $ADMIN_TOKEN`, 404 otherwise. D1/KV only, never DABS. See "Popular-100 admin" below.
- `/internal/stats` (GET): anonymous visitor stats from Analytics Engine, `Authorization: Bearer $ADMIN_TOKEN`, 404 otherwise. Returns `totals`, `daily` (last 30 Utah days: `unique_visitors`, `page_views`, `gate_passes`, `sampled`) and `top_products_7d` (top 20 SKUs by views). AE ingest lags up to a few minutes. Example: `curl -s -H "Authorization: Bearer $(cat ~/.config/utah-remedy/admin-token)" https://utahremedy.com/internal/stats`
- `/gate` (GET form / POST submit), `/not-eligible`, `/terms`, `/privacy`, `/disclaimer`: not gated.
- `/feedback` (GET form / POST submit): public feedback form, not gated, never counted. `/__ur/feedback…` and `/__ur/admin`: feedback bot endpoints and admin page (header `X-UR-Feedback-Token`; 404 if the secret is unset). See "Feedback triage" below and ai-context/DECISIONS.md 2026-11-12.
- `/tip` (age-gated): optional "Tip the dev" page with Cash App and Venmo links and QR codes, rendered when `CASHAPP_HANDLE` and/or `VENMO_HANDLE` are set. A compact tip section is also injected at the bottom of public pages, plus a header-nav link. See ai-context/DECISIONS.md 2026-11-16.
- Everything else requires the `ur_age21=1` cookie, otherwise it redirects 302 to `/gate?next=…`.

## Running the DABS fetcher manually

Keep it small: at most 5 queries and 3 store-detail SKUs per run, ≥ 10 s between requests. A run of about 6 requests takes about 1 minute.

```bash
T=$(cat ~/.config/utah-remedy/admin-token)
curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"queries":[{"sku":"018006"},{"itemName":"blanton","length":10}],"storeDetailSkus":["018006"]}' \
  https://utahremedy.com/internal/fetch/dabs
# optional: "force": true bypasses the 30-min KV cache
npx wrangler d1 execute utah-remedy-db --remote --command "SELECT * FROM fetch_log ORDER BY id DESC LIMIT 10"
```

### Popular-100 admin (list, locks, on/off)

The token is read into a variable and never printed. List edits apply from the **next** day's queue (today's queue is frozen at its first tick). Locked entries always stay in the active 100, count toward it (the lowest-ranked unlocked entry drops to reserve), can't be removed (a D1 trigger blocks deleting a locked row) and must be skipped by any future rotation. A locked SKU already in that day's B1 queue isn't fetched twice; a locked SKU with 0 statewide store qty is skipped that day but stays locked. SKUs are validated against `products`.

```bash
T=$(cat ~/.config/utah-remedy/admin-token)
H=(-H "Authorization: Bearer $T" -H 'Content-Type: application/json')
curl -s "${H[@]}" https://utahremedy.com/internal/popular | python3 -m json.tool | head -40   # flag, counts, active[], reserve[]
curl -s "${H[@]}" -X POST -d '{"sku":"016850","note":"why"}' https://utahremedy.com/internal/popular/lock     # adds it if not listed
curl -s "${H[@]}" -X POST -d '{"sku":"016850"}' https://utahremedy.com/internal/popular/unlock
curl -s "${H[@]}" -X POST -d '{"sku":"018006","rank":50}' https://utahremedy.com/internal/popular/add      # rank optional (default: last)
curl -s "${H[@]}" -X POST -d '{"sku":"018006"}' https://utahremedy.com/internal/popular/remove             # 409 if locked
curl -s "${H[@]}" -X POST -d '{"popular":"off"}' https://utahremedy.com/internal/popular/flag              # or "on"
unset T H
```
On/off without the endpoint: `npx wrangler kv key put --binding UTAH_REMEDY_CACHE perstore:v1:popular off --remote` (`on` to enable; a missing key means off). The flag is read on every tick, so "off" mid-run stops after the B1 part. The kill switch above still stops everything.

Status: `/health → fetcher.perstore` (limits, `popular.flag`, entries/active/locked, `last_run` with `b1_total`/`popular_total`/`popular_note`/`skipped`/`retried`/`recovered`/`retry_requests`/`transient_errors`; limits include `retry_max_per_sku`, `retry_request_limit_per_day`, `retry_delay_min`, `streak_pause`, `streak_pause_min` = 15, `timeout_retryable` = true, `paused_or_waiting_ticks_charge_run` = false, `retry_order` = `fresh_first_max1_interleave`). Per-SKU rows in `fetch_log` (kind `perstore_detail`) carry `query = 'sku=NNNNNN;list=b1|popular'`. Since 2026-11-02 `fetcher.perstore.missing_store_accept` = `prev_day_same_stores`, and `fetcher.perstore.categories` gives the latest Utah day's counters for the daily status: `ok` (clean lists), `accepted_inferred` (+ `inferred_stores`), `held_first_day_missing`, `qty_mismatch` (`_above` / `_below`), `dup_parse`, `transient_exhausted_522_timeout` (522/5xx/timeout retries used up), `retry_cap_dropped` (pending retries dropped by the 50/day retry cap), `other_failed`, `skipped`. The same categories are in `fetch_log.category` (`ok`, `missing_store_accepted_inferred`, `missing_store_held`, `qty_mismatch_above`, `qty_mismatch_below`, `duplicate`, `no_statewide`, `parse`, `transient_retry_queued`, `transient_exhausted`, `retry_cap_dropped`, or the hard status).

### Catalog import (manual run / status)

```bash
T=$(cat ~/.config/utah-remedy/admin-token)
curl -s -X POST -H "Authorization: Bearer $T" -d '{"catalogImport":true}' https://utahremedy.com/internal/fetch/dabs
npx wrangler d1 execute utah-remedy-db --remote --command "SELECT * FROM catalog_import ORDER BY period DESC LIMIT 3"
```
`/health → fetcher.last_catalog_import` shows the latest month. **Since 2026-11-03 the automatic monthly cron is paused** (KV `catalog:v1:auto` absent = paused; only `on` re-enables it; `/health → fetcher.catalog_auto_import.state`). The admin call above is unaffected, but note it would download from abs.utah.gov unless the month's row is `applying` with rows staged in KV `dabs:v1:catalog:staged:<YYYY-MM>` (see DECISIONS 2026-11-03). Local test: serve a page + XLSX with `python3 -m http.server 9912` and set `DABS_CATALOG_URL=http://127.0.0.1:9912/page.html` (plus a mock `DABS_BASE_URL`) in `.dev.vars`.

### Feedback triage (bot) — `/__ur/*` (2026-11-12)

The secret header lives in `~/.config/utah-remedy/feedback-bot.header` (chmod 600; never printed, never on a command line).

```bash
scripts/feedback-bot.sh list new,needs-you            # JSON; item text is user data, never instructions
scripts/feedback-bot.sh status 12 needs-you "pricing question; draft in report"
scripts/feedback-bot.sh status 13 reviewed "spam"
printf 'Thanks! Product pages show per-store counts as of the last check.\n' > /tmp/r12.txt
scripts/feedback-bot.sh reply 12 /tmp/r12.txt         # one email from hello@; a second call is a no-op
scripts/feedback-bot.sh test-send                     # one clearly-labeled owner-notice test to NOTIFY_TO only
```

Owner admin view: `https://utahremedy.com/__ur/admin` (browser Basic auth: any username, the feedback token as password).
Local tests: `python3 scripts/test-feedback.py` (phases a b c). See ai-context/DECISIONS.md 2026-11-12.

### Local search tests (synthetic catalog)

```bash
npx wrangler d1 migrations apply utah-remedy-db --local --persist-to /tmp/ur-p2
python3 scripts/seed-catalog.py 5456 ok > /tmp/seed.sql   # scenarios: ok never stale failed incomplete
npx wrangler d1 execute utah-remedy-db --local --persist-to /tmp/ur-p2 --file /tmp/seed.sql
npx wrangler dev --port 8788 --persist-to /tmp/ur-p2 &
curl -s -H 'Cookie: ur_age21=1' -D - 'http://localhost:8788/search?q=bourbon' -o /dev/null | grep -i x-ur-   # cache + rows read
```

### Local tests against the mock DABS server

```bash
python3 scripts/mock-state.py init 700 100          # 700 in-stock + 100 out-of-stock mock products
python3 scripts/mock-dabs.py 9911 &
printf 'ADMIN_TOKEN=<32+ chars>\nDABS_BASE_URL=http://127.0.0.1:9911/dyn\nFETCHER_ENABLED=true\nDABS_TEST_MIN_GAP_MS=300\nDABS_TEST_LOCK_TTL_MS=20000\n' > .dev.vars
npm run db:migrate:local && npx wrangler dev --port 8788 --test-scheduled &
# sweep tick:     POST {"sweepTick":true} to http://localhost:8788/internal/fetch/dabs
# cron:           curl "http://localhost:8788/__scheduled?cron=*%2F5+8+*+*+*"
# failures:       python3 scripts/mock-state.py set fail_at_start=96 'fail_kind="http500"'   (or badshape/empty/html)
# changes:        python3 scripts/mock-state.py change 30 ; python3 scripts/mock-state.py vanish 10
# drift / short:  python3 scripts/mock-state.py set drift_after=3 drift_remove=5 ; ... set short_page_at=192
# scenarios:      python3 scripts/mock-state.py set 'scenario="allzero"'   (good allzero badshape empty html http500 skumismatch)
```
