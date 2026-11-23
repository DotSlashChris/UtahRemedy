# ai-context: project memory for AI agents

This folder holds everything an AI assistant (or a new human maintainer) needs to pick up Utah Remedy where the last one left off: the owner's rules, the assistant's saved memory, every approved decision, the current state, recurring routines, and the product plan. The code itself is documented in the repo `README.md` and `docs/`.

Nothing here is secret. Secrets live only in Cloudflare (`wrangler secret put`); this folder lists their **names** only. Never add personal details (owner name, personal email, address, phone, IPs) or any secret value.

## Reading order for a new AI

1. `../AGENTS.md`: the short non-negotiables (one page).
2. `HANDOFF.md`: current state, what is live, what is pending or waiting on an owner decision, how to test and deploy, gotchas.
3. `ASSISTANT-MEMORY.md`: the previous assistant's durable memory (working rules, product rules, caps, analytics and feedback guardrails). Newer facts win.
4. `ROUTINES.md`: the recurring jobs the assistant runs outside the Worker (daily status, scheduled check-ins).
5. `DECISIONS.md`: the full dated decision log. Read the newest sections first; search it before changing anything it covers.
6. `WATCHES-DESIGN.md`: design for sign-in, bottle watches and email alerts (built in separately approved steps).
7. `plan/`: the original project description, plan and design outline.
8. Then the code docs: `../README.md`, `../docs/OPERATIONS.md`, `../docs/DATA-SOURCES.md`.

## Keeping it current

Update this folder in the same pull request as every approved change:

- `DECISIONS.md`: add a dated section: why, what changed, what did not change, tests run (by scope), deploy commit / worker version / time in America/Denver, live checks.
- `HANDOFF.md`: update "Current state" and "Pending" whenever something goes live, is approved, or is put on hold.
- `ASSISTANT-MEMORY.md`: add or correct durable rules and facts the owner gives (scrubbed of personal details).
- `ROUTINES.md`: when a routine is created, changed or retired.

Owner message ids like `t94u` or `t99s544` in these files refer to the owner's chat with the assistant; they are kept so decisions stay traceable.
