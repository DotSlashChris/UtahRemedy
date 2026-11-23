-- 0013: automatic same-day catch-up for incomplete nightly sweeps (owner-approved 2026-11-13, t79u). ADDITIVE ONLY.
-- sweep_state.catchup_status: NULL (nothing to catch up) | queued (nightly window ended with pages unfinished) | running |
--   complete | failed | skipped. See src/fetchers/catchup.ts and DECISIONS.md (2026-11-13).
ALTER TABLE sweep_state ADD COLUMN catchup_status TEXT;
ALTER TABLE sweep_state ADD COLUMN catchup_note TEXT;              -- nightly error at queue time / why skipped
ALTER TABLE sweep_state ADD COLUMN catchup_started_at TEXT;
ALTER TABLE sweep_state ADD COLUMN catchup_finished_at TEXT;
ALTER TABLE sweep_state ADD COLUMN catchup_base_requests INTEGER;   -- today's DABS requests when the catch-up started
ALTER TABLE sweep_state ADD COLUMN catchup_end_requests INTEGER;    -- today's DABS requests after the last catch-up sweep tick
ALTER TABLE sweep_state ADD COLUMN catchup_base_pages INTEGER;      -- pages_done / retry_requests / transient_errors at start
ALTER TABLE sweep_state ADD COLUMN catchup_base_retry INTEGER;
ALTER TABLE sweep_state ADD COLUMN catchup_base_transients INTEGER;
ALTER TABLE sweep_state ADD COLUMN catchup_unfinished INTEGER;      -- pages queued (unattempted + failed/pending) at start
-- Follow-on per-store pass: NULL | running | done | not_needed | skipped (+ reason in catchup_perstore_note).
ALTER TABLE sweep_state ADD COLUMN catchup_perstore TEXT;
ALTER TABLE sweep_state ADD COLUMN catchup_perstore_note TEXT;
-- perstore_state rows created by a catch-up pass (1) vs the normal 04:00-10:55 MST window (0).
ALTER TABLE perstore_state ADD COLUMN catchup INTEGER NOT NULL DEFAULT 0;
