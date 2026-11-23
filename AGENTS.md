# AGENTS.md

Rules for any AI agent working on Utah Remedy. Read `ai-context/README.md` next (reading order, handoff, memory, decision log).

## Non-negotiables
- Keep the 21+ age gate and the DABS disclaimers (not affiliated with DABS; counts can lag; verify with the store).
- Fail closed: incomplete or invalid DABS data writes nothing. Only the documented narrow exceptions (missing-store rule, empty list at statewide 0) apply.
- Worst case stays at or under 500 combined DABS requests a day. Caps, gaps, pauses, the 429 rule, fail-closed behavior and windows change only with explicit owner approval.
- One step at a time: recommend, wait for approval, then confirm when it is live.
- Never print or commit secrets, tokens, passwords, the owner's IP or personal details. Secrets go to `wrangler secret put` on stdin.
- No unsolicited growth actions. A daily status goes to the owner every day (`ai-context/ROUTINES.md`).

## Testing by scope
- UI-only change: `npm run typecheck`, `scripts/test-feedback.py`, `scripts/test-auth.py a b c`, `scripts/test-mail-budget.ts` (+ `test-tip-qr.ts` for tips).
- Data jobs, schedules, caps or DABS request logic: also the per-store and sweep/catch-up suites, each as a separate job.
- Details: `README.md` "Tests".

## Deploy and workflow
- Branch, then pull request to `main`. Update `ai-context/DECISIONS.md` and `ai-context/HANDOFF.md` in the same PR.
- After the owner merges: deploy from `main` with `npm run deploy` (never `wrangler deploy` directly), then verify `/health` and the change.
