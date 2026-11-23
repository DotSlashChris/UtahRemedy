-- Utah Remedy — initial schema skeleton (Phase 0).
-- Mirrors the design outline's high-level data model. Tables are intentionally
-- minimal; later phases will add columns/indexes via new migrations.

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,               -- uuid
  email              TEXT UNIQUE,
  age_confirmed_at   TEXT,                           -- ISO-8601 UTC
  notify_email       INTEGER NOT NULL DEFAULT 1,
  notify_push        INTEGER NOT NULL DEFAULT 0,
  notify_sms         INTEGER NOT NULL DEFAULT 0,
  remedies_balance   INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE products (
  sku                TEXT PRIMARY KEY,               -- DABS SKU / CSC
  name               TEXT NOT NULL,
  brand              TEXT,
  category           TEXT,
  status             TEXT,                           -- e.g. general, allocated, limited, special-order
  price_cents        INTEGER,
  size_ml            INTEGER,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_products_category ON products(category);

CREATE TABLE stores (
  id                 TEXT PRIMARY KEY,               -- DABS store number
  name               TEXT NOT NULL,
  address            TEXT,
  city               TEXT,
  phone              TEXT,
  lat                REAL,
  lng                REAL,
  hours_json         TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE inventory_snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                TEXT NOT NULL REFERENCES products(sku),
  store_id           TEXT REFERENCES stores(id),     -- NULL = warehouse
  quantity           INTEGER,
  source             TEXT NOT NULL,                  -- e.g. dabs-public
  observed_at        TEXT NOT NULL
);
CREATE INDEX idx_inv_sku_time ON inventory_snapshots(sku, observed_at);
CREATE INDEX idx_inv_store_time ON inventory_snapshots(store_id, observed_at);

CREATE TABLE user_reports (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT REFERENCES users(id),
  sku                TEXT NOT NULL REFERENCES products(sku),
  store_id           TEXT NOT NULL REFERENCES stores(id),
  status             TEXT NOT NULL CHECK (status IN ('in_stock','sold_out','just_saw_it')),
  photo_key          TEXT,
  quality_score      REAL,
  moderation_status  TEXT NOT NULL DEFAULT 'pending',
  reported_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reports_sku_time ON user_reports(sku, reported_at);

CREATE TABLE watches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT NOT NULL REFERENCES users(id),
  kind               TEXT NOT NULL CHECK (kind IN ('product','brand','category','status')),
  criteria_json      TEXT NOT NULL,
  filters_json       TEXT,                           -- store/location filters
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_watches_user ON watches(user_id);

CREATE TABLE alerts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id           INTEGER REFERENCES watches(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel            TEXT NOT NULL,                  -- email, push, sms
  payload_json       TEXT,
  status             TEXT NOT NULL DEFAULT 'queued', -- queued, sent, failed
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at       TEXT
);
CREATE INDEX idx_alerts_user_time ON alerts(user_id, created_at);

CREATE TABLE concierge_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT NOT NULL REFERENCES users(id),
  sku                TEXT,
  product_desc       TEXT,
  cases              INTEGER NOT NULL DEFAULT 1,      -- full cases only
  status             TEXT NOT NULL DEFAULT 'started',
  fee_cents          INTEGER,
  fee_waived         INTEGER NOT NULL DEFAULT 0,      -- waived with Remedies
  expected_ready_at  TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE remedies_transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT NOT NULL REFERENCES users(id),
  delta              INTEGER NOT NULL,               -- + earned, - redeemed
  reason             TEXT NOT NULL,
  ref_type           TEXT,                           -- e.g. user_report, concierge_request
  ref_id             TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_remedies_user ON remedies_transactions(user_id, created_at);
