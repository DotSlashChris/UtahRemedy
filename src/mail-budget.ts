/**
 * Shared daily email budget for Cloudflare Email Sending (owner-approved t99s544, 2026-11-21).
 * The Email Sending limit is 200 sends per day (treated as account-wide). Split per Utah (America/Denver) day:
 *   alerts 120 (reserved for step 4; nothing sends alerts yet) | sign-in links 40 | feedback 30 | spare 10.
 * Hard rules, enforced atomically in D1 (one conditional INSERT, so concurrent requests can't overshoot):
 *   1. Every category stays under its own cap.
 *   2. Site-wide stop: total sends today (all categories) < SITE_DAILY_STOP (190), lowered to quota - SPARE if
 *      EMAIL_DAILY_QUOTA is ever set below 200.
 *   3. Sign-in is never crowded out: a non-sign-in send also needs room for every sign-in link not yet sent today
 *      (total + max(0, 40 - signin_sent) < stop).
 * Feedback mail keeps its own audit table (feedback_mail_log, unchanged schema); sign-in (and later alert) mail is logged in
 * mail_log (migration 0014; no recipient address stored). The site-wide total sums both tables. A failed send is settled
 * to ok = 0 and stops counting. No imports, so pure tests can load it directly (scripts/test-mail-budget.ts).
 */

export type MailKind = "signin" | "alert" | "feedback";
export const EMAIL_QUOTA_DEFAULT = 200;
export const SITE_DAILY_STOP = 190;
export const MAIL_SPARE = 10;
export const MAIL_CAPS: Record<MailKind, number> = { alert: 120, signin: 40, feedback: 30 };

export interface BudgetEnv { DB: D1Database; EMAIL_DAILY_QUOTA?: string }

export function emailQuota(env: { EMAIL_DAILY_QUOTA?: string }): number {
  const q = Number(env.EMAIL_DAILY_QUOTA);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : EMAIL_QUOTA_DEFAULT;
}
/** Site-wide hard stop for the day: min(190, quota - 10), never negative. */
export function siteStop(env: { EMAIL_DAILY_QUOTA?: string }): number {
  return Math.max(0, Math.min(SITE_DAILY_STOP, emailQuota(env) - MAIL_SPARE));
}

const UTAH_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
export const budgetDay = (ms = Date.now()) => UTAH_DAY.format(new Date(ms));

// Counted sends today (ok = 1 includes in-flight reservations). ?1 = day.
const TOTAL_SQL = "((SELECT COUNT(*) FROM feedback_mail_log WHERE day = ?1 AND ok = 1) + (SELECT COUNT(*) FROM mail_log WHERE day = ?1 AND ok = 1))";
const SIGNIN_SQL = "(SELECT COUNT(*) FROM mail_log WHERE day = ?1 AND kind = 'signin' AND ok = 1)";
const FEEDBACK_SQL = "(SELECT COUNT(*) FROM feedback_mail_log WHERE day = ?1 AND ok = 1)";

export interface BudgetUse { day: string; total: number; signin: number; alert: number; feedback: number; stop: number; quota: number }
export async function budgetToday(env: BudgetEnv, ms = Date.now()): Promise<BudgetUse> {
  const day = budgetDay(ms);
  const r = await env.DB.prepare(
    `SELECT ${TOTAL_SQL} AS total, ${SIGNIN_SQL} AS signin, (SELECT COUNT(*) FROM mail_log WHERE day = ?1 AND kind = 'alert' AND ok = 1) AS alert, ${FEEDBACK_SQL} AS feedback`,
  ).bind(day).first<{ total: number; signin: number; alert: number; feedback: number }>();
  return { day, total: r?.total ?? 0, signin: r?.signin ?? 0, alert: r?.alert ?? 0, feedback: r?.feedback ?? 0, stop: siteStop(env), quota: emailQuota(env) };
}

/** Pure decision (same rules as the SQL), used for messages and tests. "" = allowed. */
export function budgetReason(kind: MailKind, u: Pick<BudgetUse, "total" | "signin" | "alert" | "feedback" | "stop">): string {
  const used = kind === "signin" ? u.signin : kind === "alert" ? u.alert : u.feedback;
  if (used >= MAIL_CAPS[kind]) return `daily ${kind} email cap (${MAIL_CAPS[kind]})`;
  const hold = kind === "signin" ? 0 : Math.max(0, MAIL_CAPS.signin - u.signin);
  if (u.total + hold >= u.stop) return kind === "signin" ? `site-wide daily email stop (${u.stop})` : `quota reserve (site-wide stop ${u.stop}; ${hold} kept for sign-in links)`;
  return "";
}

/**
 * Atomically reserve one send of `kind` in mail_log (signin | alert). Returns the mail_log row id, or null if the budget is
 * used up (nothing is written then; the caller logs the suppression without a recipient).
 */
export async function reserveMail(env: BudgetEnv, kind: "signin" | "alert", ms = Date.now()): Promise<number | null> {
  const day = budgetDay(ms);
  const hold = kind === "signin" ? "0" : `MAX(0, ?4 - ${SIGNIN_SQL})`;
  const r = await env.DB.prepare(
    `INSERT INTO mail_log (at, day, kind, ok, detail) SELECT ?2, ?1, ?3, 1, 'reserved' ` +
    `WHERE (SELECT COUNT(*) FROM mail_log WHERE day = ?1 AND kind = ?3 AND ok = 1) < ?5 AND ${TOTAL_SQL} + ${hold} < ?6 RETURNING id`,
  ).bind(day, new Date(ms).toISOString(), kind, MAIL_CAPS.signin, MAIL_CAPS[kind], siteStop(env)).first<{ id: number }>();
  return r?.id ?? null;
}

/**
 * Atomically reserve one feedback send in feedback_mail_log (its existing audit table). Returns the row id or null.
 */
export async function reserveFeedbackMail(env: BudgetEnv, kind: "notice" | "reply", fid: number | null, ms = Date.now()): Promise<number | null> {
  const day = budgetDay(ms);
  const r = await env.DB.prepare(
    `INSERT INTO feedback_mail_log (at, day, kind, feedback_id, ok, detail) SELECT ?2, ?1, ?3, ?4, 1, 'reserved' ` +
    `WHERE ${FEEDBACK_SQL} < ?5 AND ${TOTAL_SQL} + MAX(0, ?6 - ${SIGNIN_SQL}) < ?7 RETURNING id`,
  ).bind(day, new Date(ms).toISOString(), kind, fid, MAIL_CAPS.feedback, MAIL_CAPS.signin, siteStop(env)).first<{ id: number }>();
  return r?.id ?? null;
}

/** Settle a reservation: ok stays 1 with "sent ..." detail, or becomes 0 with the error (no longer counted). */
export async function settleMail(env: BudgetEnv, table: "mail_log" | "feedback_mail_log", id: number, ok: boolean, detail: string): Promise<void> {
  await env.DB.prepare(`UPDATE ${table} SET ok = ?, detail = ? WHERE id = ?`).bind(ok ? 1 : 0, detail.slice(0, 300), id).run();
}

/** Log a send that never got a reservation (budget used up, no binding, ...). No recipient is stored. */
export async function logSuppressed(env: BudgetEnv, kind: "signin" | "alert", detail: string, ms = Date.now()): Promise<void> {
  await env.DB.prepare("INSERT INTO mail_log (at, day, kind, ok, detail) VALUES (?, ?, ?, 0, ?)")
    .bind(new Date(ms).toISOString(), budgetDay(ms), kind, detail.slice(0, 300)).run();
}
