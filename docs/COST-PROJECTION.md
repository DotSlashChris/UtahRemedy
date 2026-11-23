# Utah Remedy: Cloudflare Usage & Cost Projection (DABS fetcher)

> **Update 2026-10-21 (evening):** the hard caps (S1 to S6) and efficiency fixes (F1 to F5, plus F6 out-of-stock detection) **shipped**, and **Option B is live** (cron `*/5 8 * * *`; moved to `*/5 9 * * *` on 2026-10-26; widened on 2026-10-27 to the 07:30–10:55 UTC maintenance window, crons `30-55/5 7 * * *` + `*/5 8-10 * * *`, 42 ticks; per-store moved to `*/5 11-13 * * *`, catalog to `30 14 2-8 * *`; on 2026-11-01 per-store widened to `*/5 11-15 * * *` and catalog moved to `30 16 2-8 * *`, caps unchanged). The wider window adds no requests: each page is fetched once plus at most 20 retries, and a finished sweep makes no more requests that day. The 2026-10-28 page rest (30 min, then one more try) also adds none: post-rest tries count against the same retry cap. Since 2026-10-29 that cap is 40 (was 20), so the sweep stays ≤ pages + 40 (≤ 154 today; was ≤ 134). Daily worst cases: normal ~391, retry-heavy ~471–473 (27+ under the 500 combined ceiling, 227+ under 700), absolute worst ≤ 502 (the 500 combined ceiling + ≤ 2 catalog; ≥ 198 under 700). See ai-context/DECISIONS.md (2026-10-29). *2026-11-03: per-store widened to `*/5 11-17 * * *` (84 ticks), catalog to `30 18 2-8 * *` (paused), re-pause rule added; no request or run cap changed, worst cases unchanged (the re-pause rule only removes requests).* *2026-11-10: per-store retry cap 40 → 50 (sweep stays 40). Retry-heavy ~481–483 (17+ under the 500 combined ceiling, 217+ under 700); absolute worst still ≤ 502 (the 500 combined ceiling + ≤ 2 catalog). See ai-context/DECISIONS.md (2026-11-10).*
> The re-measured numbers are in [section 8](#8-re-measured-after-the-caps--efficiency-fixes-option-b-live). Sections 1 to 7 are the original pre-fix analysis.
> **Update 2026-10-21 (late):** user-facing search costs are in [section 9](#9-user-facing-search-beta-phase-2-2026-10-21).

Prepared 2026-10-21, **analysis only**. Nothing was deployed or enabled, and there are still no Cron Triggers.

The account (Quazar16 LLC, `ca827b3a832159e95f29d5d1d14e9b79`) is on **Workers Paid** ($5/mo base plus usage). It is shared with other projects. Month-to-date (Oct 12–21, per the dashboard):
- Workers requests: 11.05k of 10M included
- Workers CPU: 13.07k ms of 30M included
- D1 and KV: no billable usage
- The only overage is Containers (~$5.64/cycle, unrelated to Utah Remedy)

Model: `scripts/cost-model.py` (re-run it to reproduce every number below).

## 1. Current official limits & prices (fetched 2026-10-21)

Sources:
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/ (updated Oct 12, 2026)
- Workers pricing (includes the KV table): https://developers.cloudflare.com/workers/platform/pricing/ (updated Oct 2, 2026)
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Observability pricing: https://developers.cloudflare.com/observability/pricing/
- Static assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/

| Item | Workers Free | Workers Paid (this account) |
|---|---|---|
| Worker requests | 100,000/day (Error 1027 beyond) | 10M/month included, then $0.30/M |
| CPU per invocation | 10 ms (HTTP **and** Cron) | HTTP: 30 s default, up to 5 min. Cron: 30 s (interval < 1 h) or 15 min (interval ≥ 1 h) |
| CPU billing | n/a | 30M CPU-ms/month included, then $0.02/M ms |
| Wall clock | HTTP: no limit while the client is connected. Cron: **15 min** | same |
| Subrequests per invocation | 50 (1,000 to internal services) | 10,000 default (configurable up to 10M via `limits`) |
| Cron Triggers per account | 5 | 250 |
| D1 rows read | 5M/day | 25B/month included, then $0.001/M |
| D1 rows written | 100k/day | 50M/month included, then **$1.00/M** |
| D1 storage | 5 GB total, 500 MB per DB | 5 GB included, then $0.75/GB-month. 10 GB max per DB |
| D1 queries per invocation | 50 | 1,000 |
| KV reads | 100k/day | 10M/month included, then $0.50/M |
| KV writes | **1,000/day** | 1M/month included, then **$5.00/M** |
| KV storage | 1 GB | 1 GB included, then $0.50/GB-month |
| KV writes to the same key | 1/s | 1/s |
| KV ops per invocation | 1,000 | 1,000 |
| Static asset requests | free, unlimited | free, unlimited |
| Logs (from Dec 1, 2026) | 0.5 GB/day ingest, then stops ingesting | 50 GB/cycle included, then $0.25/GB |

**On Free, can anything be charged?**
- No. Free-plan limits are enforced as errors, not charges:
  - Workers return Error 1027 past the daily request limit, or 1102 past the CPU limit.
  - With `run_worker_first`, requests return 429.
  - KV and D1 operations "will fail with an error". D1 says "you will not be able to run queries."
  - Logs stop ingesting.
- The docs list no Free-plan overage pricing.
- **On Paid, overages are billed automatically.** The included allowances are monthly and account-wide, shared with Agenda Watch, Off By One, etc.

## 2. Measured per-operation costs (from the actual code and schema)

| Operation | D1 rows written | D1 rows read | How measured |
|---|---|---|---|
| `products` upsert (existing row) | **3** (row + `idx_products_name` + `idx_products_category`; also 3 when unchanged) | 1 | D1 `meta` on remote, bench row deleted afterwards |
| `products` upsert (new row) | 4 | 0 | same |
| `inventory_snapshots` insert | **4** (row + 2 indexes + AUTOINCREMENT sequence) | 3 | same |
| `stores` upsert (unchanged) | 1 | 3 | same |
| `fetch_log` insert + update (per attempt) | 6 | 4 | same |
| `looksLikeFalseZero` guard query | 0 | **full table scan** (101 of 101 rows) | same. ⚠️ This grows with the table; see fix F4 |

| Per unit | KV writes | KV reads | Subrequests | CPU |
|---|---|---|---|---|
| Product-table page (50 rows) | 3 (`last_request_at`, cache, `lastTotal`) | 2 | 9 (1 fetch + ~5 KV + 3 D1) | 0.12 ms parse + validate (measured, Node 22, real validator) |
| Store-detail SKU (2 DABS requests, ~200 KB HTML) | 3 | 1 | 9 | 0.37 ms warm / 0.62 ms cold (real 018006 page, 51 stores) |
| Per run | 1 (status) | 3 | 4 | — |
| *Reference:* the whole catalog in ONE response (26,340 rows, 9.9 MB JSON) | — | — | — | 84 ms CPU. Never requested; we page 50 at a time. It would exceed Free's 10 ms but fit easily within Paid's 30 s |

Other inputs:
- **Snapshot storage:** **~143 B/row** including both indexes (200k-row SQLite test on the real schema). The model uses 150 B.
- **CPU per invocation:** the model uses **15 ms** (conservative). Parsing is <2 ms per capped run; the rest is D1 batch serialization and runtime overhead. For comparison, this account's actual average is 13.07k ms / 11.05k requests ≈ 1.2 ms.
- **Catalog sizes** (live counts today):
  - 26,340 SKUs total, 5,456 in stock
  - status A (allocated): **50**
  - status L (limited): 1,713
  - status P: 0
  - So the 2-hourly check is modeled as 1 status-A page plus 25 watched-SKU lookups. L items are covered by the nightly sweep.
- **Per-run cap:** `MAX_REQUESTS_PER_RUN = 12`, so each run takes about 2 min of wall time at the 10 s gap. The nightly sweep's 110 pages need 10 invocations.

## 3. Projection

| Scenario | DABS requests | Worker invocations | Max subrequests / invocation | CPU ms | D1 rows written | D1 rows read | KV writes | KV reads | Snapshots added |
|---|---|---|---|---|---|---|---|---|---|
| **B** per day | 110 | 10 | 112 | 150 | 38,852 | 22,264 | 340 | 250 | 5,456 |
| **A** normal day | 493 | 49 | 112 | 735 | 66,725 | 52,996 | **1,226** | 831 | 10,481 |
| **A** drop Saturday | 1,361 | 133 | 112 | 1,995 | 163,213 | 163,288 | 2,654 | 1,559 | 28,681 |
| **B** per month | 3,300 | 300 | — | 4,500 | 1.17M | 0.67M | 10.2k | 7.5k | 164k |
| **A** per month (29 normal days + 1 drop Saturday + drop-week page checks) | 15,723 | 1,554 | — | 23,310 | 2.10M | 1.70M | 38.2k | 25.7k | 333k |

A per day is made up of:
- **Nightly sweep:** 110 pages (same as B).
- **2-hourly check:** 7 runs of 26 requests.
- **Store detail:** 100 SKUs × ~45 listed stores.
- **Allocated page:** 1 request.
- **Store-total cross-check:** CPU only, plus about 5 indexed rows read per SKU.

The drop Saturday adds 28 cycles between 07:00 and 14:00. Each cycle fetches 1 status-A page and does store detail for 15 allocated SKUs × ~40 stores.

**Storage growth** (snapshots only; fetch_log adds <1 MB/month):
- **B:** ~25 MB/month, about 0.3 GB in year 1.
- **A:** ~50 MB/month, about 0.6 GB in year 1.
- **Limits:** 5 GB included account-wide, 10 GB hard cap per DB.

### Share of Workers Paid included allowances (per month)

| Meter | Included | B | A |
|---|---|---|---|
| Worker requests | 10M | 0.003% | 0.016% |
| CPU ms | 30M | 0.015% | 0.08% |
| D1 rows written | 50M | 2.3% | 4.2% |
| D1 rows read | 25B | <0.01% | <0.01% |
| D1 storage | 5 GB | +0.5%/month | +1%/month |
| KV writes | 1M | 1.0% | 3.8% |
| KV reads | 10M | 0.08% | 0.26% |

## 4. Limits hit or nearly hit

**On Workers Paid (this account):** neither option comes close to any limit.
- The largest share is D1 rows written for A, at 4.2% of the monthly allowance.
- Subrequests peak at ~112 per invocation against a 10,000 limit.
- CPU is a few ms per invocation against a 30 s limit.
- Wall time is ~2 min per run against the 15 min cron limit.
- KV writes to the same key stay under 1/s, because the 10 s request gap keeps `last_request_at` well below that.

**If the account were ever on Free**, it would break, not bill:
- **KV writes:** A uses **1,226/day on a normal day and 2,654 on a drop Saturday, over the 1,000/day limit**. Writes would start failing mid-day. B (340/day) fits.
- **CPU:** the 10 ms per cron invocation is tight. Our estimate is ~5–15 ms, so some runs could hit Error 1102.
- **Subrequests:** ~112 per invocation goes past the 50 general / 50 D1-query limit. Each run would need to drop to about 4 pages.
- **Cron Triggers:** only 5 are allowed per account, and they are shared with the other projects.

**Real risks on Paid:**
1. **The false-zero guard query does a full scan of `inventory_snapshots`.** It only runs when every row in a page is zero, so it's rare. But on a table of 1M+ rows each run reads 1M+ rows. That's still cheap at $0.001/M, but it's slow and could get close to D1's 30 s query limit.
2. **A runaway bug** (next section).
3. **Shared allowances.** These numbers are Utah Remedy only, and other projects draw from the same pool.
4. **Not a cost issue, but a correctness gap:** the in-stock-only sweep never sees an item drop to zero, because the item simply disappears from the in-stock list. See F6.

## 5. Monthly $ cost

| | Option A | Option B |
|---|---|---|
| **Workers Paid (this account): incremental cost Utah Remedy adds** | **$0.00** (all meters within included allowances) | **$0.00** |
| Workers Paid total, if Utah Remedy were the only project | $5.00 | $5.00 |
| Workers Free (hypothetical) | $0 (cannot be charged), but **A breaks** (KV writes, subrequests, CPU) | $0, but it needs smaller runs (≤ 4 pages per invocation) to fit 50 subrequests and 10 ms CPU |

The $5 base is already being paid, so it isn't incremental. Even with 10× growth (many watched SKUs, more stores), A would reach about 21M D1 rows written per month, still within the 50M included.

### Worst cases (bugs), monthly, current code with no budget caps

| Scenario | DABS requests | D1 rows written | KV writes | Overage $ |
|---|---|---|---|---|
| **W1:** cron accidentally `* * * * *`, per-run cap of 12 intact | 518k | 185M | 1.6M | **≈ $138/mo** (D1 $134.55 + KV $2.99). Also near-certain IP ban by DABS |
| **W2:** loop bug bypasses the per-run cap (bounded only by the 10 s gap and the 15 min cron wall), overlapping every-minute crons | 3.9M | 1.38B | 11.7M | **≈ $1,388/mo** (D1 $1,334 + KV $54) |
| **W3:** ADMIN_TOKEN leaks and the endpoint is hammered in parallel (parallel calls defeat the best-effort KV gap) | unbounded | unbounded | unbounded | **Unbounded without a server-side daily budget** |
| Any of the above **with the proposed daily budgets** (≤ 250k D1 rows written, ≤ 3k KV writes, ≤ 1,600 DABS requests per day) | ≤ 48k | ≤ 7.5M | ≤ 90k | **$0.00** (stays within included allowances) |

## 6. Recommended changes before enabling Cron

### Hard safety caps (so a bug can't cause a surprise bill)

- **S1 (kill switch):** add a KV flag `dabs:v1:kill`, checked at the start of every run (scheduled or manual). If it's set, the run logs `skipped` and makes zero DABS, D1 or KV writes. Also add a deploy-time var `FETCHER_ENABLED` that defaults to `"false"`. Either one turns the fetcher off without a code change.
  - Flip it with `wrangler kv key put --binding UTAH_REMEDY_CACHE dabs:v1:kill 1 --remote`.
- **S2 (daily budget in D1, strongly consistent; not KV):** a `fetch_budget(day TEXT PRIMARY KEY, dabs_requests, d1_rows_written, kv_writes, runs)` row.
  - Before each request, run an atomic `UPDATE … SET dabs_requests = dabs_requests + 1 WHERE day = ? AND dabs_requests < cap RETURNING …`. If no row comes back, stop.
  - Add each batch's `meta.rows_written` to the row.
  - Proposed caps: **DABS requests 700/day (1,600 on the 3rd Saturday), D1 rows written 250k/day, KV writes 3k/day, runs 60/day (150 on drop day)**. That is about 2× normal A usage, and still $0 overage at 30× in a month.
- **S3 (per-run caps, already in code):** keep `MAX_REQUESTS_PER_RUN = 12`, ≤ 5 queries and 3 detail SKUs per manual call, 50 rows per page, and no in-run retries. Add a hard **max pages per sweep invocation** (12), plus a sweep cursor in D1 so a crashed run resumes rather than restarts.
- **S4 (platform-enforced caps in `wrangler.jsonc`):**
  - `"limits": { "cpu_ms": 5000, "subrequests": 300 }`. Normal use is ≤ 15 ms CPU and ≤ 112 subrequests, so these limits stop a runaway loop at the platform level even if the app logic is wrong.
- **S5 (explicit cron schedule):** use fixed hour/minute lists, never `*` minutes. Keep it to 2–3 expressions total (well under the 250 Paid limit). Add a guard in the `scheduled` handler that the event's `cron` string is one we expect.
- **S6 (single-flight lock):** a D1 row lock with a TTL, so overlapping invocations (a slow run plus the next tick, or parallel manual calls) can't run concurrently. This fixes W3's gap-bypass problem.
- **S7:** rotate `ADMIN_TOKEN` if it ever appears in logs or chat. Consider disabling `/internal/fetch/dabs` once Cron is live (S1 also covers it).
- **S8 (billing alert):** add a usage-based billing notification in the Cloudflare dashboard (Notifications) for D1 and KV usage on the account, as a backstop independent of our code.

### Efficiency fixes (usage is already tiny; these mainly protect headroom and storage)

- **F1 (write snapshots only on change):** add an `inventory_latest(sku, store_id, quantity, store_total_qty, on_order_qty, observed_at, PRIMARY KEY (sku, store_id))` table. Insert a snapshot only when a value differs from the latest; otherwise just bump `observed_at` on the latest row (1 row written instead of 4).
  - This likely cuts snapshot writes and storage by 50–90%. Measure it via fetch_log once running.
  - It also serves "current stock" reads cheaply.
- **F2 (skip no-op product upserts):** add `ON CONFLICT DO UPDATE … WHERE products.name IS NOT excluded.name OR …`. Unchanged upserts currently still write 3 rows; with this they write 0. That's about 16k fewer rows written per sweep.
- **F3 (trim indexes):** replace `idx_inv_sku_time` and `idx_inv_store_time` with a single `(sku, store_id, observed_at)` index, if store-time queries aren't needed. Snapshot inserts would drop from 4 to 3 rows written.
- **F4 (fix the full-scan guard):** rewrite `looksLikeFalseZero` against `inventory_latest` (indexed point reads, ~3 rows) instead of scanning snapshots.
- **F5 (fewer KV writes):** keep `last_request_at` in memory within an invocation and write it once per run, not per request. Store `lastTotal` in D1 alongside the sweep cursor. That's about −2 KV writes per page, which would bring A under 1,000/day even on Free.
- **F6 (zero-stock correctness):** after a *complete* in-stock sweep with a sane total, mark SKUs that were in stock yesterday but are missing today as 0. Or add a weekly full-catalog sweep: 527 pages ≈ 88 min, spread over cron ticks, with F1 keeping writes low.
- **F7 (retention):** keep raw snapshots for 90 days and roll older ones up to daily min/max per SKU/store. That caps storage at about 150 MB for A.

## 7. Bottom line

- **On this Workers Paid account, both A and B cost $0.00 extra per month.** A uses at most ~4% of any included allowance (D1 rows written); B uses ~2%.
- **The real financial risk is a bug, not normal operation:** about $140/mo for an every-minute cron, and over $1,000/mo for a runaway loop or an abused endpoint. **S1, S2, S4 and S6 bound the worst case to $0** and should ship before any cron is enabled.
- Implementing F1 to F5 and S1 to S6 is a small change. Recommended order:
  1. Caps (S1 to S6) and F5.
  2. Then enable Option B for a week, to measure the real change rate, CPU and rows written against this model.
  3. Then add Option A's jobs before the Nov 21, 2026 drop.

## 8. Re-measured after the caps + efficiency fixes (Option B live)

Measured locally against the mock DABS server: 700 in-stock items, 15 pages, the real code and schema, with `meta.rows_written` summed into `fetch_budget`.

| Sweep scenario (700 in-stock SKUs, 15 pages) | D1 rows written | KV writes | DABS requests |
|---|---|---|---|
| First-ever load (all SKUs new) | 4,986 (~7.1 per SKU) | 3 | 15 |
| **Nothing changed** | **86** (~5.7 per page of overhead: fetch_log, cursor, budget, lock) | 3 | 15 |
| 30 changed + 10 vanished | 206 (**+3 per changed or vanished SKU**: snapshot row + index + latest) | 3 | 15 |

The old code wrote ~7 rows per product every sweep, changed or not: 38,852 rows for the real catalog. It also made 3 KV writes per page.

**Real catalog (5,456 in stock, stride 48): 114 DABS requests per night, over 10 of the 12 cron ticks.**

| Option B per night | Before fixes | After fixes |
|---|---|---|
| DABS requests | 110 | 114 (a 2-row page overlap guards against list shift) |
| Worker invocations | 10 | 12 cron ticks (2 are cheap no-ops after completion) |
| D1 rows written | 38,852 | **~5.6k to 10.5k**: ~650 overhead + 3 × changed SKUs, assuming 30–60% change nightly (to be confirmed by the first week) |
| D1 rows written, first night only | — | ~39k (all SKUs new to `inventory_latest`) |
| KV writes | 340 | **~11** (1 per working tick + status) |
| Snapshot storage | 5,456 rows × 150 B ≈ 0.8 MB | changed rows only × **108 B** (single composite index) ≈ 0.2–0.35 MB |

| Option B per month | Before fixes | After fixes | Share of Paid included |
|---|---|---|---|
| D1 rows written | 1.17M | ~0.17M–0.32M | 0.3–0.6% of 50M |
| KV writes | 10.2k | ~0.33k | 0.03% of 1M |
| Worker invocations | 300 | 360 | <0.01% of 10M |
| Storage growth | ~25 MB | ~5–11 MB | — |
| **Incremental $** | $0.00 | **$0.00** | — |

**Worst case is now bounded by the caps.** Each of these was tested (see ai-context/DECISIONS.md):
- per-day caps: 700 DABS requests (1,600 on the 3rd Saturday), 250k D1 rows written, 3k KV writes, 60 runs (150 on drop day);
- platform limits: `cpu_ms` 5000, `subrequests` 300;
- a single-run lock;
- a cron allow-list.

The maximum possible month is therefore 7.5M D1 rows and 90k KV writes, well within the included allowances, so **the worst case is $0.00 extra**.

**Overshoot.** D1-row and KV caps are checked before every DABS request, so a run can overshoot by at most one page's writes. Tests showed +156 rows and +1 KV write.

**Capacity note:** since 2026-10-27 the window has 42 ticks × 12 pages × 48-row stride ≈ 24,000 in-stock items of capacity; a clean sweep of ~114 pages needs ~10 ticks (~53 min at the 10 s gap). Ticks that can't send a request (pause/backoff, retries not yet due) don't charge a run, so a long window doesn't eat the 60 runs/day cap that per-store also uses. Since 2026-10-30 per-store does the same (its paused/waiting ticks charge no run).

**TODO (not built):** 90-day retention/rollup (F7). Storage growth after the fixes is ~5–11 MB/month, so this is not urgent.

## 9. User-facing search (beta phase 2, 2026-10-21)

**What a user request costs.** User requests are served **only from D1, cached in the Cache API**:
- They never call DABS.
- They make **zero D1 writes and zero KV writes**. Cache API puts are free and don't touch KV.
- On a cache miss, the Workers Rate Limiting binding allows 60 misses per minute per IP, per data center.

**D1 rows read per request.** These are cache misses only. Hits read 0 rows. The figures come from Worker-reported `meta.rows_read`: local runs against a synthetic 5,457-product catalog shaped like tonight's sweep, plus live runs on today's 9-product data.

| Request (cache miss) | Rows read | Notes |
|---|---|---|
| Broad search (≥200 matches, e.g. "bourbon", "wine", type-only) | ~1,000 | Capped: only the first 200 FTS matches are joined and sorted |
| Broad search + "in stock only" or a store filter | ~1,400–1,650 | Filters are applied inside the 200-candidate set |
| Brand-level search ("buffalo trace", "eagle rare 10") | 80–550 | |
| No-match search / exact SKU | 2 | Primary-key lookup |
| Product page | 5–160 | ~3 per store row (≤52 stores) |
| Store page | 10–250 | Partial index on per-store rows |
| Status / coverage / store-list refresh | ~2.7k per data center | Status cached 5 min; store coverage and store list cached 1 h, so ~70k/day per data center |

There are no full-table scans per search. FTS5 (`product_search`) handles text, `inventory_latest` PK handles stock, and the partial index `idx_latest_store` handles store pages. Queries are capped at 80 characters and 6 tokens, pages at 10 × 20 results, and candidates at 200.

**Monthly estimate.** Model: one search plus 0.5 product views per "search", ~1,050 rows read, **0% cache hit rate** (worst case; real hit rates on repeated queries will be higher). Workers Paid includes **25 billion D1 rows read per month**, then $0.001 per million.

| Searches/day | D1 rows read/month | Share of included 25B | Worst case (all broad + filtered, ~1,700 rows) | Incremental $ |
|---|---|---|---|---|
| 1,000 | ~32M | 0.13% | ~51M (0.2%) | **$0.00** |
| 10,000 | ~315M | 1.3% | ~510M (2%) | **$0.00** |
| 100,000 | ~3.2B | 12.6% | ~5.1B (20%) | **$0.00** |

**Worker requests and CPU.** These are the only meter that can move at high traffic.
- **Requests per page view:** since item 4 (2026-10-21) `run_worker_first` is an array that bypasses the Worker for the exact static files (`/assets/style.css`, `/favicon.svg`, `/robots.txt`), so a page view is **1 Worker request** (the HTML), down from about 2–3 (HTML, CSS, favicon). Static-asset requests are free and unmetered on Workers. The estimate below counts HTML only, so it is unchanged.
- **Requests at 100k searches/day:** ×1.5 pages ≈ 11M requests/month. Paid includes 10M, then $0.30 per million, so about **$0.35/month** over the allowance. That is shared with other projects on the account.
- **CPU:** about 2–5 ms per HTML render, so roughly 20–25M CPU-ms/month at that volume. 30M is included.
- **At 1k–10k/day:** everything stays inside the included allowances.

**Fetcher write impact (measured on production D1).** The FTS triggers only fire when a product is new or its name or category changes.
- A new product costs **+2 rows written** (5 instead of 3).
- A no-op upsert still writes 0 rows.
- A price-only change writes 3 rows, with no FTS work.
- Tonight's first full sweep (~5.4k new products) adds about 11k rows, taking it from ~39k to ~50k. That is well under the 250k/day cap.
- Later nights add only a handful of rows (new listings).

## 10. Full-catalog import (monthly Product List XLSX, live 2026-10-22)

Measured on production (first import, 2026-10-22 8:24 AM MDT) and locally against a copy of production data.

| Item | First import | Typical month after |
|---|---|---|
| DABS requests | 2 (page + XLSX) | 2 when a new list is posted; +1 page check/day (days 2–8) while waiting; 0 once done |
| D1 rows written | **26,540** apply (5,308 new products × ~5.0: row, 2 indexes, FTS) + ~70 overhead | **~20–3,000**: 17 with nothing changed (measured), +3 per price/status change, +~5 per new or renamed product (e.g. 300 new + 300 changed ≈ 2.4k) |
| D1 rows read | ~10.8k (one products read) + ~5.4k (in-stock overlap guard) | same |
| KV writes | 2 (staged list + `last_request_at`) | 2 |
| CPU | **789 ms** for the whole download + parse + apply invocation (wrangler tail), under the 5,000 ms `limits.cpu_ms` | same |
| Wall time | 21 s (10 s polite gap + 11 s XLSX download + 8 s apply) | same |

- **Daily cap fit:** the first import day (Oct 22) totals 116 DABS requests / 700 and 70,835 D1 rows / 250,000 (sweep 44,224 + import ~26,611). The apply stops at 200k rows/day or 120k per run and resumes from the KV-staged list on the next tick (tested locally: partial at the 200k ceiling, then resumed with 0 DABS requests).
- **Monthly allowance share:** ≤ 30k of 50M D1 rows written (0.06%); 2–8 Worker invocations/month; < 1 s CPU of 30M ms. **$0.00 incremental.**
