/**
 * Shared daily email budget (src/mail-budget.ts; owner-approved split t99s544): alerts 120 / sign-in 40 / feedback 30 / spare 10,
 * site-wide stop 190, sign-in never crowded out. Pure + SQL tests on an in-memory SQLite built from migrations/*.sql through a tiny
 * D1-shaped adapter. No wrangler, no network, no email.
 * Run: node --experimental-strip-types --no-warnings scripts/test-mail-budget.ts
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { MAIL_CAPS, SITE_DAILY_STOP, MAIL_SPARE, EMAIL_QUOTA_DEFAULT, budgetDay, budgetReason, budgetToday, reserveFeedbackMail, reserveMail, settleMail, siteStop } from "../src/mail-budget.ts";

let passed = 0; const fails: string[] = [];
function check(name: string, cond: unknown, detail = "") {
  if (cond) { passed++; console.log("  ok  ", name); } else { fails.push(`${name} ${detail}`); console.log("  FAIL", name, detail); }
}

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => { const r = db.prepare(sql).run(...(args as never[])); return { meta: { changes: Number(r.changes) } }; },
  });
  return { raw: db, D1: { prepare: (sql: string) => stmt(sql), batch: async (s: { run: () => Promise<unknown> }[]) => { for (const x of s) await x.run(); return []; } } };
}
function fresh(quota?: string) { const f = fakeD1(); return { ...f, env: { DB: f.D1 as unknown as D1Database, EMAIL_DAILY_QUOTA: quota } }; }
const T0 = Date.parse("2026-11-21T19:00:00Z");   // 12:00 MST
function fill(raw: DatabaseSync, table: "mail_log" | "feedback_mail_log", kind: string, n: number, ms = T0, ok = 1) {
  const day = budgetDay(ms);
  const sql = table === "mail_log" ? "INSERT INTO mail_log (at, day, kind, ok, detail) VALUES (?, ?, ?, ?, 'filler')"
    : "INSERT INTO feedback_mail_log (at, day, kind, feedback_id, ok, detail) VALUES (?, ?, ?, NULL, ?, 'filler')";
  for (let i = 0; i < n; i++) raw.prepare(sql).run(new Date(ms).toISOString(), day, kind, ok);
}
async function drain(env: { DB: D1Database }, kind: "signin" | "alert", max = 500, ms = T0) { let n = 0; while (n < max && (await reserveMail(env, kind, ms)) !== null) n++; return n; }
async function drainFb(env: { DB: D1Database }, max = 500, ms = T0) { let n = 0; while (n < max && (await reserveFeedbackMail(env, "notice", null, ms)) !== null) n++; return n; }

async function main() {
  console.log("constants");
  check("split 120/40/30 + spare 10, stop 190, quota 200", MAIL_CAPS.alert === 120 && MAIL_CAPS.signin === 40 && MAIL_CAPS.feedback === 30 && MAIL_SPARE === 10 && SITE_DAILY_STOP === 190 && EMAIL_QUOTA_DEFAULT === 200);
  check("caps + spare = 200", MAIL_CAPS.alert + MAIL_CAPS.signin + MAIL_CAPS.feedback + MAIL_SPARE === 200);
  check("siteStop default 190", siteStop({}) === 190);
  check("siteStop with quota 300 still 190 (hard stop)", siteStop({ EMAIL_DAILY_QUOTA: "300" }) === 190);
  check("siteStop with quota 100 -> 90", siteStop({ EMAIL_DAILY_QUOTA: "100" }) === 90);
  check("siteStop never negative", siteStop({ EMAIL_DAILY_QUOTA: "5" }) === 0);
  check("Utah day boundary: 06:59Z is previous MST day", budgetDay(Date.parse("2026-11-22T06:59:00Z")) === "2026-11-21" && budgetDay(Date.parse("2026-11-22T07:00:00Z")) === "2026-11-22");

  console.log("per-category caps (SQL, atomic conditional insert)");
  { const { env } = fresh(); check("sign-in alone stops at 40", (await drain(env, "signin")) === 40); }
  { const { env } = fresh(); check("alerts alone stop at 120", (await drain(env, "alert")) === 120); }
  { const { env } = fresh(); check("feedback alone stops at 30", (await drainFb(env)) === 30); }

  console.log("sign-in never crowded out");
  { const { env } = fresh();
    const a = await drain(env, "alert"), f = await drainFb(env), s = await drain(env, "signin");
    const u = await budgetToday(env, T0);
    check("alerts 120 + feedback 30 first -> sign-in still gets all 40", a === 120 && f === 30 && s === 40, `${a} ${f} ${s}`);
    check("total = 190 = stop; nothing more of any kind", u.total === 190 && (await reserveMail(env, "alert", T0)) === null && (await reserveFeedbackMail(env, "notice", null, T0)) === null && (await reserveMail(env, "signin", T0)) === null, JSON.stringify(u));
  }
  { const { env, raw } = fresh();
    fill(raw, "mail_log", "alert", 140);   // e.g. a future cap change or stray rows: alerts beyond their share
    const u = await budgetToday(env, T0);
    check("140 non-sign-in sends -> alerts/feedback stop at 150 total, leaving 40 for sign-in", (await drainFb(env)) === 10 && (await drain(env, "signin")) === 40, JSON.stringify(u));
    check("... and the site-wide total is exactly 190", (await budgetToday(env, T0)).total === 190);
  }
  { const { env, raw } = fresh();
    fill(raw, "mail_log", "signin", 25);
    const a = await drain(env, "alert"), f = await drainFb(env), s = await drain(env, "signin");
    check("25 sign-ins already sent -> alerts 120 + feedback 30 still fit, remaining 15 sign-ins still available", a === 120 && f === 30 && s === 15, `${a} ${f} ${s}`);
  }

  console.log("site-wide stop 190 and lower quota");
  { const { env } = fresh("100");
    const a = await drain(env, "alert"); const s = await drain(env, "signin");
    check("quota 100 -> stop 90: alerts 50, sign-in 40 (sign-in share intact)", a === 50 && s === 40, `${a} ${s}`);
  }
  { const { env, raw } = fresh();
    fill(raw, "feedback_mail_log", "notice", 30); fill(raw, "mail_log", "alert", 120); fill(raw, "mail_log", "signin", 39);
    check("189 sent -> one last sign-in allowed, then stop", (await reserveMail(env, "signin", T0)) !== null && (await reserveMail(env, "signin", T0)) === null);
  }

  console.log("failures and days");
  { const { env } = fresh();
    const id = (await reserveMail(env, "signin", T0))!; await settleMail(env, "mail_log", id, false, "error E_X");
    const u = await budgetToday(env, T0);
    check("failed send settles to ok=0 and stops counting", u.signin === 0 && u.total === 0, JSON.stringify(u));
    const id2 = (await reserveMail(env, "signin", T0))!; await settleMail(env, "mail_log", id2, true, "sent m1");
    check("sent send keeps counting", (await budgetToday(env, T0)).signin === 1);
  }
  { const { env, raw } = fresh();
    fill(raw, "mail_log", "signin", 40, T0 - 86400_000);
    check("yesterday's 40 sign-ins don't count today", (await drain(env, "signin")) === 40);
  }
  { const { env, raw } = fresh();
    fill(raw, "feedback_mail_log", "notice", 30, T0, 0);
    check("suppressed/failed feedback rows (ok=0) don't count", (await drainFb(env)) === 30);
  }

  console.log("pure reasons match SQL");
  check("feedback cap reason", budgetReason("feedback", { total: 30, signin: 0, alert: 0, feedback: 30, stop: 190 }).includes("daily feedback email cap (30)"));
  check("feedback quota-reserve reason (quota 12 -> stop 2)", budgetReason("feedback", { total: 2, signin: 0, alert: 0, feedback: 2, stop: 2 }).startsWith("quota reserve"));
  check("sign-in at 40 -> cap reason", budgetReason("signin", { total: 40, signin: 40, alert: 0, feedback: 0, stop: 190 }).includes("signin email cap (40)"));
  check("sign-in at total 190 -> stop reason", budgetReason("signin", { total: 190, signin: 20, alert: 120, feedback: 30, stop: 190 }).includes("site-wide daily email stop (190)"));
  check("alert blocked when it would eat sign-in room", budgetReason("alert", { total: 150, signin: 0, alert: 120, feedback: 30, stop: 190 }) !== "" && budgetReason("signin", { total: 150, signin: 0, alert: 120, feedback: 30, stop: 190 }) === "");

  console.log(`\n${passed} passed, ${fails.length} failed`);
  for (const f of fails) console.log("  FAILED:", f);
  process.exit(fails.length ? 1 : 0);
}
main();
