/**
 * Single source of truth for the stringly-typed enums that span SQL and TS.
 * Keep `schema.sql`'s status comments and the `uq_signups_active` partial
 * index in sync with ACTIVE_SIGNUP_STATUSES here.
 */

export const SIGNUP_STATUS = {
  pendingPayment: "pending_payment",
  confirmed: "confirmed",
  abandoned: "abandoned",
  canceled: "canceled",
  refundPending: "refund_pending",
  canceledRefunded: "canceled_refunded",
} as const;
export type SignupStatus = (typeof SIGNUP_STATUS)[keyof typeof SIGNUP_STATUS];

export const EVENT_STATUS = { open: "open", canceled: "canceled" } as const;
export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

export const OCCURRENCE_STATUS = {
  scheduled: "scheduled",
  canceled: "canceled",
} as const;
export type OccurrenceStatus =
  (typeof OCCURRENCE_STATUS)[keyof typeof OCCURRENCE_STATUS];

export const ROLE = { owner: "owner", admin: "admin", staff: "staff" } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

export const NOTIFICATION_KIND = {
  eventCanceled: "event_canceled",
  eventRescheduled: "event_rescheduled",
} as const;
export type NotificationKind =
  (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

/** Statuses that occupy a seat (IMPL.md "Seat caps"). */
export const ACTIVE_SIGNUP_STATUSES = [
  SIGNUP_STATUS.confirmed,
  SIGNUP_STATUS.pendingPayment,
  SIGNUP_STATUS.refundPending,
] as const;

/** Statuses a user can self-cancel from. */
export const CANCELABLE_STATUSES = [
  SIGNUP_STATUS.confirmed,
  SIGNUP_STATUS.pendingPayment,
] as const;

/** Render `('a','b',...)` for a SQL `IN` clause from a status list. */
function sqlInList(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(",")})`;
}

export const ACTIVE_SIGNUP_STATUSES_SQL = sqlInList(ACTIVE_SIGNUP_STATUSES);
export const CANCELABLE_STATUSES_SQL = sqlInList(CANCELABLE_STATUSES);

/** Max delivery attempts before a notification is treated as poison. */
export const MAX_NOTIFICATION_ATTEMPTS = 10;
