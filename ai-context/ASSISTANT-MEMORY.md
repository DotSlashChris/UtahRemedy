# Assistant memory export (Remy, Utah Remedy build bot)

Exported 2026-11-23 from the assistant's durable memory. Personal details are removed. Newer facts win over older ones; ai-context/DECISIONS.md is the detailed record.

## Working rules
- Remy works only on Utah Remedy unless the owner explicitly says otherwise.
- Work one step at a time: recommend, wait for owner approval, then confirm when live.
- The owner is cost-conscious: project compute costs and confirm usage fits the Cloudflare plan's included limits before enabling anything that could incur charges.
- Promised status updates and check-ins are scheduled, not left to memory, and must actually arrive. A daily status is sent every day around 11:15 AM America/Denver, even on clean days.
- Caps, gaps, pauses, the 429 rule, fail-closed behavior and windows change only with owner approval. Worst case must stay at or under 500 combined DABS requests a day.
- Always deploy with `npm run deploy`.
- Never print secrets, tokens, passwords or the owner's IP; pipe secrets via stdin into `wrangler secret put`.
- Standing goal: counts toward the owner's target of 1,000 combined users by January 1, 2027 (with Agenda Watch users and Off By One orders). Target only; take no unsolicited growth actions.
- From 2026-11-23: code lives in the public GitHub repo DotSlashChris/UtahRemedy; all changes go through a branch and pull request. After the owner merges, the assistant deploys from main with `npm run deploy`.

## Testing by scope (owner rule 2026-11-20)
- UI-only change (pages, CSS, copy, tip page): typecheck, quick page and feedback tests, tip QR test when relevant.
- Slow per-store and sweep/catch-up suites run only when data jobs, schedules, caps or DABS request logic change, as separate jobs; split or mark any timing-out test so it does not block the rest.

## Product and non-negotiables
- Utah-only Cloudflare-hosted service tracking DABS liquor availability; planned alerts, crowdsourced shelf reports, Remedies points, Concierge special orders.
- 21+ age gate (birthdates not stored); clear not-affiliated-with-DABS disclaimers; verify-with-the-store language; freemium with limited free watches and no subscription in beta; respectful polling with caching; fail closed on data fetches; clear full-case special-order rules; professional but fun tone.
- Only pure static files may skip the Worker (selective run_worker_first); all HTML routes run the Worker so the age gate applies.
- Legal pages: plain-language, operator Quazar16 LLC, contact hello@utahremedy.com, state birthdates are not stored, keep not-affiliated language and verify-before-travel advice.
- Disclaimer (since 2026-11-20): short DABS notice at the bottom of every page, just above the tip section. "Tip the dev" and "Disclaimer" links stay in the header. Tip section always at the very bottom, linking to /tip with Cash App $Quazar16 and Venmo https://www.venmo.com/u/Quazar16 QR codes.
- Site reachable only via utahremedy.com (www redirects); workers.dev disabled 2026-10-21. Domain registered on Cloudflare, expires 2027-10-21, auto-renew.

## Data jobs
- Local windows, America/Denver all year (since 2026-11-13; UTC crons cover MST and MDT, worker gates on local time): sweep 12:30–3:55 AM, per-store 4:00–10:55 AM, same-day catch-up 1:00–3:55 PM, catalog import 11:30 AM on days 2–8 (paused).
- Caps: per-store retry requests 50/day (raised from 40 on 2026-11-10), sweep retries 40, 3 retries per bottle/page, 15-minute pause and re-pause rules, 429 = one-hour pause, 10-second gap, fresh-first then stalest-popular-first ordering, 60 runs/day, 700 daily cap (1,600 on drop day), 500 combined ceiling.
- Drop day (3rd Saturday of the month) skips the popular pass.
- Per-store: B1 = status-A allocated SKUs with stock; B2 = owner-approved popular-100 list. Broader coverage needs approval. Failed/incomplete fetches never update counts or mark items out of stock; unchanged re-checks refresh verified_at under the 36-hour rule.
- Popular-100: locked bottles always stay (Blanton's is locked); not fetched twice when the allocated check covers it; skipped on zero-stock days but stays locked. Bottles in 40+ stores are flagged for manual removal; nothing auto-prunes.
- Missing-store rule (2026-11-02): accept only when DABS returned a clean parsed 200, no duplicate stores, quantities sum exactly to today's statewide count, the only problem is missing stores, and the same stores were also missing the previous day. Missing stores are recorded out of stock with an inferred note.
- Empty-list rule (2026-11-22): accept an empty store list (all stores out) only when today's complete nightly sweep already shows statewide 0 and the per-store response is clean. Everything else fails closed.
- Same-day catch-up (2026-11-13/14): if the sweep ends incomplete, retry only unfinished pages in the 1:00–3:55 PM window if the 500 ceiling has headroom; never a second full sweep.
- Full catalog: monthly DABS product list import (one request/month) approved; automatic monthly import is off unless re-enabled (reminder Dec 1, 2026).
- 52 DABS stores seen (about 50 public, 2 club-only).

## Analytics
- Count only third-party traffic. Exclude status checks, verify visits (user agents UR-ops-verify, UR-owner-verify, UR-ops-catchup), timing probes (UR-ops-status), sweep traffic and owner IPs (secret OWNER_EXCLUDE_IPS, exact match, never stored).
- Anonymous visitor ID: first 16 hex of SHA-256(daily salt | IP | User-Agent); no IPs, birthdates or new cookies stored.

## Feedback guardrails
- The shared feedback secret is sent only as a header from a file; never on a command line or in logs.
- Replies describe only how the product works today; no promises of new features.
- Automatic replies only for the routine category; everything else waits for an explicit owner yes.

## Watches project (approved 2026-11-21, built in separately approved steps)
- Step 1 live: magic-link sign-in (15 min, single use, "Finish signing in" button), 30-day sessions (max 5), sign out / sign out everywhere / delete account, Privacy+Terms updated.
- 2026-11-23 fix: an already-used link silently continues when the browser is already signed in; "Utah Remedy Home" wording.
- Step 2 (watches UI, up to 5 free watches), Step 3 (alerts: dry run, then a second yes before real sends), Step 4 (admin counts) each need separate approval.
- Email budget (Cloudflare Email Sending 200/day, likely account-wide): alerts 120, sign-in 40, feedback 30, spare 10, hard site-wide stop at 190.
- Design: ai-context/WATCHES-DESIGN.md.
