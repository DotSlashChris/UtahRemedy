# Utah Remedy — Design Outline

## Tone & Feel
Professional and trustworthy (clear, accurate, non-hype), yet fun, engaging, and relatable to Utah liquor enthusiasts. Avoid bureaucratic stiffness and avoid excessive jokiness. Use “Concierge” and “Remedies” consistently. Utah-specific language is welcome when it adds clarity or warmth.

## Age Gate
Hard 21+ gate on first meaningful interaction. Persistent disclaimer: independent service, not affiliated with Utah DABS, data may lag, verify in store before traveling.

## Key User Flows

### 1. Discovery & Search
- Search by name, brand, category, or SKU.
- Results show current official stock (warehouse / stores), price, status, and recent user reports.
- “Not in stock? Start Concierge” CTA when appropriate.

### 2. Watches
- Create watch: specific product, brand, category, or status change.
- Optional location/store filters.
- Free-tier limit enforced.
- Notification preferences (email primary in beta).

### 3. Crowdsourced Reports
- From product or store view: quick “In stock / Sold out / Just saw it” + optional photo + store confirmation.
- Earn Remedies for useful reports.
- Display recent reports alongside official data.

### 4. Allocated Drops & Rare Drawings
- Calendar of upcoming allocated release (3rd Saturday).
- Drop-day view: products, quantities, participating stores, recent reports.
- Alerts when rare/high-demand drawing status changes.
- “Best chance near me” (basic in beta, smarter later).

### 5. Concierge (Special Orders)
- Guided checklist: confirm not already stocked, full-case rules, restrictions, expected timeline.
- Assist with account creation / request submission / price confirmation / tracking.
- Service fee (or Remedies waiver).
- Status tracking until pickup window.

### 6. Remedies
- Visible balance.
- Clear earning rules and redemption (waive Concierge fee).
- History of earned/spent.

### 7. Admin
- Dashboard: active users, retention, watches, alerts, reports, Concierge funnel, Remedies economy, data freshness, error rates, recent failures.
- Ability to inspect individual fetches and user reports.

## Data Model (high-level)
- Users (age confirmed, notification prefs, Remedies balance)
- Products (SKU, name, category, status, prices)
- Inventory snapshots (warehouse qty, store qtys, timestamp, source)
- User reports (product, store, status, photo, timestamp, user, quality signal)
- Watches (user, criteria, filters, active)
- Alerts (delivered history)
- Concierge requests (status, timeline, fee/waiver)
- Stores (locations, hours if available)
- Remedies transactions

## UI Principles
- Fast search and clear stock indicators.
- Prominent but non-intrusive disclaimers.
- Mobile-friendly from day one (many users will check in stores).
- Drop-day and allocated views optimized for quick scanning.
- Professional visual language with subtle Utah/liquor personality (not cartoonish).

## Notification Design
- Timely but not noisy.
- Actionable (product, store, quantity context, link).
- Fail closed (no alert on failed or stale data without clear labeling).

## Caching & Freshness
- Cache public data with TTLs appropriate to change frequency.
- More frequent refresh near known drop windows.
- Surface “last updated” timestamps.
- User reports can override or annotate official counts for display.
