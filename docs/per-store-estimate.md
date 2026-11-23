# Per-store quantities for allocated and popular items: status, original estimate and actuals

Originally prepared 2026-10-22 as an estimate; updated 2026-10-23. **Status: LIVE** (owner-approved). Per-store quantities are refreshed once a day for status-A allocated SKUs (B1) and the owner-approved popular-100 list, within the existing daily DABS request cap. Everything below "Original estimate" is the 2026-10-22 analysis, kept for reference.

## What is live (as of 2026-10-23)
- **B1:** status-A (allocated) SKUs that have stock somewhere, refreshed daily after the nightly sweep completes. **44** SKUs on 2026-10-23 (up to 60 allowed).
- **Popular-100 (the "B2 slot"):** an owner-approved list of up to 100 SKUs (D1 `perstore_popular`), processed after B1. **1 locked** SKU: Blanton's Single Barrel `016850` (admin locks can pin more). SKUs already in B1 or with 0 statewide store quantity are skipped; popular is skipped on 3rd-Saturday drop days and can be switched off with KV `perstore:v1:popular` (no deploy). On 2026-10-23: 98 popular queued (+44 B1 = 142 total).
- **Schedule:** cron `*/5 11-17 * * *` UTC = **4:00-10:55 AM MST** (5:00-11:55 AM MDT in summer), 84 ticks, last tick 17:55 UTC; `*/5 10-12 * * *` until 2026-10-27, `*/5 11-13 * * *` (4:00-6:55 AM MST) until 2026-11-01, `*/5 11-15 * * *` (4:00-8:55 AM MST) until 2026-11-03. See the 2026-11-01 and 2026-11-03 notes below. It runs only after that day's sweep is complete. One frozen queue per Mountain-Time day (B1 first, then popular; popular stalest first since 2026-11-04), 12 requests (6 SKUs) per tick.
- **Limits:** up to 60 B1 + 100 popular SKUs/day; **2 requests per SKU** (GetDetailUrl, then ProductDetail); a **10 s gap** between requests (robots `Crawl-delay`); sweep + per-store together stay under **min(500, day cap)** requests, checked before every SKU and every retry; the account's DABS cap is **700/day** (1,600 on the drop day).
- **Fail-closed, unchanged:** an incomplete or invalid store list writes nothing. It never changes counts, never marks anything out of stock, and does not advance `verified_at`. Store lists must sum to the statewide count. *(2026-11-02, owner-approved narrow exception: a clean list that adds up exactly but leaves out stores we hold with stock is accepted only if the same stores (or a superset) were left out for that SKU the previous Utah day; the absent stores are then recorded as 0 with `inferred = 1` and a reason. Everything else stays fail-closed; see ai-context/DECISIONS.md.)* Per-store counts are a snapshot: **always verify with the store** before making a trip.

### Window extension and catalog move (2026-11-01, owner-approved)
- The per-store window is now **11:00-15:55 UTC = 4:00-8:55 AM MST** (was 11:00-13:55 UTC = 4:00-6:55 AM MST): cron `*/5 11-15 * * *`, `WINDOW_LAST_TICK_UTC_MIN = 15:55 UTC`. A row still `running` is closed `window_ended` at the 15:55 tick (no longer at 13:55). 60 ticks instead of 36, so 15 min pauses, 1 h backoffs and 15 min retry delays have two more hours to finish.
- The monthly catalog import moved from `30 14 2-8 * *` (14:30 UTC, now inside the window) to **`30 16 2-8 * *` = 9:30 AM MST / 10:30 AM MDT**, clear of the sweep (07:30-10:55 UTC) and per-store (11:00-15:55 UTC). Same Utah day, so its once-per-day/month gating is unchanged.

**Update 2026-11-03 (owner-approved, option C):**
- Window widened again to **11:00-17:55 UTC = 4:00-10:55 AM MST**: cron `*/5 11-17 * * *`, `WINDOW_LAST_TICK_UTC_MIN = 17:55 UTC`, 84 ticks. A row still `running` closes `window_ended` at 17:55 (no longer at 15:55).
- Catalog cron moved to **`30 18 2-8 * *` = 11:30 AM MST / 12:30 PM MDT** (same Utah day), still paused (KV `catalog:v1:auto` absent).
- Re-pause rule: after a 15 min streak pause, a transient failure on the first request starts another 15 min pause at once (the failed probe counts like any transient failure). 429 still 1 h.
- Volume: unchanged. Per-store requests are bounded by the queue, not the ticks: <= (60 + 100) x 2 + 40 = 360, and no SKU starts once the day's requests + 2 would pass min(500, cap), so sweep + per-store <= 500. Runs stay capped at 60/day (fail-closed `Budget.startRun`); paused/waiting ticks charge none, so the 24 extra ticks only cost runs when they send requests. The re-pause rule can only remove requests (up to 2 failed attempts per pause).
- **No limit changed:** 2 requests/SKU, 60 B1 + 100 popular SKUs, 3 retries/SKU, 40 retry requests/day, min(500, cap) for sweep + per-store, 700/day cap, 60 runs/day, 12 requests/tick, 10 s gap, 15 min streak pause, 1 h for 429, fresh-first retry order, fail closed. The request estimate (~391/day typical, 431 with every retry) and the worst case are unchanged: the caps, not the number of ticks, bound the day. On a healthy morning the pass still finishes in ~24 ticks (~6:00 AM MST).

**Update 2026-11-10 (owner-approved):** the per-store daily retry-request cap is **50** (was 40). The sweep retry cap stays 40. All other limits are unchanged: 3 retries per SKU, the 15-minute pause and re-pause rules, the 429 one-hour pause, the 10-second gap, fresh-bottles-first / stalest-popular-first ordering, fail-closed behavior, and the 4:00–10:55 AM MST window. The 500 combined ceiling remains the hard limit; no request may be started that would exceed it. Volume is now ≤ (60 + 100) × 2 + 50 = 370, still gated by min(500, cap). Typical day ~391; 441 with every retry (was 431). A retry-heavy day is ~481–483, still under 500. See ai-context/DECISIONS.md (2026-11-10).

### Transient-5xx retry (added 2026-10-23)
- One temporary 5xx on a SKU (500, 502, 503, 504, 520-527, e.g. a 522) no longer pauses the pass. The SKU is requeued **15 min** later in the same window and the pass carries on.
- **Max 3 retries per SKU per day**, after which the SKU is failed for the day with nothing written. A retry re-runs the whole SKU (2 requests).
- **50 retry requests per day** in total (`perstore_state.retry_requests`; 40 until 2026-11-10); when the budget is spent, pending retries are failed rather than sent.
- **3 distinct SKUs in a row** hitting a transient 5xx means DABS is likely down: a **15-minute pause** (since 2026-10-30; it was the 1-hour pause before, and the sweep has used 15 min since 2026-10-26). The streak restarts when the pause starts and queued retries are kept. 429 and other hard errors keep the 1-hour backoff. 403 does not trigger it (unchanged). Since 2026-10-30 our 20 s request timeout is handled like a transient 5xx (same as the sweep): requeued under the same 3/SKU and 50/day limits, counts toward the streak, never toward the 3-consecutive-failures stop. Ticks that only wait or sit out a pause charge no run. Since 2026-10-31 fresh SKUs go first: at most 1 due retry between two fresh SKUs, and a fresh SKU first after a pause; retries run back to back only once the queue is done. This changes only the order, not the request estimate.
- Run rows now always finish: `complete`, `capped`, `failed`, `window_ended` or `expired` (ok + failed + skipped = total).
- Budget: 391 (Oct 23 baseline) + 50 = 441 < 500 < 700 (was + 40 = 431 until 2026-11-10). See ai-context/DECISIONS.md (2026-10-23, 2026-11-10).

### First real run: 2026-10-23 (actual vs estimate)
- **138 of 142 SKUs checked**; 391 of 700 requests used (sweep ~114 + per-store ~277); **1,223 store rows verified across 117 products** (1,136 of them changed, as expected for a first fill).
- At 06:05 AM MDT one **HTTP 522** on SKU `027100` started the old global 1-hour pause, which ran past the 6:55 AM window end. `027100` failed and `088915`, `924209` and `015863` were never checked (nothing was written for them). The retry logic above is the fix.
- **Actual vs the original estimate below:** the original B1 (A only, 43 SKUs) was ~86 requests and ~202/700 per day including the sweep; B2 (A + 100 L) was ~286 requests, ~402/700. The live setup is B1 + popular-100 = 142 SKUs and landed at ~277 per-store requests, ~391/700, which is close to the B2 estimate (~402), and 138 SKUs x 2 = 276 matches the 2-requests-per-SKU assumption. The first fill wrote more rows than a steady day will (the estimate's "first fill" case). Cost stayed $0 extra. Note the popular list is chosen by demand, not by status L.

---

# Original estimate (2026-10-22; for reference)
**ESTIMATE ONLY** at the time. Scenarios B1-B4 are labeled in the tables below; B1 and (a variant of) B2 were what shipped.

## Inputs (real counts from production D1, 2026-10-22, after the first clean sweep and the catalog import)

| Status | SKUs in D1 | With store stock | Warehouse only | No stock / unknown | Bottles in stores |
|---|---|---|---|---|---|
| **A** (Limited Dist with Allocated Quantity) | **43** (all from the live locator; **0 on the monthly product list**) | 22 | 19 | 2 | 183 |
| **L** (Limited Distribution) | **1,679** (1,630 locator + 49 catalog-only) | 1,588 | 42 | 49 (catalog-only: unknown) | 187,694 |
| P (Limited availability) | 0 | – | – | – | – |
| *For reference:* category "ALLOCATED SPIRIT" (any status) | 62 (A 33, L 19, T 7, S 2, U 1) | 29 | – | – | – |
| *For reference:* X (discontinued limited) / U (unavailable limited) | 82 / 30 | 81 / 23 | – | – | – |

**SKUs worth a store-detail fetch** (they have stock somewhere): A = **41**, L = **1,630**, A + L = **1,671**.

The **DABS allocated drop list** (abs.utah.gov Allocated & Rare page) **has no SKUs**: only item names, bottle counts, prices and store addresses. The 43 status-A SKUs are a proxy; mapping a drop list to SKUs needs name matching.

## Per-SKU unit costs

- **2 DABS requests per SKU, not 1.** The flow is `GetDetailUrl?sku=` (sets a TempData cookie) and then `ProductDetail/Index` (~200 KB HTML).
- **Run time.** At the robots.txt `Crawl-delay: 10` that is **~20 s per SKU** (measured avg 19.8 s). With `MAX_REQUESTS_PER_RUN = 12`, a run handles **6 SKUs** in ~2 min.
- **D1 rows written:**
  - Each listed store whose quantity changed costs **4 rows**: a snapshot row plus its index, and an `inventory_latest` row plus `idx_latest_store`.
  - Unchanged stores cost 0, because the store and latest upserts are guarded.
  - Each SKU adds about 3 rows of `fetch_log`.
  - DABS lists ~45 stores per SKU, zero-quantity stores included (measured 41 and 51).
  - **First fill:** ~183 rows per SKU.
  - **Steady state:** ~21 rows per SKU per day, assuming 10% of listed stores change. **Worst case:** ~93 rows, assuming 50% change.
- **KV writes.** The current admin code writes a 30-min detail cache per SKU (1 KV write), plus ~2–3 per run. A scheduled job doesn't need the per-SKU cache, and dropping it would remove most of these writes.
- **CPU.** About 0.4–0.6 ms to parse each SKU, plus ~15 ms overhead per invocation.

## Scenarios (daily request cap 700; 1,600 on the 3rd Saturday)

The baseline is already committed: the nightly sweep uses **~114** requests and ~10 runs. The monthly catalog import adds **≤ 2** requests on one day a month (≤ 1 page check per day on days 2–8 while waiting).

| | B1: **A only, daily** | B2: A daily + **100 L/day** (top demand) | B3: A daily + **all in-stock L on rotation** | B4: **all A + L daily** |
|---|---|---|---|---|
| SKUs per day | 43 | 143 | 43 + 199 L (full L cycle every ~8.2 days) | 1,671 |
| DABS requests per day | 86 | 286 | 484 | 3,342 |
| **Total requests/day incl. sweep and catalog** | **~202 / 700 (29%)** | ~402 / 700 (57%) | ~600 / 700 (86%) | ~3,458 (**4.9× the cap**) |
| Run time at 10 s | 14 min | 48 min | 81 min | **9.3 h** |
| Runs/day (cap 60), incl. ~10 for the sweep | ~18 | ~35 | ~52 | ~290 (cap blown) |
| D1 rows written: first fill (one-off) | ~7.9k | ~26k | ~306k spread over ~8 days (~38k/day) | ~306k |
| D1 rows written per day, steady (typical / worst) | ~0.9k / 4k | ~3k / 13k | ~12k / 20k | ~35k / 155k |
| D1 rows written per month, steady | ~27k–120k | ~90k–400k | ~370k–600k | ~1.1M–4.7M |
| KV writes/day (with / without per-SKU cache) | ~67 / ~24 | ~215 / ~72 | ~360 / ~120 | ~2,500 / ~840 |
| KV writes/month | ~2k / ~0.7k | ~6.5k / ~2.2k | ~11k / ~3.6k | ~75k / ~25k |
| Worker invocations/month (cron) | ~240 | ~720 | ~1,250 | – |
| CPU ms/month | ~5k | ~15k | ~23k | – |
| Bandwidth pulled from DABS/day | ~9 MB | ~29 MB | ~48 MB | ~334 MB |
| Freshness of per-store data | ≤ 24 h | ≤ 24 h for the chosen SKUs | **up to ~8 days**, so mostly shown as "stale" under the 36 h rule | ≤ 24 h |
| Fits existing caps? | **Yes** | Yes | Barely (~100 requests and ~8 runs of headroom) | **No** |

### Share of Workers Paid included allowances (monthly, account-wide; worst case shown)

| Meter | Included | B1 | B2 | B3 | Incremental $ |
|---|---|---|---|---|---|
| Worker requests | 10M | <0.01% | <0.01% | 0.01% | $0.00 |
| CPU ms | 30M | 0.02% | 0.05% | 0.08% | $0.00 |
| D1 rows written | 50M | 0.24% | 0.8% | 1.2% (+0.6% one-off fill) | $0.00 |
| D1 rows read | 25B | <0.01% (~50 rows per SKU) | <0.01% | <0.01% | $0.00 |
| KV writes | 1M | 0.2% | 0.65% | 1.1% | $0.00 |
| D1 storage | 5 GB | +~1 MB/mo | +~4 MB/mo | +~13 MB/mo | $0.00 |

The current total (sweep + catalog + search) is well under every allowance, so **B1–B3 all cost $0.00 extra**. Cost is not the constraint here. The binding constraints are the **DABS request cap/politeness** and the **runs cap**. B4 is infeasible because of those caps, not because of dollars.

### Drop day (3rd Saturday; next is Nov 21, 2026; cap 1,600)
- **Baseline:** the sweep (114) plus B1 (86) is ~200 requests. That leaves ~1,400.
- **Option 1:** an hourly A refresh from 07:00 to 14:00 (8 × 86 = 688) totals **~888**.
- **Option 2:** every 15 min for just that drop's ~15 SKUs (28 × 30 = 840) totals **~1,040**.
- **Not an option:** refreshing all 43 A SKUs every 30 min totals ~1,490 (93% of the cap), which is too tight.

## Risks
1. **Ban/terms risk.** The detail endpoint is the heaviest public call: two requests, a session cookie, and ~200 KB of server-rendered HTML each.
   - B1 adds ~75% to our daily DABS traffic, and B3 adds ~4×.
   - Utah.gov terms prohibit "abuse", not automation.
   - **Mitigations:** keep the 10 s gap, the 1 h backoff on 429/5xx, and the kill switch. Start with B1 and watch `fetch_log` for 429/5xx for a week before any expansion.
2. **Cap headroom.**
   - B3 leaves ~100 requests and ~8 runs per day for manual runs, catalog page checks and retries. It would also collide with any drop-day schedule unless that day is planned separately.
   - The sweep grows by ~1 page per 48 new in-stock items, which eats the same headroom.
3. **The allocated list has no SKUs.**
   - The drop list is by name only, and the monthly product list has **0** status-A items.
   - Status-A SKUs exist in D1 only because the sweep saw them in stock. Allocated items that never reach the in-stock list, or that DABS lists as L/T (19 L and 7 T in "ALLOCATED SPIRIT"), would be missed.
   - Name matching against the drop list is error-prone and must fail closed.
4. **Freshness prerequisite.**
   - Per-store `observed_at` only moves on change, and the UI marks per-store rows older than 36 h as stale.
   - Re-checking an unchanged store would therefore still show "stale" after 36 h. The fetcher needs a per-store `verified_at` (DECISIONS "Beta phase 2" item 3) before per-store data is worth paying for. That adds ~1 row written per store per fetch (B1: +~1.9k rows/day, still $0).
   - Any rotation slower than daily (B3) mostly produces "stale" labels.
5. **Scheduling.**
   - A new Cron Trigger plus an `EXPECTED_CRONS` entry would be needed, e.g. `*/5 10 * * *`. It must not share a tick with the catalog import (now 14:30 UTC), because both take the single-run lock. *(Original estimate; see the Schedule line above for what is live.)*
   - The Cron Trigger count is account-wide (Paid: 250).
6. **Club stores** #33 and #34 appear in detail pages and stay badged "Club only".
7. **Allocated sell-outs.** DABS drop-list quantities "will not be updated as they are sold". Per-store counts are the only real-time signal, so stale per-store data could mislead. Keep the "verify with the store" language prominent.

## Original recommendation (2026-10-22; since adopted: B1 then popular-100)
- **Start with B1 (done):** status-A SKUs with any stock, once daily after the sweep. That is ~86 requests/day, 14 min, ~1k D1 rows/day, $0. Ship the per-store `verified_at` fix first.
- **Expand to B2 only after a quiet week (done as popular-100, owner-approved)** (no 429/5xx), choosing the L SKUs by demand: watches or searches, and the "ALLOCATED SPIRIT" category.
- **Avoid B3/B4.** They exceed or nearly exceed the 700/day cap, and they would mostly show stale data.
