-- Utah Remedy: hard caps + efficiency (2026-10-21).
-- 1) Rebuild inventory_snapshots: no AUTOINCREMENT (saves the sqlite_sequence write),
--    single composite index (sku, store_id, observed_at) instead of two, `inferred` flag,
--    no FK constraints (snapshots are an append-only log; FKs made rebuilds painful).
-- 2) Rebuild fetch_log: no AUTOINCREMENT, one index.
-- 3) New: inventory_latest (current stock, change detection), fetch_budget (daily caps),
--    fetch_lock (single-run lock), sweep_state (nightly sweep cursor).
PRAGMA defer_foreign_keys = true;

CREATE TABLE inventory_snapshots_new (
  id               INTEGER PRIMARY KEY,
  sku              TEXT NOT NULL,
  store_id         TEXT,                 -- NULL = product-level (warehouse + statewide store total)
  quantity         INTEGER,              -- warehouse qty (product-level) or store qty
  store_total_qty  INTEGER,
  on_order_qty     INTEGER,
  source           TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  fetch_id         INTEGER,
  inferred         INTEGER NOT NULL DEFAULT 0   -- 1 = inferred (e.g. vanished from a complete in-stock sweep)
);
INSERT INTO inventory_snapshots_new (id, sku, store_id, quantity, store_total_qty, on_order_qty, source, observed_at, fetch_id)
  SELECT id, sku, store_id, quantity, store_total_qty, on_order_qty, source, observed_at, fetch_id FROM inventory_snapshots;
DROP TABLE inventory_snapshots;
ALTER TABLE inventory_snapshots_new RENAME TO inventory_snapshots;
CREATE INDEX idx_inv_sku_store_time ON inventory_snapshots(sku, store_id, observed_at);

CREATE TABLE fetch_log_new (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  query         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  http_status   INTEGER,
  item_count    INTEGER,
  duration_ms   INTEGER,
  error         TEXT
);
INSERT INTO fetch_log_new SELECT id, source, kind, query, started_at, finished_at, status, http_status, item_count, duration_ms, error FROM fetch_log;
DROP TABLE fetch_log;
ALTER TABLE fetch_log_new RENAME TO fetch_log;
CREATE INDEX idx_fetch_log_source_time ON fetch_log(source, started_at);

-- Current stock per (sku, store). store_key '' = product-level row.
CREATE TABLE inventory_latest (
  sku              TEXT NOT NULL,
  store_key        TEXT NOT NULL,
  quantity         INTEGER,
  store_total_qty  INTEGER,
  on_order_qty     INTEGER,
  observed_at      TEXT NOT NULL,        -- when this value was first observed (last change)
  inferred         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sku, store_key)
) WITHOUT ROWID;
INSERT INTO inventory_latest (sku, store_key, quantity, store_total_qty, on_order_qty, observed_at)
  SELECT s.sku, COALESCE(s.store_id, ''), s.quantity, s.store_total_qty, s.on_order_qty, s.observed_at
  FROM inventory_snapshots s
  WHERE s.id = (SELECT MAX(s2.id) FROM inventory_snapshots s2 WHERE s2.sku = s.sku AND COALESCE(s2.store_id,'') = COALESCE(s.store_id,''));

-- Daily caps (America/Denver calendar day).
CREATE TABLE fetch_budget (
  day              TEXT PRIMARY KEY,     -- YYYY-MM-DD (America/Denver)
  dabs_requests    INTEGER NOT NULL DEFAULT 0,
  d1_rows_written  INTEGER NOT NULL DEFAULT 0,
  kv_writes        INTEGER NOT NULL DEFAULT 0,
  runs             INTEGER NOT NULL DEFAULT 0,
  exhausted_reason TEXT,
  exhausted_at     TEXT,
  updated_at       TEXT
);

-- Single-run lock (covers cron and the admin endpoint).
CREATE TABLE fetch_lock (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Nightly in-stock sweep cursor (one row per America/Denver day).
CREATE TABLE sweep_state (
  day              TEXT PRIMARY KEY,
  status           TEXT NOT NULL,        -- running | complete | failed
  next_start       INTEGER NOT NULL DEFAULT 0,
  pages_done       INTEGER NOT NULL DEFAULT 0,
  total_first      INTEGER,
  total_last       INTEGER,
  seen             TEXT NOT NULL DEFAULT '',  -- comma-separated SKUs seen (for vanish detection)
  degraded         TEXT,                 -- reason vanish inference is not allowed (e.g. total drift)
  vanished_applied INTEGER,
  vanish_skipped   TEXT,
  error            TEXT,
  started_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT
);
