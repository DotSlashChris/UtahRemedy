-- 0008: per-store transient-5xx retry bookkeeping (owner-approved 2026-10-23). ADDITIVE ONLY (nullable / DEFAULT 0 columns).
--
-- A single temporary 5xx (e.g. Cloudflare 522) on one SKU is requeued later in the same window instead of tripping the 1 h
-- DABS backoff. Per-SKU limit 3 retries/day; global limit PERSTORE_RETRY_REQUEST_LIMIT (40) DABS requests/day spent on retries
-- (retry_requests below). See src/fetchers/perstore.ts and DECISIONS.md.
--   retry_json        {"pending":[{"sku","n","due"}],"streak":[distinct SKUs hit by 5xx in a row]}
--   retried           retry attempts executed today
--   recovered         SKUs that succeeded on a retry
--   retry_requests    actual DABS requests spent on retry attempts today (the global daily retry counter)
--   transient_errors  transient 5xx responses seen today (first tries + retries)
--   skipped           queued SKUs never checked when the row was closed (window ended / capped / failed / popular stopped)
-- status gains two terminal values: 'window_ended' (last tick of the window reached with work left) and 'expired'
-- (a stale 'running' row closed by a later day's tick). status is free TEXT, so no schema change is needed for them.
ALTER TABLE perstore_state ADD COLUMN retry_json TEXT;
ALTER TABLE perstore_state ADD COLUMN retried INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN retry_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN transient_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE perstore_state ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
