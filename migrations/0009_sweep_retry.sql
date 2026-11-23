-- 0009: nightly-sweep transient-5xx retry bookkeeping (owner-approved 2026-10-25). ADDITIVE ONLY (nullable / DEFAULT 0 columns).
--
-- A single temporary 5xx (500, 502-504, 520-527) on one sweep page is requeued later in the same 08:00-08:55 UTC window
-- instead of failing the sweep. Per-page limit 3 retries/day; global limit SWEEP_RETRY_REQUEST_LIMIT (20) DABS requests/day
-- spent on sweep retries (separate from per-store's 40). See src/fetchers/sweep.ts and DECISIONS.md.
--   retry_json        {"pending":[{"start","n","due"}],"streak":[distinct page starts hit by 5xx in a row]}
--   retried           retry attempts executed today
--   recovered         pages that succeeded on a retry
--   retry_requests    DABS requests spent on retry attempts today (1 per page retry)
--   transient_errors  transient 5xx responses seen today (first tries + retries)
ALTER TABLE sweep_state ADD COLUMN retry_json TEXT;
ALTER TABLE sweep_state ADD COLUMN retried INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sweep_state ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sweep_state ADD COLUMN retry_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sweep_state ADD COLUMN transient_errors INTEGER NOT NULL DEFAULT 0;
