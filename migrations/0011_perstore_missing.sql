-- 0011: per-store missing-store acceptance rule (owner-approved 2026-11-02). ADDITIVE ONLY (new table + nullable / DEFAULT 0 columns).
--
-- Narrow exception to fail-closed: a per-store list whose ONLY problem is that stores we hold with stock are absent (clean 200,
-- parsed, no duplicate stores, quantities add up EXACTLY to the sweep's statewide store count) is accepted when every absent store
-- was also absent for that SKU on the previous Utah (America/Denver) day. The listed stores are written as a normal ok and each
-- absent store is written as qty 0, inferred=1, inferred_reason = why. Anything else (first-day missing, total mismatch,
-- duplicates, parse problems) still writes nothing. See src/fetchers/perstore.ts and DECISIONS.md (2026-11-02).
--
--   perstore_missing           one row per (sku, Utah day) whenever "stores missing" was the ONLY validation failure.
--     stores_json              JSON array of the absent store ids (all of them, sorted)
--     outcome                  'held' (fail closed, nothing written) | 'accepted_inferred' (absent stores zeroed, inferred)
--     source                   'perstore' (written by the per-store pass) | 'backfill' (2026-11-02 one-off from fetch_log error text)
--   inventory_latest.inferred_reason   why a per-store row is an inferred value (NULL for observed values)
--   perstore_state counters (per Utah day, SKUs unless noted):
--     accepted_inferred        lists accepted under the rule;  inferred_stores = absent stores zeroed by it (stores)
--     held_first_day_missing   missing-store-only lists held (a store absent for the first time / not absent the previous day)
--     qty_mismatch_above/below list sum above / below the sweep's statewide store count
--     dup_parse                duplicate store ids, unparseable / wrong-shape page, or no statewide count to check against
--     transient_exhausted      522/5xx/timeout with all 3 per-SKU retries used (failed for the day)
--     retry_cap_dropped        pending retries failed because the 40 retry requests/day cap was reached
--     other_failed             other failures (429 / hard 4xx-5xx / non-timeout network errors)
--   fetch_log.category         per-store failure/outcome category for the row (NULL for other kinds)
CREATE TABLE IF NOT EXISTS perstore_missing (
  sku          TEXT NOT NULL,
  day          TEXT NOT NULL,
  stores_json  TEXT NOT NULL,
  listed       INTEGER,
  list_sum     INTEGER,
  statewide    INTEGER,
  outcome      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'perstore',
  fetch_id     INTEGER,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (sku, day)
);
ALTER TABLE inventory_latest ADD COLUMN inferred_reason TEXT;
ALTER TABLE perstore_state ADD COLUMN accepted_inferred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN inferred_stores INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN held_first_day_missing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN qty_mismatch_above INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN qty_mismatch_below INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN dup_parse INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN transient_exhausted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN retry_cap_dropped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN other_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fetch_log ADD COLUMN category TEXT;
