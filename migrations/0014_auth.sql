-- 0014: email magic-link sign-in (watches design step 1, owner-approved t99s544, 2026-11-21). ADDITIVE ONLY.
-- No change to any fetcher, catalog, analytics or feedback table. Watches/alerts columns come with steps 2-3 (not here).
--   users          + terms_version, last_signin_at (email, age_confirmed_at already exist from 0001)
--   auth_tokens    one row per sign-in link: only SHA-256(token) is stored; email kept with the pending link; 15 min, single use;
--                  rows purged 24 h after created_at
--   sessions       only SHA-256(session cookie); 30 days absolute; max 5 per user
--   auth_hits      rate-limit hits: kind ip | email | verify; key = salted HMAC hash only (never the IP or address); purged 24 h
--   mail_log       non-feedback sends (signin now, alert later) for the shared daily email budget; no recipient stored
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN last_signin_at TEXT;

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  next        TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_created ON auth_tokens (created_at);
CREATE INDEX IF NOT EXISTS auth_tokens_email ON auth_tokens (email);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_hits (
  kind     TEXT NOT NULL CHECK (kind IN ('ip', 'email', 'verify')),
  key_hash TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_hits_key ON auth_hits (kind, key_hash, at);
CREATE INDEX IF NOT EXISTS auth_hits_at ON auth_hits (at);

CREATE TABLE IF NOT EXISTS mail_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('signin', 'alert')),
  ok      INTEGER NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS mail_log_day ON mail_log (day, kind, ok);
