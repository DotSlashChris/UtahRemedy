-- 0010: sweep page rest + failed-page response times (owner-approved 2026-10-28). ADDITIVE ONLY (nullable / DEFAULT 0 columns).
--
-- A sweep page that has used its 3 transient retries no longer fails the sweep: it RESTS 30 min and is re-queued for one
-- more attempt (repeated until the 10:55 UTC hard stop). Every attempt still counts against the 20 sweep retry requests/day.
--   sweep_state.rest_cycles         rest periods started today (all pages)
--   sweep_state.page_failures_json  {"<start>": {"fails", "rests", "last_status", "last_ms", "max_ms", "ms": [last 8 response times], "at"}}
--                                   every failed sweep page attempt today (5xx, timeout, other), for the daily status
--   fetch_log.response_ms           DABS response time of a sweep page request (send -> response/error), excluding the 10 s gap
ALTER TABLE sweep_state ADD COLUMN rest_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sweep_state ADD COLUMN page_failures_json TEXT;
ALTER TABLE fetch_log ADD COLUMN response_ms INTEGER;
