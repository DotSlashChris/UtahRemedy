/**
 * Shared club-store predicate (UI + popular auto-prune). Club stores serve licensed operations only
 * and are not open to the public; they do not count toward the popular "in every public store" rule.
 */
export const CLUB_STORE_RE = /club store|licensed operations only/i;
export const isClubStore = (name: string | null | undefined) => CLUB_STORE_RE.test(name ?? "");
