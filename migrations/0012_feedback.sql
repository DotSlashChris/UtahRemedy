-- 0012: public feedback form + bot triage endpoints (owner-approved 2026-11-12, matches the Agenda Watch feedback design).
-- ADDITIVE ONLY: new tables, no change to any fetcher/catalog/analytics table. See src/feedback.ts and DECISIONS.md (2026-11-12).
--
--   feedback              one row per stored (non-spam) submission. user_id comes ONLY from a signed-in session; Utah Remedy has
--                         no sign-in yet, so it is always NULL. Reply address = account email if signed in, else the typed email.
--                         status: new | needs-owner ("needs you") | replied | reviewed.
--   feedback_hits         per-IP hourly limit (5/hour). IPs are stored ONLY as a salted HMAC hash; rows older than 1 h are purged.
--   feedback_spam         short sample of quietly dropped submissions (reason + 200-char snippet), purged after 14 days, max 300 rows.
--   feedback_mail_log     every notice/reply send attempt (ok or error) per Utah day: daily caps + quota reserve + audit trail.
--   feedback_reply_lock   one row per item while/after a reply is sent, so a reply can never go out twice.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  user_id     TEXT,
  email       TEXT,
  category    TEXT NOT NULL,
  city        TEXT,
  link        TEXT,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'needs-owner', 'replied', 'reviewed')),
  replied_at  TEXT,
  reply_text  TEXT,
  owner_note  TEXT
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback (status, created_at);

CREATE TABLE IF NOT EXISTS feedback_hits (
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_hits_ip ON feedback_hits (ip_hash, at);

CREATE TABLE IF NOT EXISTS feedback_spam (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  reason   TEXT NOT NULL,
  ip_hash  TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  snippet  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS feedback_spam_at ON feedback_spam (at);

CREATE TABLE IF NOT EXISTS feedback_mail_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  day         TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('notice', 'reply')),
  feedback_id INTEGER,
  ok          INTEGER NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS feedback_mail_day ON feedback_mail_log (day, ok);

CREATE TABLE IF NOT EXISTS feedback_reply_lock (
  feedback_id INTEGER PRIMARY KEY,
  at          TEXT NOT NULL
);
