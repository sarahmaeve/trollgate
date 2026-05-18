/**
 * Materialize an event's recurrence into concrete occurrences (IMPL.md
 * "Scheduled cleanup" step 1). The event's `rrule` column holds a full iCal
 * block (DTSTART;TZID=… + RRULE) so timezone/DST is encoded with the rule;
 * `timezone` mirrors the TZID for display/queries.
 *
 * Idempotent: ON CONFLICT(event_id, starts_at) DO NOTHING — re-runs only add
 * genuinely new sessions, never touching occurrences that have signups.
 *
 * Known hardening item (IMPL.md): exhaustive DST-edge correctness across the
 * rrule.js tzid path is a later pass; Phase 2 covers fixed + simple weekly.
 */
import type { Env } from "../env";
import { newId } from "../id";
import { EVENT_STATUS, OCCURRENCE_STATUS } from "../db/constants";
import { planOccurrences } from "./recurrence";

export interface MaterializableEvent {
  id: string;
  rrule: string;
  duration_min: number;
}

export interface MaterializeResult {
  considered: number;
  inserted: number;
}

export async function materializeEvent(
  env: Env,
  ev: MaterializableEvent,
): Promise<MaterializeResult> {
  // Bounded expansion (Finding 1): planOccurrences caps iteration, so an
  // abusive rule that slipped past create-time validation can never explode
  // the Cron. A capped/invalid rule is skipped (logged), not fatal.
  const plan = planOccurrences(ev.rrule, ev.duration_min);
  if (!plan.ok) {
    console.error(`materialize skipped event ${ev.id}: ${plan.error}`);
    return { considered: 0, inserted: 0 };
  }
  if (plan.occurrences.length === 0) return { considered: 0, inserted: 0 };

  const stmt = env.DB.prepare(
    `INSERT INTO event_occurrences (id, event_id, starts_at, ends_at, status)
     VALUES (?1, ?2, ?3, ?4, '${OCCURRENCE_STATUS.scheduled}')
     ON CONFLICT(event_id, starts_at) DO NOTHING`,
  );

  const batch = plan.occurrences.map((o) =>
    stmt.bind(newId("occ"), ev.id, o.startsAt, o.endsAt),
  );

  const results = await env.DB.batch(batch);
  const inserted = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return { considered: plan.occurrences.length, inserted };
}

/** Materialize every open event. Called by the Cron and on create. */
export async function materializeAllOpen(env: Env): Promise<MaterializeResult> {
  const { results } = await env.DB.prepare(
    `SELECT id, rrule, duration_min FROM events WHERE status = '${EVENT_STATUS.open}'`,
  ).all<MaterializableEvent>();

  const total: MaterializeResult = { considered: 0, inserted: 0 };
  for (const ev of results) {
    try {
      const r = await materializeEvent(env, ev);
      total.considered += r.considered;
      total.inserted += r.inserted;
    } catch (err) {
      console.error(`materialize failed for event ${ev.id}:`, err);
    }
  }
  return total;
}
