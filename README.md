# Utah Remedy

Where to find hard-to-find bottles in Utah. Live site: https://utahremedy.com

Utah Remedy tracks bottle availability at Utah Department of Alcoholic Beverage Services (DABS) stores from public DABS data and shows it behind a 21+ age gate. It is an independent service, not affiliated with or endorsed by DABS. Counts can lag and aren't guaranteed.

This repository is the full application: one Cloudflare Worker with static assets, D1, KV and Analytics Engine. It does **not** contain secrets, production data, user accounts, feedback, analytics or fetch logs.

## Architecture

- **Worker `utah-remedy`** (`src/index.ts`): custom domains `utahremedy.com` and `www.utahremedy.com`. 21+ gate, DABS disclaimer injection, security headers, server-rendered search / product / store pages (`src/web/`), feedback form, email magic-link sign-in (`src/auth.ts`), tip page, `/health`, and token-guarded admin endpoints.
- **Fetchers** (`src/fetchers/`): a polite, budgeted DABS Product Locator client. Nightly in-stock sweep, daily per-store refresh (allocated SKUs + an owner-curated popular-100 list), same-day catch-up of an incomplete sweep, and a monthly catalog import (paused unless KV `catalog:v1:auto` = `on`).
- **Fail closed.** Incomplete, invalid or mismatched DABS answers write nothing and keep the last good data (labeled with its "as of" time; stale data is shown as unknown, never as zero). Narrow, documented exceptions are in `ai-context/DECISIONS.md` (missing-store rule, empty list at statewide 0).
- **Hard caps.** Worst case at or under 500 combined DABS requests per day, single-run lock, kill switch (KV `dabs:v1:kill` = `1`), fixed gaps, pauses and 429 backoff. Changing caps, gaps, pauses, the 429 rule, fail-closed behavior or windows is an owner decision.

### Bindings (`wrangler.jsonc`)

| Binding | Type | Resource |
|---|---|---|
| `ASSETS` | Static assets | `./public` (Worker runs first except the exact static files listed; checked by `scripts/check-assets.sh`) |
| `DB` | D1 | `utah-remedy-db` |
| `UTAH_REMEDY_CACHE` | KV | cache, run state, flags, daily analytics salt |
| `EVENTS` | Analytics Engine | dataset `utah_remedy_events` (anonymous, daily-salted visitor hashes; IPs never stored) |
| `EMAIL` | Email Sending | sender `hello@utahremedy.com` only |
| `SEARCH_LIMITER` | Rate limiting | per-IP limit on catalog cache misses |

Vars (public, in `wrangler.jsonc`): `APP_VERSION`, `GIT_COMMIT` (stamped at deploy), `FETCHER_ENABLED`, `PERSTORE_REFRESH`.

### Required secrets (names only; set with `wrangler secret put`)

Pipe each value on stdin, e.g. `printf '%s' "$VALUE" | npx wrangler secret put NAME`. Never pass a value as a command-line argument, and never commit one.

| Secret | Needed for | If missing |
|---|---|---|
| `ADMIN_TOKEN` (32+ chars) | `/internal/*` admin endpoints | endpoints return 404 |
| `UR_FEEDBACK_BOT_TOKEN` (32+ chars) | `/__ur/*` feedback bot + admin page; also derives form-signing keys and IP-hash salts | feedback/sign-in intake and admin disabled |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | feedback form and sign-in | forms accept nothing (503) |
| `NOTIFY_TO` | inbox for owner feedback notices | no owner notice is sent (logged); feedback is still stored |
| `CF_ANALYTICS_TOKEN` | `GET /internal/stats` (Account Analytics Read) | stats unavailable |
| `ADMIN_OWNER_PASSWORD` (optional, 12+ chars) | read-only owner view of `/__ur/admin` | owner password path disabled |
| `CASHAPP_HANDLE`, `VENMO_HANDLE` (optional) | tip links and QR codes | that tip method is hidden |
| `OWNER_EXCLUDE_IPS` (optional) | comma-separated owner IPs skipped in analytics | no exclusion |
| `EMAIL_DAILY_QUOTA` (optional var) | shared email budget (default 200) | default |

### Schedules (cron triggers; all windows are America/Denver local time)

Cron Triggers are UTC-only, so each expression covers both MST and MDT and `src/schedule.ts` runs a job only when the tick's local time is inside its window. Other ticks are no-ops. The expressions must match `EXPECTED_CRONS` in `src/index.ts`.

| Job | Local window | Cron (UTC) |
|---|---|---|
| Nightly sweep | 12:30–3:55 AM | `30-55/5 6 * * *`, `*/5 7-10 * * *` |
| Per-store refresh | 4:00–10:55 AM | `*/5 10-17 * * *` |
| Catalog import (paused by default) | 11:30 AM, days 2–8 | `30 17,18 2-8 * *` |
| Same-day catch-up | 1:00–3:55 PM | `*/5 19-22 * * *` |

Email budget (Cloudflare Email Sending, 200/day): alerts 120, sign-in 40, feedback 30, spare 10, hard site-wide stop at 190 (`src/mail-budget.ts`).

## Setup

Node 22+ is required (`.nvmrc`).

```bash
npm ci
cp .dev.vars.example .dev.vars        # local TEST values only; never commit
npm run db:migrate:local
npm run dev                           # http://localhost:8787 (age gate first)
```

To deploy your own copy, create a D1 database, a KV namespace and an Analytics Engine dataset, then put your own `account_id`, `database_id`, KV `id`, routes and sender address in `wrangler.jsonc`.

## Database

- `migrations/` is the source of truth (D1 migrations, applied in order). Production: `npm run db:migrate:remote`.
- `db/schema.sql` creates the whole current schema in one go (tables, indexes, FTS5 search table, views, triggers; no rows). `db/reference-data.sql` holds the only reference rows the migrations seed: the owner-curated popular-100 roster (`perstore_popular`).
- Both are generated from the migrations: `python3 db/build_schema.py`. Verify they match the migrations: `python3 db/build_schema.py --check`.
- A fresh database built from `schema.sql` is not tracked by wrangler's `d1_migrations` table; prefer migrations for any database you will keep migrating.

## Tests

All tests are local. They make **zero** real DABS, Turnstile, email or Cloudflare API requests (mock DABS server on 127.0.0.1:9911, local Turnstile mock, the local send_email simulator, throwaway persist dirs under `/tmp`).

**Test by scope.** Run only what the change touches:

- **UI-only change** (pages, CSS, copy, tip page, feedback, sign-in): the quick set.
  ```bash
  npm run typecheck
  python3 scripts/test-feedback.py                                   # feedback, pages, tip links, admin
  python3 scripts/test-auth.py a b c                                  # sign-in
  node --experimental-strip-types --no-warnings scripts/test-mail-budget.ts
  node --experimental-strip-types --no-warnings scripts/test-tip-qr.ts          # when tips/QRs change
  node --experimental-strip-types --no-warnings scripts/test-analytics-exclude.ts  # when analytics changes
  ```
- **Data jobs, schedules, caps or DABS request logic**: also run the slow suites, each as its **own** job (they share ports 8788/9911, never run them in parallel):
  ```bash
  python3 scripts/test-perstore-retry.py
  python3 scripts/test-perstore-catchup.py
  python3 scripts/test-sweep-retry.py
  python3 scripts/test-sweep-catchup.py
  node --experimental-strip-types --no-warnings scripts/test-schedule-dst.ts
  ```
  These need a `.dev.vars` pointing at the mock (see `.dev.vars.example`).
- **Schema changes**: `python3 db/build_schema.py && python3 db/build_schema.py --check`.

## Deploy

Always deploy with:

```bash
npm run deploy
```

It checks the static-asset list (`scripts/check-assets.sh`) and stamps the git short SHA into `/health`. Commit before deploying so `/health.commit` matches the code. Apply any new migration first with `npm run db:migrate:remote`. Changes go through a branch and a pull request; after the owner approves the change, the maintainer merges the PR and deploys from `main`.

## Layout

```
src/index.ts          Worker entry: gate, disclaimer, headers, /health, admin endpoints, cron dispatch
src/schedule.ts       America/Denver windows and hard stops
src/fetchers/         DABS client, guard (caps/lock/kill switch), sweep, per-store, popular-100, catch-up, catalog import
src/web/              Catalog queries, server-rendered pages, routes + JSON API
src/auth.ts           Email magic-link sign-in, sessions, account page
src/feedback.ts       Feedback form, owner notices, bot endpoints, admin page
src/mail-budget.ts    Shared daily email budget
src/analytics.ts      Anonymous visit counting + /internal/stats
src/tip.ts            Tip page, links and QR codes
public/               Static pages and CSS
migrations/           D1 migrations
db/                   schema.sql, reference-data.sql, build_schema.py
scripts/              Tests, mocks, deploy check, ops helpers
docs/                 Technical reference: operations runbook, data sources, cost, popular-100
ai-context/           AI handoff: rules, memory, decision log, plan, watches design, routines
AGENTS.md             Short rules for any AI agent working in this repo
```

## Docs

- `AGENTS.md` and `ai-context/README.md`: start here if you are an AI agent (or a new maintainer) picking up the project.
- `docs/OPERATIONS.md`: detailed operations runbook (routes, admin calls, status fields, local mock recipes).
- `ai-context/DECISIONS.md`: every product and ops decision, with dates.
- `ai-context/WATCHES-DESIGN.md`: sign-in and bottle-watch alerts design.
- `docs/DATA-SOURCES.md`, `docs/popular-100.md`, `docs/COST-PROJECTION.md`, `docs/per-store-estimate.md`; product plan in `ai-context/plan/`.

## Data and disclaimer

Data comes from public DABS pages, fetched at a low, capped rate. Utah Remedy is not affiliated with or endorsed by DABS. Verify with the store before you travel.
