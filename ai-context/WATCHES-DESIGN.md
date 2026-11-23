# Utah Remedy — Watches with email alerts (v1 design)

Status: **Approved with defaults (owner, t99s544, 2026-11-21)**, with the email split changed to the real Cloudflare Email Sending
limit of 200/day (see 4.6 and D4). **Build step "1" (owner's numbering) = section 11 steps 1+2: sign-in, account page, Privacy/Terms
wording, migration 0014 and the shared email budget: built and deployed 2026-11-21.** Watches UI (step 3) and alerts (step 4) are
not built; each needs its own owner yes. All times are America/Denver (MST now, MDT in summer).

## 0. Summary

- A signed-in user (email magic link, no passwords) can watch up to **5 bottles**. Each watch is one SKU, for **any store** or for
  **specific stores** (store choice only where we actually have store-level data).
- Alerts come **only from data we already collect**: the nightly sweep (statewide) and the morning per-store pass (store level for
  B1 allocated + popular-100 SKUs). **Zero extra DABS requests**; the 500/day combined ceiling, caps, gaps, pauses, windows, the 429
  rule and fail-closed behavior are untouched. `src/fetchers/*` is not modified.
- An alert fires on a **transition** (out of stock -> in stock), never "still in stock", and only from complete, fresh, observed
  (not inferred) data. Held missing-store cases, failed lists and incomplete sweeps never alert.
- One **digest email per user per day** at most, sent once the per-store pass has finished and not before **7:00 AM**. Global daily
  alert cap and a shared email budget protect the Cloudflare Email Sending quota.
- Privacy and Terms get new wording **before** any email is collected. 21+ gate, DABS disclaimers and analytics exclusions unchanged.

## 1. What exists today (read-only findings)

| Piece | Today |
|---|---|
| Schema 0001 | `users` (id, email UNIQUE, age_confirmed_at, notify_email, ...), `watches` (user_id, kind, criteria_json, filters_json, active), `alerts` (watch_id, user_id, channel, payload_json, status, delivered_at). All empty, unused. |
| Statewide stock | `inventory_latest` product row (`store_key=''`): `store_total_qty`. The sweep writes changed rows page by page (`writeProducts`, snapshot only on change); vanish-to-zero (`writeVanished`, `inferred=1`, qty 0) runs **only** when the day's sweep is `complete` and clean. The sweep lists in-stock items only, so a statewide 0 is always an inferred value from a complete sweep. |
| Store stock | Per-store rows (`store_key=<store id>`), written only from a validated list (`writeStoreDetail`; `verified_at` advanced). Absent stores are zeroed only under the missing-store rule (second day, `inferred=1`, `inferred_reason`); first-day missing = `held`, nothing written. |
| Per-store coverage | B1 = status-A (allocated) SKUs with any stock (statewide/warehouse/on-order > 0), ~43-52/day. Popular-100 = curated list, skipped for SKUs with 0 statewide store qty and on 3rd-Saturday drop days. Everything else: statewide only. |
| Run state | `sweep_state(day)` status running/complete/failed (+ same-day catch-up columns); `perstore_state(day)` status running/complete/capped/failed/window_ended/skipped/expired; `perstore_missing(sku, day)` outcome held/accepted_inferred; `fetch_log.kind` `sweep_page` / `perstore_detail`. |
| Email | `send_email` binding `EMAIL`, sender `hello@utahremedy.com` only, plain text, used by feedback (cap 30/day; last 10 of `EMAIL_DAILY_QUOTA` (default 100) reserved "for sign-in links"); every attempt in `feedback_mail_log`. (Before 2026-11-21; now the shared budget in 4.6.) |
| Abuse controls | Feedback pattern: CSRF double-submit cookie, Turnstile (fail closed), honeypot, salted HMAC IP hash (`hmac(UR_FEEDBACK_BOT_TOKEN, label, ip)`), D1 hit table purged after 1 h. |
| Pages | No JS (`script-src 'none'`), product/search/store HTML cached at the edge (Cache API). Analytics uses the path only (no query strings). |

Consequence for the design: product pages stay **user-agnostic and cached**; anything per-user lives on separate `no-store` pages.

## 2. Sign-in (email magic link)

**Flow**
1. `GET /signin[?next=/watch?sku=021986]` (age-gated like every page): email field, "I'm 21 or older and agree to the Terms and
   Privacy Policy" checkbox (required), Turnstile widget, CSRF cookie + signed timed form token, honeypot. CSP adds the Turnstile
   origin exactly like `/feedback`.
2. `POST /signin`: CSRF -> Turnstile (required, fail closed) -> honeypot -> form token age (>= 2 s, < 1 h) -> rate limits -> send.
   The response is always the same: "If that address can receive a link, we've sent one. It works once and expires in 15 minutes."
   (no account enumeration; same page whether the address is new, existing or rate-limited).
3. Email: subject "Your Utah Remedy sign-in link", link `https://utahremedy.com/auth/verify?t=<token>`.
4. `GET /auth/verify?t=...` shows a one-button "Finish signing in" page (POST) and does **not** consume the token. Reason: mail
   scanners and link previewers pre-fetch GET links and would burn single-use tokens.
5. `POST /auth/verify`: token valid, unused, unexpired -> mark used (single `UPDATE ... WHERE used_at IS NULL` so a race can't use
   it twice) -> create the user on first sign-in (`email`, `age_confirmed_at`, `terms_version`) -> new session -> redirect to `next`
   (same-origin path only, existing `safeNext` rules).

**Token**: 32 random bytes, base64url. Only `SHA-256(token)` is stored (`auth_tokens.token_hash`). Lifetime **15 min**, single use.
Requesting a new link does not revoke older unexpired ones (simpler; they expire in 15 min anyway). Rows deleted 24 h after creation.

**Rate limits** (D1 hit table like `feedback_hits`; only salted HMAC hashes stored, label `ur-auth-ip-v1` / `ur-auth-email-v1`,
rows purged after 24 h):
- per IP: 5 link requests / hour, 20 / day;
- per email: 3 links / hour, 6 / day;
- global: **40 sign-in emails / Utah day** (decision D4, shared budget 4.6); over the limit the page still says the same thing and nothing is sent;
- verify attempts: 20 / IP / hour (bad tokens).
Email is normalized (trim + lowercase) before hashing and storing.

**Session**: 32 random bytes in cookie `__Host-ur_session`; `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (30 days,
absolute; decision D5). Lax (not Strict) so a link from an alert email to "My watches" arrives signed in. D1 stores only
`SHA-256(session)`, user_id, created/expires/last_seen (last_seen updated at most once a day to save writes). Max 5 live sessions
per user (oldest dropped). All state-changing forms use the CSRF double-submit cookie; every account page is `Cache-Control: no-store`.

**Sign-out**: `POST /signout` deletes the session row and clears the cookie. "Sign out everywhere" on `/account` deletes all of the
user's sessions.

**Delete my account and data**: `/account` -> "Delete my account" -> confirm page -> `POST /account/delete` deletes the user's
sessions, watches, alert rows, pending tokens for that email and the user row in one D1 batch; feedback rows with that user_id get
`user_id = NULL` (message kept, as the privacy page already says feedback isn't auto-deleted). Daily aggregate counters (numbers
only) are kept. Confirmation is on-screen only (no email).

**Age**: 21+ gate unchanged and still in front of every account page. First sign-in records `age_confirmed_at` from the required
checkbox. Birthdates are still never stored.

## 3. Watches

- A watch = one SKU + scope: **any store** (default) or **specific stores** (1-5 stores).
- **Free limit: 5 active watches per user** (enforced server-side; 6th add shows "You're at the free limit of 5. Remove one to add
  another."). No paid tier, no upsell copy.
- Store choice is offered **only for SKUs with store-level data** (in today's B1 queue or the active popular-100 list). Other SKUs
  show: "We only see a statewide count for this bottle, so alerts are for any store." (decision D2).
- **Product page**: one static link, the same for everyone so the edge cache is untouched: "Watch this bottle" -> `/watch?sku=<sku>`.
  `/watch` (no-store): signed out -> sign-in form with `next` back here; signed in -> scope picker (any store / store checkboxes for
  covered SKUs) + Save, or "You're watching this bottle" + Edit/Remove if it exists.
- **My watches** (`/watches`): list of up to 5 with bottle, scope, current status from our data ("In stock statewide, N bottles, as
  of 2:20 AM" / "Not in stock as of ..."), last alert date, Remove button, and a global "Email alerts: on/off" toggle.
- Header nav: "My watches" link (static, so it can be cached). No other layout change; the bottom disclaimer + tip section stay.
- Storage: reuse `watches` (`kind='product'`), add `sku` and `stores` columns for indexed matching (criteria_json/filters_json kept in
  sync for the 0001 shape). Remove = delete the row (not soft-delete).

## 4. Alerts: signals, rules, timing

### 4.1 Which signal each watch gets

| Watched SKU | Signal | Alert says |
|---|---|---|
| Any SKU, scope "any store" | Statewide: nightly sweep `store_total_qty` 0 -> >0 | "In stock at Utah stores: N bottles statewide as of <time>." Plus the store list if the per-store pass validated that SKU today. |
| B1 allocated (while it has stock) or active popular-100, scope "specific stores" | Store level: today's validated per-store list shows a chosen store going 0/absent -> >0 | "In stock at <Store> (<city>): N as of <time>." |
| Non-covered SKU, scope "specific stores" | Not offered (D2). If coverage ends later (SKU drops off popular-100) the watch stays and My watches says "store-level data paused for this bottle; no alerts until it returns". |

Note: B1 SKUs drop out of the per-store queue while they have no stock, so a returning allocated bottle gets its store list the
same morning (the sweep sees it, then the per-store queue picks it up). Popular SKUs are skipped on drop days, so no store-level
alerts for them that day.

### 4.2 Statewide transition (day D) — all must hold
1. `sweep_state(D).status = 'complete'` (nightly, or the same-day catch-up completed it). Running/failed/window_ended -> no
   statewide alerts that day.
2. The SKU has a product-level snapshot from a `sweep_page` fetch of day D with `inferred = 0` and `store_total_qty > 0`.
3. Its previous product-level value before day D's sweep started was `store_total_qty = 0` (an inferred zero from an earlier complete
   sweep, or an observed 0), **or** no product-level row at all while day D-1's sweep was complete (a catalog-only bottle appearing).
   Warehouse-only or on-order changes never alert.
4. Mass-reappearance guard: if day D has more statewide 0 -> >0 transitions than `max(25, 10% of in-stock SKUs)` (same limit as
   vanish-to-zero), send **no** statewide alerts that day and flag it in the daily status (protects against a bad vanish day followed
   by everything "coming back").

### 4.3 Store-level transition (day D, store S) — all must hold
1. Today's `perstore_state(D)` row (normal or catch-up) is terminal and the SKU's fetch today was `ok` or
   `missing_store_accepted_inferred` (category in `fetch_log`). `missing_store_held`, qty mismatch, duplicate, parse, no_statewide,
   transient_exhausted, retry_cap_dropped, http/network errors -> no store-level alert for that SKU today (fail closed).
2. Store S is in today's validated list with `quantity > 0` (`verified_at` today, `inferred = 0`).
3. Before today, S was out: its last stored value was 0 (accepted-inferred under the missing-store rule, or observed), or S had no
   row, or the SKU itself had a statewide 0 -> >0 transition today (covers stale store rows left from before the bottle sold out).
4. Baseline guard: "S had no row" counts only if the SKU had a validated per-store list on an earlier day, or rule 3's statewide
   transition happened today. A SKU checked per-store for the first time ever (newly added to popular-100) never alerts on day one.
5. Inferred values never produce an "in stock" signal; stale values (not written by day D's runs) are never used.

### 4.4 Dedupe, cooldown and caps
- One alert row per (watch, day) (unique index). A watch that alerted won't alert again for **7 days** (statewide) or 7 days per
  (watch, store) (store level) (decision D3). Transition-only already means "staying in stock" never re-alerts.
- **Per user: max 1 email per day** — all of that user's triggered watches go into one digest.
- **Global: `ALERT_DAILY_CAP` = 120 alert emails / day** (decision D4), further limited by the shared quota (4.6). Over the cap:
  users are processed oldest-watch-first; the rest get alert rows with `status = 'suppressed_cap'` (shown on My watches as
  "Back in stock <date> — email skipped (daily limit)") and the count goes in the owner's daily status. No carry-over to tomorrow
  (stale stock news is worse than none).
- Users with alerts off (`notify_email = 0`) get an alert row `suppressed_user_off` (for My watches) and no email.

### 4.5 When alerts go out (America/Denver)
- **Morning pass**: the first cron tick that is at or after **7:00 AM** *and* finds today's per-store row terminal (complete, capped,
  failed, window_ended, skipped). Typical day: per-store finishes ~5:40 AM -> alerts at **7:00 AM**. Late per-store -> alerts right
  after it closes, at the latest the 10:55 AM tick. Stores open 11 AM, so alerts land before opening on a normal day. (Decision D1.)
- **Afternoon pass** (only when the nightly sweep needed the same-day catch-up): after the catch-up's sweep is complete and its
  follow-on per-store is done/not_needed/skipped, during the 1:00-3:55 PM ticks. Emails say "as of <time>" so the lateness is visible.
- Mechanism: a new module `src/alerts.ts`, called from `scheduled()` in `src/index.ts` **after** the per-store or catch-up tick
  returns (same existing crons; no new cron, no window change for any DABS job). It takes its own D1 lock (`alerts`, not the `dabs`
  lock), charges **no** run and **no** DABS request, never imports the DABS client, and only reads `sweep_state`, `perstore_state`,
  `perstore_missing`, `fetch_log`, `inventory_latest`, `inventory_snapshots`. One `alert_runs(day, pass)` row makes each pass happen
  at most once a day; sends are spread over ticks (max 25 sends per tick) and resume on the next tick if interrupted.
- Kill switch: KV `alerts:v1:send`. Absent/any value except `on` = **dry run**: everything is computed and logged in `alert_runs`
  / `alerts` (`status='dry_run'`), nothing is emailed. Turning sends on is its own owner-approved step.

### 4.6 Shared email budget (Cloudflare Email Sending) — built in step 1 (`src/mail-budget.ts`)
- Cloudflare Email Sending limit: **200 sends/day** (owner read it from the dashboard, 2026-11-21). Treated as **account-wide**: if
  another project on the account starts sending, it shares the same 200. `EMAIL_DAILY_QUOTA` defaults to 200 (no var set).
- **Split per Utah day (owner-approved t99s544):** alerts **120** (reserved; nothing sends alerts until step 4b), sign-in links **40**,
  feedback **30** (notices + replies, unchanged), spare **10**.
- **Hard site-wide stop: 190 sends/day** across all categories (`min(190, quota - 10)` if the quota var is ever set lower).
- **Sign-in is never crowded out:** a non-sign-in send (alert, feedback) also needs room for every sign-in link not yet sent today:
  `total + max(0, 40 - signin_sent) < 190`. With today's caps this always holds (120 + 30 + 40 = 190); the rule protects against future
  cap changes or stray rows.
- Enforcement is one **atomic conditional INSERT** per send (reserve a row, then send, then settle it to sent or failed), so concurrent
  requests can't overshoot. Failed sends settle to `ok = 0` and stop counting. Sign-in/alert rows go in `mail_log` (no recipient
  stored); feedback keeps `feedback_mail_log`; the site-wide total sums both.
- Errors `E_DAILY_LIMIT_EXCEEDED` / `E_RATE_LIMIT_EXCEEDED` are logged as failures (fail closed); the alert pass (step 4) will stop for
  the day on them.

## 5. Emails

Plain text (like feedback), from `Utah Remedy <hello@utahremedy.com>`, Reply-To hello@.

**Alert digest** — subject `In stock: <Bottle>` (1 bottle) or `<N> watched bottles are in stock` (2+).
```
Good news: a bottle you're watching on Utah Remedy showed up in public DABS data.

Blanton's Single Barrel (SKU 016850)
  In stock at Utah stores: 14 bottles statewide as of 2:20 AM MST.
  Sugar House (Salt Lake City): 3 as of 5:12 AM MST
  https://utahremedy.com/product/016850
  Stop alerts for this bottle: https://utahremedy.com/u/w/<signed-token>

Counts come from public DABS data, can lag, and aren't guaranteed. Verify with the store before you travel.
Utah Remedy is an independent service, not affiliated with or endorsed by the Utah Department of Alcoholic Beverage
Services (DABS). For adults 21 and older.

You're getting this because you watch this bottle at https://utahremedy.com/watches.
Stop all alert emails: https://utahremedy.com/u/all/<signed-token>
```
**Headers**: `List-Unsubscribe: <https://utahremedy.com/u/all/<signed-token>>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
`List-Id: Utah Remedy watch alerts <alerts.utahremedy.com>` (all on Cloudflare's header allowlist). HTTPS only, no mailto
(decision D9).
**Unsubscribe**: tokens are HMAC-signed (`ur-unsub-v1`, user id + watch id + scope; no expiry; no sign-in needed). `/u/*` paths are
**public** (mail providers POST one-click without cookies) and show no product names or alcohol content. `GET` shows a one-button
confirm page (scanner-safe); `POST` (also the RFC 8058 one-click) applies it: per-watch = delete that watch; all = `notify_email = 0`
(watches stay; turn back on from My watches). Idempotent; invalid token = generic "link not valid" page.
**Sign-in email**: the link, "expires in 15 minutes and works once", "didn't ask for this? ignore it; no account is created unless the
link is used", the 21+ line. No List-Unsubscribe (transactional).

## 6. Privacy and Terms (exact new wording; publish in the same deploy as sign-in, before any email is collected)

### 6.1 Privacy Policy changes
Replace the paragraph starting "We do not currently have accounts or sign-up forms" with:

> We don't use advertising cookies, tracking cookies, or third-party trackers. The only measurement we do is the anonymous daily-code
> visit count described above.

Add to **What we collect now**:

> **Account and sign-in:** if you sign in to use watches, we save your email address, the date you created your account, when you
> confirmed you are 21 or older, and which version of our Terms you agreed to. We sign you in with a one-time link sent to your email;
> there are no passwords. Each link works once, expires after 15 minutes, and we keep only a scrambled copy of it, deleted after 24
> hours. Before you use a link, we keep the email address you typed with that pending link for up to 24 hours; if you never use it,
> no account is created.
>
> **Watches and alerts:** we save the bottles you watch (up to 5), any stores you pick, and a record of the alerts we sent or skipped
> for each watch (bottle, stores, date, and whether the email was sent). We use your email only for sign-in links and the stock alerts
> you asked for. We don't send newsletters or marketing, and we don't add you to any other list.
>
> **Sign-in protection:** the sign-in form uses Cloudflare Turnstile, which checks your browser and IP address. To limit repeated
> requests, we keep one-way scrambled codes made from your IP address and from the email address entered, not the addresses
> themselves, for 24 hours.

Add a section **Keeping and deleting your data**:

> Alert records are deleted after 90 days. Signed-in sessions end after 30 days or when you sign out. If you don't sign in for 12
> months and have no active watches, we delete your account. You can delete your account at any time from the Account page: this
> removes your email, watches, alert records, and sessions right away. Any feedback you sent stays, but is no longer linked to your
> account. Every alert email has a link to stop alerts for that bottle or for all bottles, with no sign-in needed. You can also email
> hello@utahremedy.com to ask what we hold about you or to delete it.

Replace the **Later** section with:

> We email you only what you asked for: sign-in links and alerts for bottles you watch. Emails are sent through Cloudflare, our hosting
> provider. If we ever want to collect anything else, we'll update this policy first and explain what and why.

**What we don't do**, add: "We don't share your email or watches with DABS, stores, or anyone else, other than the service providers
that run the site (Cloudflare)."

**Cookies**, replace with:

> We use only strictly necessary cookies: the age-check cookies described above; if you sign in, a sign-in cookie that keeps you
> signed in for up to 30 days and is removed when you sign out; and on the feedback, sign-in, and account forms, short-lived security
> cookies (up to 2 hours) that protect against forged submissions. You can clear them in your browser at any time. You'll just see the
> age check again and need to sign in again.

"Last updated" -> the deploy date.

### 6.2 Terms of Use changes
Replace **6. Future features** with:

> **6. Accounts, watches, and alerts**
> You can create a free account with your email address to watch up to 5 bottles. Keep access to your email secure: anyone who can
> open your sign-in links can use your account. Alerts are a convenience based on public DABS data that we check on a schedule. They
> may be late, missed, or wrong, a bottle may be gone by the time you arrive, and we don't guarantee any alert will be sent. Always
> verify with the store before you travel. We may limit how many emails we send in a day, and we may suspend accounts that misuse the
> service. You can stop alerts or delete your account at any time.
>
> **7. Remedies and Concierge**
> Features such as Remedies (points) and Concierge may have additional terms if they launch. Remedies have no cash value and can't be
> sold or transferred.

Renumber 7-10 to 8-11. "Last updated" -> the deploy date. Disclaimer page unchanged.

## 7. Data model (migration 0014, additive only)

Step 1 shipped `migrations/0014_auth.sql` with the auth part only: `users.terms_version`, `users.last_signin_at`, `auth_tokens`,
`sessions`, `auth_hits`, `mail_log` (kind `signin` | `alert`). The `watches` / `alerts` columns, `alerts_watch_day` and `alert_runs`
below come in a later migration with steps 3-4.

```sql
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN last_signin_at TEXT;
CREATE TABLE auth_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT);                                     -- purged 24 h after created_at
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  last_seen_at TEXT);  CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_hits (kind TEXT NOT NULL, key_hash TEXT NOT NULL, at INTEGER NOT NULL);   -- kind ip|email|verify; purged after 24 h
CREATE INDEX auth_hits_key ON auth_hits(kind, key_hash, at);
ALTER TABLE watches ADD COLUMN sku TEXT;
ALTER TABLE watches ADD COLUMN stores TEXT;                                   -- NULL = any store; else comma-separated store ids
CREATE INDEX watches_sku ON watches(sku, active);
ALTER TABLE alerts ADD COLUMN day TEXT;  ALTER TABLE alerts ADD COLUMN sku TEXT;
ALTER TABLE alerts ADD COLUMN signal TEXT;                                    -- statewide | store
ALTER TABLE alerts ADD COLUMN store_ids TEXT;
CREATE UNIQUE INDEX alerts_watch_day ON alerts(watch_id, day);
-- alerts.status: dry_run | sent | failed | suppressed_cap | suppressed_user_off | suppressed_quota
CREATE TABLE alert_runs (day TEXT NOT NULL, pass TEXT NOT NULL, status TEXT NOT NULL, statewide_transitions INTEGER,
  store_transitions INTEGER, matched INTEGER, sent INTEGER, suppressed INTEGER, note TEXT, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (day, pass));
CREATE TABLE mail_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '');  CREATE INDEX mail_log_day ON mail_log(day, kind, ok);   -- no recipient address stored
```
No change to any fetcher, catalog or analytics table.

## 8. Budget and cost

- **DABS requests: +0.** The alert step reads D1 only and never imports the DABS client (a test greps for it). Worst case stays
  <= 500 combined/day; 700 cap, 60 runs/day, retry caps, windows and pauses unchanged (the alert step charges no run).
- **D1 storage** at the 1,000-user goal: ~1,000 users + <= 5,000 watches + ~2,000 sessions + alerts (<= 120/day x 90 days = 10,800)
  ~ 12k rows, well under 1 MB.
- **D1 writes/day**: sign-in ~6 rows each (hits, token, use, user, session); alert pass ~2 rows per alert + 2 run rows; purges.
  Worst case a few hundred rows/day (today's fetchers write far more). Reads: one indexed matcher query per pass.
- **KV**: 1 read per pass (`alerts:v1:send`); no writes.
- **Email**: worst case 40 sign-in + 120 alerts + 30 feedback = 190/day, the hard site-wide stop, 10 under the 200/day Email Sending
  limit; Workers Paid includes a monthly email allowance (check current pricing on the dashboard before step 4b).
- **Worker CPU/subrequests**: max 25 sends per tick, well under the 300-subrequest limit.

## 9. Analytics

Unchanged rules. New pages are counted only as path category `other` (or a new `account` category) with no SKU, email, token or query
string (analytics already uses the path only). `/u/*` and `/auth/verify` are not tracked. Verify/status/sweep traffic and the
pending owner-IP exclusion work as before.

## 10. Testing plan (test by scope, owner rule t94u)

New fast mock suites (local `wrangler dev`, local D1, mock Turnstile, local `send_email` simulator, as `scripts/test-feedback.py`):
- `scripts/test-auth.py`: form gating (age gate, CSRF, Turnstile required/fail-closed, honeypot, token age), identical response for
  new/existing/limited email, per-IP/per-email/global limits, token single-use (incl. concurrent double POST), 15-min expiry, GET verify
  doesn't consume, cookie flags, session expiry, sign-out, sign-out-everywhere, delete-account removes everything, safe `next`.
- `scripts/test-watches.py`: 5-watch limit, store picker only for covered SKUs, add/edit/remove, CSRF, product page HTML identical
  signed in or out (cache-safe), My watches no-store.
- `scripts/test-alerts.ts` (pure matcher over seeded D1 states): complete vs failed/running/catch-up sweep; inferred-zero -> observed;
  warehouse-only ignored; mass-reappearance guard; store-level ok vs held/mismatch/failed/retry-capped; accepted-inferred store
  coming back; stale store rows + statewide transition; first-ever per-store SKU suppressed; cooldown; one digest per user; global cap
  and quota reserve; alerts-off users; dry-run vs on; timing (7:00 AM gate, per-store terminal, 10:55 AM, afternoon pass, MST/MDT via
  the existing DST harness); no DABS import.
- Email content: disclaimer + verify line present, List-Unsubscribe/Post/Id headers valid, one-click POST works without cookies,
  tokens tamper-proof.
- Existing quick suites when their files are touched: typecheck always; `test-feedback.py` (shared quota/reserve), `test-analytics.py`
  (new pages), `test-schedule-dst.ts` (scheduled dispatch).
- **Slow per-store and sweep suites are not needed**, because `src/fetchers/*` is not modified. If a later change touches job code,
  run them as separate jobs as before.

## 11. Build steps (each separately approved; deploy with `npm run deploy`)

1. **Wording**: owner approves the Privacy/Terms text in section 6 (and the email texts in section 5). No deploy on its own (D8).
2. **Sign-in**: migration 0014, `/signin`, `/auth/verify`, `/signout`, `/account` (incl. delete), sign-in email + limits, published
   Privacy/Terms. Owner tests with their own email. No watches yet.
3. **Watches UI**: `/watch`, `/watches`, product-page link, header "My watches", 5-watch limit. No emails.
4. **Alerts**: 4a matcher + digest builder in **dry run** for a few days (owner sees "would have sent" counts in the daily status and
   `/__ur/admin`). 4b owner yes -> KV `alerts:v1:send = on`; first live day reported in detail.
5. **Owner counts**: users, active watches, sign-in links sent/limited, alerts sent/suppressed/failed, top watched bottles (counts
   only, no emails) on `/__ur/admin` and one line in the daily status.

## 12. Open decisions (recommended default)

- **D1 Alert time**: first tick >= 7:00 AM after per-store finishes (latest 10:55 AM), plus an afternoon pass only after a catch-up.
- **D2 Store-specific watches**: only for SKUs with store-level data (B1/popular); others "any store".
- **D3 Cooldown**: 7 days per watch (per store for store watches).
- **D4 Email budget** (decided t99s544): Email Sending limit 200/day (assume account-wide). Alerts 120, sign-in 40, feedback 30,
  spare 10; hard site-wide stop 190; sign-in's 40 is never crowded out (4.6).
- **D5 Session length**: 30 days, absolute.
- **D6 Magic link**: 15 minutes, single use, confirm button on the verify page.
- **D7 Retention**: alerts 90 days, inactive accounts (12 months, no watches) deleted, tokens/hits 24 h.
- **D8 Policy timing**: Privacy/Terms go live in the same deploy as sign-in (step 2), not earlier.
- **D9 Unsubscribe**: HTTPS one-click only, no mailto.
- **D10 Email format**: plain text only in v1.
