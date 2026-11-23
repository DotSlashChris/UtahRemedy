# Popular-100: per-store refresh for ~100 extra SKUs (B2 slot) — IMPLEMENTED

> **Status (2026-10-22, 3:56 PM MDT): APPROVED and LIVE.** The owner approved the starter list as-is and the 04:00–06:55 MDT window. It was built and enabled in commit 19fd8c0, Worker version `11261afe-db52-47fb-910f-ca59dfb70aea`. The first real run is Fri Oct 23, 2026 from 04:00 MDT. See "Implementation" below and ai-context/DECISIONS.md. The sections after it are the original proposal, kept for reference.

## Implementation (as built)

- **List:** D1 `perstore_popular` (migration 0007), seeded with the 100 CSV rows. **016850 Blanton's Single Barrel is locked** at owner request; it is the only current Blanton's product. 016873, 016874 and 921500 are status U and were not locked.
  - Locks count toward 100, so CSV rank 100 (026484 Willett 4yr Rye) is now inactive reserve.
  - Active list = locked rows + the best-ranked unlocked rows, 100 in total.
- **Auto-prune (owner-approved 2026-11-05):** at queue build, unlocked popular SKUs with `quantity > 0` in **every** open-to-the-public DABS store are removed from `perstore_popular` (same delete path as admin remove; locked rows never). Club stores (`isClubStore`) are excluded from the count. `/health` → `fetcher.perstore.popular.auto_prune_rule = "all_public_stores"` plus `public_stores` and `last_auto_prune`. Caps, windows, B1, `stalest_first`, missing-store rule, and catalog pause are unchanged.
- **Daily queue (frozen at the first tick):** B1 status-A SKUs (≤ 60), then popular SKUs (≤ 100; membership: locked first, then rank; **fetch order since 2026-11-04: stalest first**, never-updated first, then oldest last good per-store update, ties higher statewide qty then SKU).
  - Popular skips SKUs already in that day's B1 queue and SKUs with 0 statewide store qty; they stay listed.
  - The design's "status ≠ A" filter became "not in today's B1 queue", so a locked A item is still covered if B1's 60 limit ever cuts it.
- **Guards:**
  - Cron `*/5 10-12 * * *` (wrangler.jsonc + EXPECTED_CRONS).
  - Ceiling 500 (applied as min(500, day cap)).
  - Per-tick caps unchanged (12 requests, 10 s gap).
  - Popular is skipped on 3rd-Saturday drop days.
  - The on/off flag is KV `perstore:v1:popular` (`on`/`off`, missing = off), read every tick. This replaced the "PERSTORE_REFRESH=allocated+popular" idea, which would have needed a deploy.
  - All existing protections are unchanged (kill switch, lock, budgets, backoff, sweep-complete prerequisite, fail closed).
- **Admin (ADMIN_TOKEN, 404 otherwise):**
  - `GET /internal/popular`
  - `POST /internal/popular/{lock,unlock,add,remove}` with `{"sku":"NNNNNN"}` (validated against the catalog)
  - `POST /internal/popular/flag` with `{"popular":"on|off"}`
  - Locked rows can't be removed (409 + D1 trigger). curl usage is in docs/OPERATIONS.md.
  - Changes apply from the next day's queue.
- **Pinned → locked:** the design's "pinned" is the `locked` column. A future weekly rotation must only rewrite unlocked rows.
- **Logs:** `fetch_log.query` = `sku=NNNNNN;list=b1|popular`. `perstore_state` gains `b1_total`, `popular_total` and `popular_note`.
- **Expected 2026-10-23:** ~43 B1 + ~99 popular (Blanton's is in B1 and has 0 store qty) ≈ 142 SKUs ≈ 284 requests, plus a ~116-request sweep ≈ 400/day. That is ~24 ticks, finishing ~06:00 MDT. Verification queries are in ai-context/DECISIONS.md (2026-10-22 popular-100 entry).

## Original proposal (2026-10-22)

Prepared 2026-10-22. **PROPOSAL ONLY.** Nothing here is implemented. No code, config, cron or deploy changed, and no DABS requests were made to build it. The list comes from read-only queries on production D1 (inventory observed 2026-10-22, 08:01–08:45 UTC sweep).

The owner approved a "popular-100" approach for the B2 slot. It replaces the earlier "limited SKUs/day" idea. About 100 extra SKUs would get the same per-store refresh as B1 in the early-morning pass, so their product pages show store counts. This document and `docs/popular-100-starter.csv` are the starter list for owner review.

## Selection method

**Universe:** products in D1 with statewide store quantity > 0. In-stock-zero, warehouse-only and on-order-only items are excluded.

**Exclusions:**
- Status **A**: already covered by B1.
- Status **S**: special order.

**Proxy for "not carried by nearly every store":** statewide store qty from 1 to 250.
- 250 is about the 90th percentile of status-L SKUs.
- It is about half the median of status-1 (general, "carried by most stores") SKUs. General-status p10 is 152 and the median is 511.
- Calibration point: Buffalo Trace (40 bottles statewide on the prototype day) was in only 5 stores.
- Anything above 250 was treated as broadly distributed and skipped. That rules out Silver Oak Napa 750 ml (260), Silver Oak Alexander Valley (378), Dom Pérignon (265), JW Blue (256) and similar.
- This is a proxy only. After the first real refresh, actual store counts will show which picks sit in 40+ stores, and those should be pruned.

**Status priority:**
1. L (limited, "sold at select stores")
2. T (trial/seasonal, mostly private barrels and limited offers in the DABS "SPIRIT OFFER" category)
3. X (discontinued-limited, remaining stock)
4. A few status-1 items that are well-known hunts with moderate distribution (Michter's US*1 Bourbon at 26 statewide, Penelope Barrel Strength, Patrón El Alto, Baker's, Rare Breed, and so on)

There are no P items in the data.

**Category signals:**
- Kept: bourbon/rye, scotch/Japanese/Irish, tequila, cognac, rum, Chartreuse and blue-chip wine/Champagne.
- Dropped:
  - soju, RTDs and beer;
  - minis (< 700 ml): the only 375 ml candidate was dropped;
  - magnums and 3 L formats;
  - flavored and novelty spirits, and holiday gift packs.

**Recognizability:** hand-curated from a brand keyword pass plus a review of all 371 in-stock L/T/X/U spirits and the top-priced L wines. Name recognition is a judgment call. The owner should strike or add freely.

**Rank:** a proportional interleave across the category groups, curator order within each group. Cutting the list at any N keeps roughly the same mix. Rank is not a demand score; there is no demand data yet (see "Later" below).

### Result (100 SKUs)

| | Count |
|---|---|
| Status L / T / 1 / X | 74 / 12 / 10 / 4 |
| American whiskey (bourbon 29, rye 5, Tennessee 2, other 2) | 38 |
| Scotch & world whisky (Scotch 22, Japanese 4, Irish 1) | 27 |
| Tequila | 14 |
| Wine & Champagne (wine 11, Champagne 3) | 14 |
| Cognac | 4 |
| Liqueur (Chartreuse green/yellow) | 2 |
| Rum | 1 |

Statewide store qty: median 35.5, max 247. 65 SKUs have ≤ 50 bottles statewide, 16 have ≤ 10, and 9 have ≤ 5.

**B1 coverage check:**
- B1's query selects exactly the 43 status-A SKUs with any stock (22 with store stock, 21 warehouse/on-order only). No status-A item with stock is missed today.
- Caveat: `PERSTORE_MAX_SKUS = 60` with `ORDER BY store_total_qty DESC` means that if the A count passes 60 (for example after an allocation drop), the lowest-qty A SKUs are silently dropped. Those are often the most hunted. Raise the cap or log when the queue is truncated.
- Note: several picks sit in DABS's **"ALLOCATED SPIRIT" category but carry status L or T**: Basil Hayden 10, Shenk's, Speakeasy, Joseph Magnus, Octomore 16.1/16.3, Nikka Yoichi, Ardbeg 17, Harlan (Allocated Wine). B1 does not cover these because it keys on status A. Popular-100 picks them up.

## Cost (DABS requests/day, against the 700/day cap)

| Job | SKUs | Requests |
|---|---|---|
| Daily sweep | — | ~114 |
| B1 allocated (2 req/SKU) | 43 | ~86 |
| Popular-100 (2 req/SKU) | 100 | ~200 |
| **Total** | 143 | **~400 / 700** (catalog days 2–8 add ~2) |

That leaves ~300 requests/day of headroom under the cap. The drop-day cap (1,600) is unaffected.

**D1 writes:** at most ~3,200 store rows/day (the sum of min(statewide qty, 50) over the list), and in practice far fewer. That is negligible against the Workers Paid D1 allowance. No KV per-SKU caches.

## Run time and window (10 s gap)

- One tick = 12 requests = 6 SKUs, about 2 minutes at the 10 s gap.
- `*/5` gives 12 ticks/hour = 144 requests = **72 SKUs/hour max**.
- B1 + popular-100 = 143 SKUs = 286 requests = **24 ticks, about 2 hours of `*/5` ticks**. Busy wall-clock time is ~48 min, but it is spread across ticks.

**It does NOT fit the current 4:00–4:55 MDT hour (10:00–10:55 UTC), or 3:00–3:55 MST after Nov 1.** That hour holds 72 SKUs. B1 uses ~43, leaving room for only ~24–29 popular SKUs.

Two `*/5` hours (288 request capacity vs 286 needed) leave almost no slack for a late sweep, a retry or backoff.

> *Update 2026-10-27: the per-store window moved to `*/5 11-13 * * *` (11:00–13:55 UTC = 05:00–07:55 MDT / 04:00–06:55 MST) so it starts after the sweep's new 07:30–10:55 UTC maintenance window. Same 36 ticks, same caps.*
>
> *Update 2026-11-01: widened to `*/5 11-15 * * *` (11:00–15:55 UTC = 04:00–08:55 MST / 05:00–09:55 MDT), 60 ticks, same caps; the monthly catalog import moved to 16:30 UTC.*
> *Update 2026-11-03: widened to `*/5 11-17 * * *` (11:00–17:55 UTC = 04:00–10:55 MST / 05:00–11:55 MDT), 84 ticks, same caps; the monthly catalog cron moved to 18:30 UTC (still paused); re-pause rule after a failed first request post-pause.*

**Recommendation: widen the perstore cron to `*/5 10-12 * * *`.** That is one cron trigger and one allowlist entry, replacing `*/5 10 * * *`.
- Window: 10:00–12:55 UTC = 04:00–06:55 MDT now, 03:00–05:55 MST after Nov 1. Both are well before store opening.
- Expected finish is ~11:55 UTC (05:55 MDT / 04:55 MST), with the third hour as overflow.
- Later ticks are the existing 1-row-read no-op.
- The per-tick cap (12) and the 10 s gap stay unchanged, so politeness toward DABS is unchanged.
- Alternative: keep two hours (`*/5 10-11`) and raise the perstore per-tick cap to 16 (~2.7 min per tick). Not preferred, because it changes a shared guard.

Order inside the pass: B1 (allocated) first, then popular-100 in rank order (superseded 2026-11-04: popular now goes stalest first, so if the day ceiling or backoff stops the run, the most recently refreshed popular items are the ones skipped).

## Guards that would need to change (proposal; see Implementation above for what was built)

- **`PERSTORE_MAX_SKUS` 60 → ~160.** Better: keep a separate cap per list, A ≤ 60 (or higher; see the caveat above) and popular ≤ 100, so one list can't crowd out the other.
- **`PERSTORE_DAY_REQUEST_CEILING` 400 → ~500**, still applied as `min(ceiling, cap)`. The planned total is ~400, so the current ceiling would stop the final SKUs on any day the sweep or catalog runs slightly heavy. 500 still leaves 200 under the 700 cap.
- **`PERSTORE_CONFIG`:** add a `popular` flag (default false), plus a mode such as `PERSTORE_REFRESH="allocated+popular"` so it can be switched off without a deploy. The existing `limited: false` (B2-as-all-L) stays off.
- **Cron:** `*/5 10 * * *` → `*/5 10-12 * * *` in both `wrangler.jsonc` and `EXPECTED_CRONS` (the fail-closed allowlist).
- **Source of the list:** a small `perstore_popular` table (sku, rank, pinned, added_at), loaded from the approved CSV. The queue query joins it and still requires store qty > 0 and status ≠ A, so dead or sold-out picks cost nothing.
- **Optional:** skip popular-100 on monthly drop days to leave drop headroom. Fail-closed `validateStoreList` (exact sum match) and the consecutive-failure stop stay as is.

## Later: weekly rotation driven by real views (plan only)

- **Measure:** use **Workers Analytics Engine** `writeDataPoint` on each product-page view (blob = sku, double = 1). It is fire-and-forget, adds no latency, and keeps **no per-view D1 or KV writes**. It fits within the included Workers Paid allowance at our traffic.
- **Weekly job:** a cron (for example Monday 09:45 UTC) queries the Analytics Engine SQL API for the top viewed SKUs over 7 days. It keeps only those that pass the same filters (store qty 1–250, status ≠ A/S, in stock) and rewrites the unpinned part of `perstore_popular`. That is one D1 batch per week and zero DABS requests.
- **Needs owner approval:** the SQL API requires a Cloudflare API token with Account Analytics read, stored as a Worker secret.
- **Shape:** about 40–50 **pinned** owner-chosen SKUs (the core hunts from this list) plus about 50–60 **rotating** slots by views, with the total held at ≤ 100 so the request budget above is unchanged.
- **Pruning:** after each refresh, drop picks that turn out to be in 40+ stores, or that have had zero views for 4 weeks.

## Questionable / for owner review

- **Very low counts (9 SKUs with ≤ 5 bottles statewide):** Octomore, Macallan 18 Sherry Oak, Boss Hog, WhistlePig 18, Nikka Yoichi, Harlan and others. Showing which store has the last bottle is exactly what hunters want, but these may sell out within days. The filter skips them automatically once stock is 0.
- **Ultra-luxury (4 over $1,000):** Louis XIII ($4,200), Harlan ($2,225), Hennessy Paradis ($1,400), Château Margaux '20 ($1,154). These are iconic but low-traffic. Easy cuts if the owner wants more mid-price hunts.
- **Status-1 inclusions (10):** these break the "L first" rule on purpose because they are classic hunts with moderate distribution: Michter's US*1 Bourbon, Penelope BS, Baker's, Rare Breed, Sazerac Rye, Willett 4yr Rye, Patrón El Alto, Herradura Suprema, Casa Dragones, G4.
- **Near the 250 edge:** Booker's (240), Henry McKenna SB (247) and Clase Azul Reposado (228). They may prove to be in most stores.
- **T/X items:** private barrels and seasonal offers churn. Expect several to leave within weeks. That is one reason for the rotation.
- **Exact-sum validation:** this may fail more often for multi-store L items when DABS's statewide count and its store list briefly disagree. Each failure costs 2 requests, and those SKUs simply show no store breakdown that day (fail closed).
- **Missing data:** one row (High West PX Sherry, 024187) has no size in DABS data; 750 ml is assumed.
- **Not available:** the strongest hunts (Weller, Stagg, Eagle Rare, Blanton's, Pappy, Fortaleza) are either status A (B1) or not in stock today, so they are not on this list.

## Status of docs/per-store-estimate.md

Its header still says "ESTIMATE ONLY, ON HOLD". That is outdated: B1 (allocated-only) has been live since 2026-10-22 (version 5cfbda30), and popular-100 is live since 2026-10-22 (version 11261afe). The file was **not** edited, because it is still open and locked in LibreOffice (`docs/.~lock.per-store-estimate.md#`). Update its status line once it is closed.
