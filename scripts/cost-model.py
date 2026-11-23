#!/usr/bin/env python3
"""Utah Remedy fetcher usage/cost model. Per-op costs were MEASURED on 2026-10-21
(D1 meta.rows_read/rows_written on the real schema; KV/subrequest counts from the code
in src/fetchers/dabs-locator.ts; CPU from scripts timing the real parsers under Node 22)."""
import math

# ---- measured per-operation costs ----
D1 = dict(prod_upsert_w=3, prod_upsert_r=1, snap_w=4, snap_r=3, store_upsert_w=1, store_upsert_r=3, log_w=6, log_r=4)
KV_TABLE_W, KV_TABLE_R = 3, 2      # last_request_at put, cache put, lastTotal put / cache get, lastTotal get
KV_DETAIL_W, KV_DETAIL_R = 3, 1    # 2x last_request_at put, cache put / cache get
KV_RUN_W, KV_RUN_R = 1, 3          # setStatus put / backoff get, setStatus get, last_request_at get
SUB_TABLE, SUB_DETAIL, SUB_RUN = 9, 9, 4   # subrequests (fetch + KV + D1) per table page / detail SKU / run
CPU_MS_PER_INVOCATION = 15         # conservative; measured parse cost is ~0.12 ms per 50-row page, ~0.4-0.6 ms per detail page
BYTES_PER_SNAPSHOT = 150           # measured 143 B incl. both indexes (200k-row SQLite test)
REQ_CAP = 12                       # MAX_REQUESTS_PER_RUN in code

# ---- prices (Workers Paid), from Cloudflare docs fetched 2026-10-21 ----
P = dict(req_incl=10e6, req_per_m=0.30, cpu_incl=30e6, cpu_per_m=0.02,
         d1_r_incl=25e9, d1_r_per_m=0.001, d1_w_incl=50e6, d1_w_per_m=1.00, d1_gb_incl=5, d1_gb=0.75,
         kv_r_incl=10e6, kv_r_per_m=0.50, kv_w_incl=1e6, kv_w_per_m=5.00)

def day(table_pages, products, detail_skus, stores_per_detail, other_req=0, runs=None):
    req = table_pages + 2 * detail_skus + other_req
    inv = runs if runs is not None else math.ceil(table_pages / REQ_CAP) + math.ceil(2 * detail_skus / REQ_CAP) + (1 if other_req else 0)
    snaps = products + detail_skus * stores_per_detail
    attempts = table_pages + detail_skus + other_req
    w = products * (D1["prod_upsert_w"] + D1["snap_w"]) + detail_skus * stores_per_detail * (D1["store_upsert_w"] + D1["snap_w"]) + attempts * D1["log_w"]
    r = products * (D1["prod_upsert_r"] + D1["snap_r"]) + detail_skus * stores_per_detail * (D1["store_upsert_r"] + D1["snap_r"]) + attempts * D1["log_r"] + detail_skus * 5
    kvw = table_pages * KV_TABLE_W + detail_skus * KV_DETAIL_W + inv * KV_RUN_W
    kvr = table_pages * KV_TABLE_R + detail_skus * KV_DETAIL_R + inv * KV_RUN_R
    sub_max = min(REQ_CAP, table_pages) * SUB_TABLE + SUB_RUN if table_pages else (REQ_CAP // 2) * SUB_DETAIL + SUB_RUN
    return dict(dabs_req=req, invocations=inv, d1_w=w, d1_r=r, kv_w=kvw, kv_r=kvr, snaps=snaps, cpu_ms=inv * CPU_MS_PER_INVOCATION, sub_max=sub_max)

def add(*ds): return {k: sum(d[k] for d in ds) if k != "sub_max" else max(d[k] for d in ds) for k in ds[0]}

sweep = day(110, 5456, 0, 0)                                    # nightly in-stock sweep, 50/page
watch = day(7 * 26, 7 * 75, 0, 0, runs=7 * math.ceil(26 / REQ_CAP))   # 7 runs x (status=A page + 25 watched SKU lookups)
detail = day(0, 0, 100, 45)                                     # store detail cap 100 SKUs/day, ~45 stores listed each
alloc_page = dict(dabs_req=1, invocations=1, d1_w=6, d1_r=4, kv_w=2, kv_r=3, snaps=0, cpu_ms=15, sub_max=6)
drop_extra = day(28, 28 * 50, 28 * 15, 40, runs=28 * math.ceil(31 / REQ_CAP))  # 15-min cycles 07-14: A page + 15 SKUs detail

B_day = sweep
A_day = add(sweep, watch, detail, alloc_page)
A_drop = add(A_day, drop_extra)
B_month = {k: v * 30 for k, v in B_day.items()}; B_month["sub_max"] = B_day["sub_max"]
A_month = {k: A_day[k] * 29 + A_drop[k] + (65 if k == "dabs_req" else 0) for k in A_day}; A_month["sub_max"] = A_drop["sub_max"]

def cost(m, storage_gb_month):
    over = lambda used, incl, per_m: max(0, used - incl) / 1e6 * per_m
    parts = dict(workers_req=over(m["invocations"], P["req_incl"], P["req_per_m"]), workers_cpu=over(m["cpu_ms"], P["cpu_incl"], P["cpu_per_m"]),
                 d1_rows_read=over(m["d1_r"], P["d1_r_incl"], P["d1_r_per_m"]), d1_rows_written=over(m["d1_w"], P["d1_w_incl"], P["d1_w_per_m"]),
                 d1_storage=max(0, storage_gb_month - P["d1_gb_incl"]) * P["d1_gb"],
                 kv_reads=over(m["kv_r"], P["kv_r_incl"], P["kv_r_per_m"]), kv_writes=over(m["kv_w"], P["kv_w_incl"], P["kv_w_per_m"]))
    return parts, sum(parts.values())

if __name__ == "__main__":
    rows = [("B / day", B_day), ("A / normal day", A_day), ("A / drop Saturday", A_drop), ("B / month", B_month), ("A / month", A_month)]
    keys = ["dabs_req", "invocations", "sub_max", "cpu_ms", "d1_w", "d1_r", "kv_w", "kv_r", "snaps"]
    print("| scenario | " + " | ".join(keys) + " |"); print("|---" * (len(keys) + 1) + "|")
    for n, d in rows: print(f"| {n} | " + " | ".join(f"{d[k]:,}" for k in keys) + " |")
    for n, m in (("B", B_month), ("A", A_month)):
        gb = m["snaps"] * BYTES_PER_SNAPSHOT / 1e9
        print(f"{n}: storage growth {gb*1000:.1f} MB/month; year-1 ~{gb*12:.2f} GB")
        print(f"{n}: overage $ (Utah Remedy alone, vs full included allowances)", cost(m, gb * 12))
    # worst cases
    page = day(REQ_CAP, REQ_CAP * 50, 0, 0)                          # one capped invocation
    w1 = {k: page[k] * 1440 * 30 for k in page}                       # cron every minute, caps intact
    print("W1 (every-minute cron, per-run cap intact) month:", {k: f"{w1[k]:,}" for k in ("dabs_req", "d1_w", "kv_w", "invocations")}, cost(w1, 0))
    big = day(90, 90 * 50, 0, 0, runs=1)                              # runaway: no per-run cap, 10 s gap -> ~90 req in 15 min wall
    w2 = {k: big[k] * 1440 * 30 for k in big}
    print("W2 (runaway loop, no per-run cap, every-minute cron overlapping) month:", {k: f"{w2[k]:,}" for k in ("dabs_req", "d1_w", "kv_w", "invocations")}, cost(w2, 0))
    capped = dict(dabs_req=0, invocations=0, cpu_ms=0, d1_r=250_000 * 30, d1_w=250_000 * 30, kv_w=3_000 * 30, kv_r=10_000 * 30)
    print("With proposed daily budgets (250k D1 rows written, 3k KV writes, 1,600 DABS req/day) worst month:", cost(capped, 0))
