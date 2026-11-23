/**
 * Hard safety caps for all DABS fetching (cron and admin endpoint).
 *  - Kill switch: env FETCHER_ENABLED must be "true" AND KV key dabs:v1:kill must not be "1".
 *  - Daily budget (America/Denver day) in D1 — strongly consistent, atomic reserve-before-use.
 *  - Single-run lock in D1 with TTL.
 * When a cap trips, fetching stops for the day and the reason is recorded once.
 */

export const KILL_KEY = "dabs:v1:kill";
export const LOCK_NAME = "dabs";
export const LOCK_TTL_MS = 6 * 60 * 1000;   // a capped run takes ~2.5 min; cron ticks every 5 min

export const CAPS = {
  dabs_requests: 700,
  dabs_requests_drop_day: 1600, // 3rd Saturday (America/Denver)
  d1_rows_written: 250_000,
  kv_writes: 3_000,
  runs: 60,
  runs_drop_day: 150,
};

export interface GuardEnv {
  DB: D1Database;
  UTAH_REMEDY_CACHE: KVNamespace;
  FETCHER_ENABLED?: string;
}

/** Counts D1 rows written and KV writes so they can be charged to the budget. */
export class Meter {
  d1Rows = 0;
  kvWrites = 0;
  /** Unflushed amounts not yet added to fetch_budget. */
  private pendingRows = 0;
  private pendingKv = 0;
  addResult(r: D1Result | D1Result[] | null | undefined) {
    for (const x of Array.isArray(r) ? r : r ? [r] : []) {
      const n = Number((x.meta as Record<string, unknown> | undefined)?.rows_written ?? x.meta?.changes ?? 0) || 0;
      this.d1Rows += n; this.pendingRows += n;
    }
  }
  addKv(n = 1) { this.kvWrites += n; this.pendingKv += n; }
  take() { const t = { rows: this.pendingRows, kv: this.pendingKv }; this.pendingRows = 0; this.pendingKv = 0; return t; }
}

/** Metered KV put. */
export async function kvPut(kv: KVNamespace, meter: Meter, key: string, value: string, opts?: KVNamespacePutOptions) {
  meter.addKv();
  await kv.put(key, value, opts);
}

// ---------- calendar helpers (America/Denver) ----------
export function mtParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, dom: Number(p.day), weekday: p.weekday as string };
}
export const mtDay = (d = new Date()) => mtParts(d).day;
export function isDropDay(d = new Date()) {
  const p = mtParts(d);
  return p.weekday === "Sat" && p.dom >= 15 && p.dom <= 21;
}
export function capsFor(d = new Date()) {
  const drop = isDropDay(d);
  return { dabs_requests: drop ? CAPS.dabs_requests_drop_day : CAPS.dabs_requests, d1_rows_written: CAPS.d1_rows_written, kv_writes: CAPS.kv_writes, runs: drop ? CAPS.runs_drop_day : CAPS.runs, drop_day: drop };
}

// ---------- kill switch ----------
export async function fetcherDisabledReason(env: GuardEnv): Promise<string | null> {
  if (env.FETCHER_ENABLED !== "true") return "FETCHER_ENABLED is not \"true\"";
  if ((await env.UTAH_REMEDY_CACHE.get(KILL_KEY)) === "1") return `kill switch ${KILL_KEY}=1`;
  return null;
}

// ---------- budget ----------
export class BudgetExceeded extends Error {
  /** true only for the call that tripped the cap (log it once); false if the day was already exhausted. */
  constructor(msg: string, readonly firstTrip = false) { super(msg); }
}

export class Budget {
  readonly day = mtDay();
  readonly caps = capsFor();
  constructor(private db: D1Database, private meter: Meter) {}

  /** Make sure today's fetch_budget row exists (no run charged), so flush() can always record metered usage. */
  async openDay(): Promise<void> {
    this.meter.addResult(await this.db.prepare(
      "INSERT INTO fetch_budget (day, updated_at) VALUES (?, ?) ON CONFLICT(day) DO NOTHING",
    ).bind(this.day, new Date().toISOString()).run());
  }

  /** Charge one run; throws BudgetExceeded if today's budget is exhausted. */
  async startRun(): Promise<void> {
    await this.openDay();
    const row = await this.db.prepare("SELECT * FROM fetch_budget WHERE day = ?").bind(this.day).first<Record<string, unknown>>();
    if (row?.exhausted_reason) throw new BudgetExceeded(String(row.exhausted_reason), false);
    await this.charge({ runs: 1 });
  }

  /** Reserve one DABS request (and flush metered D1/KV usage). Throws BudgetExceeded when any cap would be passed. */
  async reserveRequest(): Promise<void> {
    await this.charge({ requests: 1 });
  }

  /**
   * Flush metered usage without reserving a request (end of run). Never throws for overage; records exhaustion
   * and returns the trip so the caller can log it. (D1-row/KV caps are checked before every request, so a run
   * can overshoot by at most one page's writes.)
   */
  async flush(): Promise<BudgetExceeded | null> {
    try { await this.charge({}); return null; } catch (e) { if (e instanceof BudgetExceeded) return e; throw e; }
  }

  private async charge(add: { requests?: number; runs?: number }): Promise<void> {
    const { rows, kv } = this.meter.take();
    const req = add.requests ?? 0, runs = add.runs ?? 0;
    const c = this.caps;
    // Atomic: only applies if every cap still holds after the increment.
    const r = await this.db.prepare(
      `UPDATE fetch_budget SET dabs_requests = dabs_requests + ?1, runs = runs + ?2,
         d1_rows_written = d1_rows_written + ?3, kv_writes = kv_writes + ?4, updated_at = ?5
       WHERE day = ?6 AND exhausted_reason IS NULL
         AND dabs_requests + ?1 <= ?7 AND runs + ?2 <= ?8
         AND d1_rows_written + ?3 <= ?9 AND kv_writes + ?4 <= ?10
       RETURNING dabs_requests`,
    ).bind(req, runs, rows, kv, new Date().toISOString(), this.day, c.dabs_requests, c.runs, c.d1_rows_written, c.kv_writes).first();
    if (r) { this.meter.addResult({ meta: { rows_written: 1 } } as unknown as D1Result); return; }
    // Cap hit (or already exhausted): record usage anyway + reason, then stop.
    const cur = await this.db.prepare("SELECT * FROM fetch_budget WHERE day = ?").bind(this.day).first<Record<string, number | string | null>>();
    const already = !!cur?.exhausted_reason;
    let reason = already ? String(cur!.exhausted_reason) : "";
    if (!reason && cur) {
      const n = (k: string) => Number(cur[k] ?? 0);
      if (n("dabs_requests") + req > c.dabs_requests) reason = `dabs_requests cap ${c.dabs_requests}`;
      else if (n("runs") + runs > c.runs) reason = `runs cap ${c.runs}`;
      else if (n("d1_rows_written") + rows > c.d1_rows_written) reason = `d1_rows_written cap ${c.d1_rows_written}`;
      else reason = `kv_writes cap ${c.kv_writes}`;
    }
    await this.db.prepare(
      `UPDATE fetch_budget SET d1_rows_written = d1_rows_written + ?, kv_writes = kv_writes + ?,
         exhausted_reason = COALESCE(exhausted_reason, ?), exhausted_at = COALESCE(exhausted_at, ?), updated_at = ? WHERE day = ?`,
    ).bind(rows, kv, reason || "budget exhausted", new Date().toISOString(), new Date().toISOString(), this.day).run();
    throw new BudgetExceeded(reason || "budget exhausted", !already);
  }
}

// ---------- lock ----------
export async function acquireLock(db: D1Database, meter: Meter, holder: string, ttlMs = LOCK_TTL_MS): Promise<boolean> {
  const now = new Date();
  const r = await db.prepare(
    `INSERT INTO fetch_lock (name, holder, acquired_at, expires_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
     WHERE fetch_lock.expires_at < ?3
     RETURNING holder`,
  ).bind(LOCK_NAME, holder, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()).first<{ holder: string }>();
  if (r?.holder === holder) { meter.addResult({ meta: { rows_written: 1 } } as unknown as D1Result); return true; }
  return false;
}
export async function releaseLock(db: D1Database, meter: Meter, holder: string) {
  meter.addResult(await db.prepare("DELETE FROM fetch_lock WHERE name = ? AND holder = ?").bind(LOCK_NAME, holder).run());
}

/** Read-only state for /health (no secrets). */
export async function guardStatus(env: GuardEnv) {
  const day = mtDay();
  const [kill, budget, lock] = await Promise.all([
    env.UTAH_REMEDY_CACHE.get(KILL_KEY).catch(() => null),
    env.DB.prepare("SELECT dabs_requests, d1_rows_written, kv_writes, runs, exhausted_reason FROM fetch_budget WHERE day = ?").bind(day).first<Record<string, unknown>>().catch(() => null),
    env.DB.prepare("SELECT acquired_at, expires_at FROM fetch_lock WHERE name = ?").bind(LOCK_NAME).first<{ acquired_at: string; expires_at: string }>().catch(() => null),
  ]);
  const caps = capsFor();
  return {
    enabled: env.FETCHER_ENABLED === "true",
    kill_switch: kill === "1",
    lock: lock && lock.expires_at > new Date().toISOString() ? { held: true, acquired_at: lock.acquired_at, expires_at: lock.expires_at } : { held: false },
    budget: {
      day, drop_day: caps.drop_day,
      dabs_requests: { used: Number(budget?.dabs_requests ?? 0), cap: caps.dabs_requests },
      d1_rows_written: { used: Number(budget?.d1_rows_written ?? 0), cap: caps.d1_rows_written },
      kv_writes: { used: Number(budget?.kv_writes ?? 0), cap: caps.kv_writes },
      runs: { used: Number(budget?.runs ?? 0), cap: caps.runs },
      exhausted: budget?.exhausted_reason ?? null,
    },
  };
}
