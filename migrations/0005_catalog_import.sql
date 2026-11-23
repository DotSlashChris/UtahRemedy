-- Full-catalog import from the DABS monthly Product List XLSX (owner-approved 2026-10-22). ADDITIVE ONLY.
-- products.data_source: NULL = written by the live Product Locator (authoritative; the catalog import never
-- touches these rows), 'catalog' = known only from the monthly product list (no quantities). A locator write
-- claims a catalog row by setting data_source back to NULL.
ALTER TABLE products ADD COLUMN data_source TEXT;

-- One row per America/Denver calendar month (YYYY-MM). Cursor for chunked, resumable apply.
CREATE TABLE catalog_import (
  period        TEXT PRIMARY KEY,            -- YYYY-MM (America/Denver)
  status        TEXT NOT NULL,               -- applying | complete | waiting | failed
  attempts      INTEGER NOT NULL DEFAULT 0,  -- download attempts this period (failed/waiting retry at most once per day, max 3 failures)
  file_url      TEXT,
  last_modified TEXT,
  etag          TEXT,
  bytes         INTEGER,
  row_count     INTEGER,
  next_index    INTEGER NOT NULL DEFAULT 0,  -- apply cursor into the staged list (KV dabs:v1:catalog:staged:<period>)
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  unchanged     INTEGER NOT NULL DEFAULT 0,
  skipped_live  INTEGER NOT NULL DEFAULT 0,  -- SKUs owned by the live locator (left untouched)
  rows_written  INTEGER NOT NULL DEFAULT 0,  -- D1 rows written by apply (metered)
  error         TEXT,
  started_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
