# Utah Remedy — Project Description

**Working name:** Utah Remedy  
**Tagline (draft):** The remedy for Utah liquor hunting.  
**Market:** Utah only. No multi-state expansion planned.  
**Status:** Beta planning (as of 2026-10-21)

## Problem
Utah’s control-state liquor system (DABS) creates real friction:
- Official inventory data lags or is incomplete.
- Allocated and rare products require constant monitoring, early lines, and guesswork about store delivery days.
- Special orders exist but are poorly understood, multi-week, full-case only, and intimidating for most people.
- Existing independent tools (utahdrops.com, utahneat.app, official app) cover search or basic alerts but lack reliable real-time community verification, predictive intelligence, and guided special-order facilitation.

Utah residents and visitors who care about specific bottles repeatedly miss drops or give up on products that are legally available via special order.

## Solution
Utah Remedy is a web-first (then mobile) service that:
1. Lets users set watches on products, brands, categories, or statuses and receive timely notifications when stock or drawing status changes.
2. Crowdsources live shelf verification reports and combines them with public DABS data to produce fresher inventory and predictive drop intelligence.
3. Offers a guided **Concierge** service for DABS special orders (service fee, waivable with earned Remedies).
4. Surfaces allocated drop calendars, store-level quantities, and “best chance near me” rankings.
5. Awards **Remedies** (points) for useful contributions; Remedies can waive Concierge fees.

Tone is professional and trustworthy, with enough personality and Utah-liquor relatability to feel engaging rather than bureaucratic. Strong age gate (21+). Clear disclaimers: not affiliated with DABS, inventory not guaranteed, call the store before driving.

## Core Beta Features
- Age gate and clear non-affiliation disclaimers.
- Product search and store inventory views (public DABS data + user reports).
- User watches (limited free tier) with email/SMS/push notifications (web push first).
- Crowdsourced stock reports (“in stock / sold out / just saw it”) with optional photo, timestamp, and location/store context.
- Basic predictive signals (warehouse quantity drops → likely store arrivals; historical patterns).
- Allocated drop calendar and drop-day views.
- Rare/high-demand drawing alerts.
- Concierge special-order facilitation (guided flow, tracking, service fee; full-case rules respected).
- Remedies points system (earn for reports and useful actions; redeem to waive Concierge fee).
- Admin dashboard for health, usage, data freshness, and error rates.
- Intelligent caching, respectful polling of public sources, preference for structured data/APIs where available.

## Out of Scope for Initial Beta
- Native iOS/Android apps (web + progressive web app first; apps later).
- Case-splitting with escrow and in-store meetups (fast-follower / v2).
- Paid subscription (freemium watch limit only; add subscription later if users hit the ceiling).
- Direct product resale or markup inside DABS pricing.
- Scraping of private or login-gated systems.

## Monetization (Beta)
- Tip jar (Cash App / similar).
- Concierge service fee for special-order facilitation (waivable with Remedies).
- Free tier with a hard limit on number of watches.
- No subscription in beta.

## Success Metrics (Beta)
Admin dashboard must surface:
- Active users and D1/D7 retention
- Watches created and alerts delivered
- Crowdsourced reports submitted (volume and quality signals)
- Concierge requests started / completed
- Remedies earned and redeemed
- Drop-day engagement
- Data freshness and error rates
- Qualitative feedback (especially from r/utahAlcohol and local groups)

## Technology Alignment
Host domain and application on Cloudflare (consistent with Agenda Watch and Off By One). Prefer Cloudflare Workers + Cron Triggers for scheduled data collection, D1 or KV for storage, and Pages/Workers for the frontend. Respectful data access only. Intelligent caching. Avoid IP bans.

## Legal & Compliance Notes
- 21+ age gate required.
- Prominent disclaimers: independent, not affiliated with Utah DABS, data may lag, verify with store.
- Do not facilitate illegal activity or resale outside DABS rules.
- Full-case special-order constraints must be clearly communicated.
- User reports are voluntary; moderate for abuse.

## Relationship to Quazarplex
Separate product from Agenda Watch and Off By One. Shares Cloudflare hosting preference and operational discipline (unattended scheduled jobs, clear failure reporting, no premature paid features).
