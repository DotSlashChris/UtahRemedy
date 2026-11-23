-- Utah Remedy — data-source prototype support.
-- fetch_log: every fetch attempt (network or cache) for freshness/error reporting.

CREATE TABLE fetch_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,                 -- e.g. dabs-locator
  kind          TEXT NOT NULL,                 -- product_table | store_detail
  query         TEXT,                          -- normalized query key
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,                 -- ok | cache_hit | http_error | network_error | invalid_shape | empty | suspicious | skipped
  http_status   INTEGER,
  item_count    INTEGER,
  duration_ms   INTEGER,
  error         TEXT
);
CREATE INDEX idx_fetch_log_source_time ON fetch_log(source, started_at);
CREATE INDEX idx_fetch_log_status_time ON fetch_log(status, started_at);

-- Fields the DABS product locator exposes that the skeleton lacked.
ALTER TABLE products ADD COLUMN status_label TEXT;
ALTER TABLE products ADD COLUMN on_spa INTEGER;

-- Product-level snapshots (store_id NULL) also carry statewide store total and on-order qty.
ALTER TABLE inventory_snapshots ADD COLUMN store_total_qty INTEGER;
ALTER TABLE inventory_snapshots ADD COLUMN on_order_qty INTEGER;
ALTER TABLE inventory_snapshots ADD COLUMN fetch_id INTEGER REFERENCES fetch_log(id);
