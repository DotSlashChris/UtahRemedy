-- 0006: per-store verification time + B1 (allocated per-store refresh) daily state. ADDITIVE ONLY.
--
-- inventory_latest.verified_at (per-store rows, store_key <> ''): the last time a VALIDATED store-detail
-- fetch confirmed this row's value, whether or not it changed. observed_at keeps meaning "last change".
-- NULL = never verified by a validated fetch since 0006; readers fall back to observed_at.
-- Not indexed (no index write when it is updated).
ALTER TABLE inventory_latest ADD COLUMN verified_at TEXT;

-- One row per Mountain-time day for the B1 job (runs after that day's nightly sweep completes).
-- queue = comma-separated SKUs frozen at the first tick; next_idx = cursor into queue.
CREATE TABLE IF NOT EXISTS perstore_state (
  day                  TEXT PRIMARY KEY,
  status               TEXT NOT NULL,          -- running | complete | failed | skipped | capped
  queue                TEXT NOT NULL DEFAULT '',
  total                INTEGER NOT NULL DEFAULT 0,
  next_idx             INTEGER NOT NULL DEFAULT 0,
  ok                   INTEGER NOT NULL DEFAULT 0,
  failed               INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  stores_verified      INTEGER NOT NULL DEFAULT 0,
  stores_changed       INTEGER NOT NULL DEFAULT 0,
  requests             INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  started_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  completed_at         TEXT
);
