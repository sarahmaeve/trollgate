/**
 * Typed D1 helpers, including the guarded seat-cap INSERT (IMPL.md
 * "Seat caps"). No Durable Object: D1 is single-threaded and a statement is
 * transactional, so one capacity-guarded conditional insert is atomic.
 */
import type { Env } from "../env";
import { newId, newToken } from "../id";

export interface HealthResult {
  ok: boolean;
  orgCount: number;
}

/** Confirms D1 is reachable and the schema is applied. */
export async function dbHealth(env: Env): Promise<HealthResult> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM organizations",
  ).first<{ n: number }>();
  return { ok: true, orgCount: row?.n ?? 0 };
}

/** Statuses that occupy a seat (IMPL.md). */
const SEAT_STATUSES = "('confirmed','pending_payment','refund_pending')";

export interface OccurrenceContext {
  occurrence_id: string;
  occ_status: string;
  starts_at: string;
  ends_at: string;
  event_id: string;
  event_status: string;
  event_title: string;
  timezone: string;
  max_seats: number;
  deposit_cents: number;
}

/** Occurrence joined to its event — everything signup needs in one read. */
export async function getOccurrenceContext(
  env: Env,
  occurrenceId: string,
): Promise<OccurrenceContext | null> {
  return env.DB.prepare(
    `SELECT o.id AS occurrence_id, o.status AS occ_status,
            o.starts_at, o.ends_at,
            e.id AS event_id, e.status AS event_status,
            e.title AS event_title, e.timezone,
            e.max_seats, e.deposit_cents
       FROM event_occurrences o
       JOIN events e ON e.id = o.event_id
      WHERE o.id = ?1`,
  )
    .bind(occurrenceId)
    .first<OccurrenceContext>();
}

export async function seatsTaken(
  env: Env,
  occurrenceId: string,
): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signups
      WHERE occurrence_id = ?1 AND status IN ${SEAT_STATUSES}`,
  )
    .bind(occurrenceId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export type ReserveResult =
  | { kind: "ok"; linkToken: string }
  | { kind: "full" }
  | { kind: "duplicate"; linkToken: string };

/**
 * Free-path seat reservation: one atomic capacity-guarded INSERT that lands
 * the row directly as 'confirmed' (NoPayment — no Stripe hop). Paid events
 * (Phase 6) will insert 'pending_payment' through the same guard.
 */
export async function reserveConfirmedSeat(
  env: Env,
  p: {
    occurrenceId: string;
    eventId: string;
    githubLogin: string;
    githubId: number;
    email: string;
  },
): Promise<ReserveResult> {
  // Pre-check for an *active* prior signup only. Must come before the
  // capacity guard — if the occurrence is full *by this user's own seat*,
  // the guard would otherwise reject with "full" and hide their existing
  // reservation. Canceled/abandoned rows are intentionally NOT matched:
  // for free events a user may sign up again after canceling (decided
  // policy). Paid events forbid re-signup-after-cancel — that rule lives
  // in the Phase 6 paid reserve path (see priorSignupExists), not here,
  // because this free path is only reached when deposit_cents == 0.
  const active = await env.DB.prepare(
    `SELECT link_token FROM signups
      WHERE occurrence_id = ?1 AND github_id = ?2
        AND status IN ${SEAT_STATUSES}`,
  )
    .bind(p.occurrenceId, p.githubId)
    .first<{ link_token: string }>();
  if (active) return { kind: "duplicate", linkToken: active.link_token };

  const linkToken = newToken(32);
  try {
    const res = await env.DB.prepare(
      `INSERT INTO signups
         (id, link_token, occurrence_id, event_id,
          github_login, github_id, email, status, confirmed_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'confirmed', datetime('now')
        WHERE (SELECT COUNT(*) FROM signups
                WHERE occurrence_id = ?3 AND status IN ${SEAT_STATUSES})
              < (SELECT max_seats FROM events WHERE id = ?4)`,
    )
      .bind(
        newId("sgn"),
        linkToken,
        p.occurrenceId,
        p.eventId,
        p.githubLogin,
        p.githubId,
        p.email,
      )
      .run();

    if ((res.meta?.changes ?? 0) === 1) return { kind: "ok", linkToken };

    // 0 rows + no error = capacity guard rejected it.
    return { kind: "full" };
  } catch (err) {
    // uq_signups_active race: a concurrent submit created the active row
    // first. Re-query the active one and treat as duplicate.
    if (/UNIQUE/i.test((err as Error).message)) {
      const existing = await env.DB.prepare(
        `SELECT link_token FROM signups
          WHERE occurrence_id = ?1 AND github_id = ?2
            AND status IN ${SEAT_STATUSES}`,
      )
        .bind(p.occurrenceId, p.githubId)
        .first<{ link_token: string }>();
      if (existing) return { kind: "duplicate", linkToken: existing.link_token };
    }
    throw err;
  }
}

/**
 * Phase 6 (paid events) policy hook: a paid event must NOT allow re-signup
 * after a cancel — a cancel → $5 refund → re-signup loop is abuse. The paid
 * reserve path will call this and block if ANY prior signup exists for
 * (occurrence, user), including canceled/abandoned. Free events never call
 * it (re-signup is allowed there).
 */
export async function priorSignupExists(
  env: Env,
  occurrenceId: string,
  githubId: number,
): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT 1 FROM signups
      WHERE occurrence_id = ?1 AND github_id = ?2 LIMIT 1`,
  )
    .bind(occurrenceId, githubId)
    .first<{ 1: number }>();
  return r != null;
}
