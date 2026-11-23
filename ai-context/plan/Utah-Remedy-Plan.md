# Utah Remedy — Plan

## Phases

### Phase 0 — Foundation (immediate)
- Lock name: Utah Remedy. Points: Remedies. Service: Concierge.
- Register domain on Cloudflare (preferred: utahremedy.com or similar available .com/.app).
- Age gate, disclaimers, basic legal pages.
- Data source inventory: public DABS product locator, allocated/rare pages, special-order process, any structured exports.
- Respectful polling design + caching strategy (avoid bans).

### Phase 1 — Core Beta (website + PWA)
1. Product search and current inventory views.
2. User accounts (minimal), watches with free-tier limit.
3. Notification pipeline (email first; web push and SMS later).
4. Crowdsourced report flow + basic Remedies earning.
5. Allocated drop calendar and rare-drawing alerts.
6. Concierge special-order guided flow (service fee, tracking).
7. Admin dashboard (usage, health, data freshness, errors).
8. Intelligent caching layer.

### Phase 2 — Intelligence & Polish
- Predictive drop signals (warehouse patterns, historical store delivery tendencies).
- “Best chance near me” ranking.
- Improved report quality signals and moderation.
- Better mobile web experience / PWA.
- Tip jar integration.

### Phase 3 — Fast Followers
- Case-splitting with escrow and coordinated store meetup (social).
- Native apps if web traction justifies.
- Paid subscription only after free watch limit generates clear demand.

## Beta Scope Priorities (must-have)
- Age gate + disclaimers
- Search + inventory + watches + notifications
- Stock reports + Remedies
- Allocated/rare alerts
- Concierge special-order facilitation
- Admin health/usage view
- Cloudflare hosting + scheduled jobs

## Technology Stack (aligned with existing Quazarplex projects)
- **Hosting / DNS / domain:** Cloudflare
- **Runtime:** Cloudflare Workers (scheduled Cron Triggers for data collection, matching, notifications)
- **Frontend:** Cloudflare Pages or Workers with static assets (or similar modern stack consistent with other projects)
- **Storage:** Cloudflare D1 (relational) and/or KV (caching)
- **Notifications:** Email (existing patterns); web push; SMS via provider later
- **Payments (Concierge fee / tip jar):** Stripe (test mode first, consistent with Agenda Watch) or simple Cash App link for tips
- **Auth:** Minimal (email magic link or similar); age confirmation
- **Observability:** Cloudflare logs + custom admin dashboard

## Data Strategy
- Prefer public structured sources, APIs, or exportable lists over heavy scraping.
- Cache aggressively; refresh on intelligent schedules (more frequent around drop windows).
- User reports supplement official data for freshness.
- Fail closed: if fetch fails, do not send false alerts; log and surface in admin.
- Rate-limit and respect robots/ToS; rotate carefully if needed; never hammer endpoints.

## Freemium
- Free: limited number of watches (exact number TBD, start conservative e.g. 5–10).
- No paid subscription in beta.
- Add subscription later only if users hit the limit and request more.

## Remedies (Points)
- Earn for verified or high-quality stock reports and other useful contributions.
- Redeem to waive Concierge fee (example threshold: 80 Remedies = one waiver; balance to be tuned).
- Visible balance and clear earning/redemption rules in UI.

## Concierge
- Guided assistance placing and tracking a DABS special order.
- Clear communication of full-case requirement, ~45-day timeline, restrictions (no allocated/rare, authorized wholesale only).
- Service fee (waivable with Remedies).
- Does not insert markup into DABS price; fee is for the service.

## Risk Mitigations
- Data source changes: modular fetchers, monitoring, admin alerts.
- IP blocking: respectful cadence, caching, fallback to user reports.
- Legal: age gate, disclaimers, no illegal facilitation.
- Low engagement: focus on allocated drop utility first (highest pain).
- Concierge complexity: start with guided self-service + tracking; human assist only if needed.

## Success Criteria for Beta
- Reliable unattended data collection and notifications.
- Positive qualitative feedback from Utah liquor community.
- Meaningful report volume and some Concierge usage.
- Admin can clearly see health and usage without digging through logs.
- No major compliance or ban incidents.

## Next Immediate Actions
1. Confirm domain availability and register on Cloudflare.
2. Create the Grok Bot with the dedicated prompt.
3. Build Phase 0 / Phase 1 foundation under the bot’s guidance, one step at a time.
