# Routines (recurring work outside the Worker)

These run in the assistant's own scheduler, not in Cloudflare. A new assistant should recreate them. All times are America/Denver.

## Daily status (every day, about 11:15 AM)

**Purpose.** One plain-language message to the owner every day, even on clean days, after the morning per-store pass has had time to finish (per-store window ends 10:55 AM). It is read-only: it never triggers a fetch, never changes data, caps or schedules, and makes zero DABS requests.

**Sources.** `GET https://utahremedy.com/health` (send a `User-Agent` starting with `UR-ops-status` so it is never counted as a visitor), read-only D1 queries (`npx wrangler d1 execute utah-remedy-db --remote --command "SELECT ..."` on `fetch_log`, `sweep_state`, `perstore_state`, `perstore_missing`), and visitor counts from Analytics Engine (`GET /internal/stats` with the admin token, or a SQL API query with an Account Analytics Read token).

**What it reports.**
- **Nightly sweep (12:30–3:55 AM):** complete or not, pages done (e.g. 116/116), start/finish times, bottles in stock, bottles newly marked gone, pages retried and recovered, retry requests used vs the 40 cap, transient errors (522/5xx/timeouts), pauses, 429s; pages that fail repeatedly.
- **Same-day catch-up (1:00–3:55 PM):** whether one is needed (only when the sweep ended incomplete) and, the next day, how it went.
- **Per-store pass (4:00–10:55 AM):** allocated (B1) and popular-100 bottles checked out of total, bottles retried and recovered, retry requests vs the 50/day cap and when the cap was hit (bottles dropped and not written), bottles accepted under the missing-store rule (stores inferred, first vs second day) or the empty-list rule, bottles on hold (first-day missing stores, quantity mismatches with both numbers) and that their previous store lists are still showing within the 36-hour rule.
- **Budget and safety:** total DABS requests vs the 500 combined ceiling; any 403, 429 or ban-like signal.
- **Visitors:** third-party only. Exclude status checks, verify visits (user agents starting `UR-ops-verify`, `UR-owner-verify`, `UR-ops-catchup`), timing probes (`UR-ops-status`), sweep traffic and the owner's IPs (`OWNER_EXCLUDE_IPS`, applied at write time). Report yesterday's outside visitors and the 30-day baseline (gate passes, visitor-days, page views).
- **Feedback and email (when relevant):** new feedback items and email budget use (alerts 120 / sign-in 40 / feedback 30 / spare 10, stop at 190). Watches step 3 adds dry-run "would have sent" counts, step 4 adds watch counts.
- **Decisions needed:** anything that looks like it needs an owner call goes at the end as one clear recommendation. Never change caps, gaps, pauses, the 429 rule, fail-closed behavior or windows without an explicit owner yes.

## Dec 1, 2026 check-in: monthly catalog import

The automatic monthly DABS product-list import has been **paused since 2026-11-03** after abs.utah.gov returned HTTP 403 (KV `catalog:v1:auto` absent = paused; `/health → fetcher.catalog_auto_import.state`). The cron still fires at 11:30 AM on days 2–8 but does nothing while paused. November's list was pulled by hand and staged (see `DECISIONS.md` 2026-11-03).

On **Dec 1, 2026**, ask the owner whether to (a) turn the automatic import back on for the Dec 2–8 window (`npx wrangler kv key put --binding UTAH_REMEDY_CACHE catalog:v1:auto on --remote`), or (b) repeat the manual pull (owner downloads the XLSX, `scripts/manual-catalog.ts` validates it, staged in KV, applied by the admin path with no DABS request), or (c) skip December. Do nothing without the owner's answer.

## Optional routines offered but not set up

- A feedback triage routine (list new items, auto-reply only to the routine category per the feedback guardrails, everything else waits for the owner).
