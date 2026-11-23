# Handoff: Utah Remedy (state as of 2026-11-23, America/Denver)

## What it is
Utah Remedy (https://utahremedy.com) shows where hard-to-find bottles are in stock at Utah DABS stores, from public DABS data, behind a 21+ age gate. One Cloudflare Worker (`utah-remedy`) with static assets, D1 `utah-remedy-db`, KV `UTAH_REMEDY_CACHE`, Analytics Engine `utah_remedy_events`, Email Sending from `hello@utahremedy.com`. Operator: Quazar16 LLC. Standing goal: counts toward 1,000 combined users (with the owner's other projects) by Jan 1, 2027. Target only; take no unsolicited growth actions.

## Current state
- **Live code:** worker version `e868f441-1cb2-43c2-b903-35172c3a925a` deployed 2026-11-23 3:21 PM MST (then secret-change version `5dbcff5f-3e66-4764-bc8a-8334bb6444b6` at 3:22 PM MST). `/health.commit` reads `0198832`, a commit from the pre-GitHub private history; the code in the public repo's first commit is the same code. The next `npm run deploy` from this repo stamps the public commit hash.
- **Source of truth:** public GitHub repo `DotSlashChris/UtahRemedy`, branch `main`. The pre-GitHub history is kept privately and is not needed to work.
- **Live features:**
  - Nightly in-stock sweep (12:30–3:55 AM), per-store refresh for allocated (B1) + popular-100 bottles (4:00–10:55 AM), same-day catch-up for an incomplete sweep (1:00–3:55 PM). All windows America/Denver.
  - Fail-closed writes with two narrow exceptions: the missing-store rule (2026-11-02) and the empty-list-at-statewide-0 rule (2026-11-22).
  - Search, product and store pages; 36-hour freshness rule (stale shows as unknown, never zero).
  - Short DABS disclaimer at the bottom of every page, just above the tip section; "Tip the dev" (`/tip`, Cash App `$Quazar16`, Venmo `Quazar16`, both QR codes) at the bottom.
  - Feedback form with owner notices to the `NOTIFY_TO` secret and bot triage endpoints `/__ur/*`; owner read-only admin `/__ur/admin`.
  - Email magic-link sign-in, account page, sign out / everywhere / delete (watches step 1).
  - Shared daily email budget: alerts 120 / sign-in 40 / feedback 30 / spare 10, hard stop 190 (Cloudflare Email Sending allows 200/day, likely account-wide).
  - Anonymous analytics with owner-IP exclusion.

## Pending and on hold (each needs its own owner approval)
- **Watches step 2:** watches UI (up to 5 free watches; any store or chosen stores, store choice only for B1/popular SKUs; "Watch this bottle" link on product pages; no alerts). Not started; waiting for the owner's yes.
- **Watches step 3:** alerts. First a dry run that only counts ("would have sent" in the daily status), then a second owner yes before any real email.
- **Watches step 4:** owner counts on `/__ur/admin` and one line in the daily status.
- **Catalog auto-import:** paused since 2026-11-03 (abs.utah.gov 403). Dec 1, 2026 check-in in `ROUTINES.md`.
- **Watch, don't change:** the per-store 50/day retry cap was hit on Nov 20 and Nov 22 (on the last retry). Report it; change it only with owner approval.
- **Legal pages** (`/terms`, `/privacy`, `/disclaimer`) are plain-language drafts, not reviewed by counsel.
- **Dev dependency warnings:** `npm audit` flags `undici` via `wrangler`/`miniflare` (dev only). Upgrading wrangler is a separate change.
- **Optional offers, not requested:** a feedback triage routine; skipping the repeated 1 AM hour on the Nov 7, 2027 DST fall-back.

## Daily status
Every day about 11:15 AM America/Denver, even on clean days. Contents in `ROUTINES.md`.

## Workflow
1. Recommend one step at a time; wait for the owner's explicit approval.
2. Work on a branch; open a pull request to `main` in `DotSlashChris/UtahRemedy`. Include `ai-context/` updates (`DECISIONS.md` section, this file) in the same PR.
3. After the owner merges: `git pull` on `main`, run the tests for the scope, `npm run deploy`, verify live, then tell the owner it is live (commit, worker version, time in America/Denver).

## Tests by scope (owner rule 2026-11-20)
- **UI-only** (pages, CSS, copy, tip page, feedback, sign-in): `npm run typecheck`, `python3 scripts/test-feedback.py`, `python3 scripts/test-auth.py a b c`, `node --experimental-strip-types --no-warnings scripts/test-mail-budget.ts`; add `scripts/test-tip-qr.ts` when tips/QRs change and `scripts/test-analytics-exclude.ts` when analytics changes.
- **Data jobs, schedules, caps or DABS request logic:** also `scripts/test-perstore-retry.py`, `scripts/test-perstore-catchup.py`, `scripts/test-sweep-retry.py`, `scripts/test-sweep-catchup.py`, `scripts/test-schedule-dst.ts`. Run each as its **own** job, never in parallel (shared ports 8788/9911). If one times out, split or mark it so it does not block the rest.
- **Schema:** add a migration, then `python3 db/build_schema.py && python3 db/build_schema.py --check`.
- All tests are local: zero real DABS, Turnstile, email or Cloudflare API traffic.

## Deploy
- Always `npm run deploy` (runs `scripts/check-assets.sh`, stamps the git short SHA into `/health`). Commit first.
- New migration: `npm run db:migrate:remote` before the deploy.
- Prefer deploying outside the data windows; if a window is open, check `/health` shows no run holding the lock.
- After deploy: `curl -A "UR-ops-verify/<what>" https://utahremedy.com/health` (ok, commit), plus a check of the changed feature. Verify-visit user agents keep analytics clean.

## Secrets (names only; values live only in Cloudflare)
`ADMIN_TOKEN`, `UR_FEEDBACK_BOT_TOKEN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `NOTIFY_TO`, `CF_ANALYTICS_TOKEN`, `ADMIN_OWNER_PASSWORD`, `CASHAPP_HANDLE`, `VENMO_HANDLE`, `OWNER_EXCLUDE_IPS`. Set with `printf '%s' "$VALUE" | npx wrangler secret put NAME` (stdin only). Never print a secret, token, password or the owner's IP, and never put one on a command line, in a log or in git. The feedback bot secret is sent only as a header read from a chmod-600 file (`scripts/feedback-bot.sh`). Local copies of the admin token and the bot header live in `~/.config/utah-remedy/` (chmod 600) on the assistant's machine.

## Operational gotchas
- **Node 22** is required (`.nvmrc`). On the assistant's box: `export PATH=/home/box/node22/node-v22.23.4-linux-x64/bin:$PATH` and `unset NPM_CONFIG_PREFIX` first. Use `npx wrangler`, never a global install.
- **Analytics exclusions:** count only third-party traffic. Use `User-Agent` prefixes `UR-ops-verify`, `UR-owner-verify`, `UR-ops-catchup` for verify visits and `UR-ops-status` for status probes; reports exclude them. The owner's IPs are skipped at write time via `OWNER_EXCLUDE_IPS` (exact match; IPs are never stored).
- **Orphaned `wrangler dev`:** an interrupted local test can leave `wrangler dev`/`workerd` listening on port 8788 (or 8789 for the auth test), which makes the next run fail. Check `ss -ltnp | grep -E ':(8788|8789|9911|9912|9913)'`; if no `test-*.py` runner is alive, kill that `wrangler dev` process group.
- **Long tests:** `test-feedback.py` (~4 min) and `test-auth.py a b c` (~5 min) are quick-scope but slow-ish; the per-store and sweep suites take much longer. Run them in the background, poll the output file, and never run two suites that share ports at once.
- **Fail closed** is the default everywhere: an incomplete DABS answer writes nothing and never marks a bottle out of stock. Don't "fix" a hold by loosening validation without approval.
- **Kill switch:** KV `dabs:v1:kill` = `1` stops all DABS fetching; `FETCHER_ENABLED` var must be `"true"`.
- **Analytics reads:** the assistant used a Cloudflare connector for Analytics Engine SQL; `/internal/stats` needs the `CF_ANALYTICS_TOKEN` secret and the admin token.
