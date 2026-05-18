/**
 * Single source of truth for turning an event's iCal block (DTSTART;TZID + RRULE)
 * into concrete occurrences, with a hard cap on expansion.
 *
 * Security (Finding 1): `rrule` will happily enumerate millions of dates for a
 * sub-daily rule (FREQ=SECONDLY/MINUTELY) over the materialization window —
 * CPU/memory exhaustion in the Worker, and a poisoned Cron that re-runs the
 * explosion every tick. The `between` iterator below stops generation the
 * instant the cap is exceeded, so cost is O(cap), not O(window). Both the
 * create-time validator and the Cron materializer go through here.
 */
import { rrulestr } from "rrule";
import type { RRule, RRuleSet } from "rrule";

/** Rolling window we materialize ahead (mirrors the Cron cadence). */
export const WINDOW_DAYS = 90;

/**
 * Upper bound on occurrences per event within the 90-day window. ~5/day is
 * already far beyond any realistic signup cadence; anything denser is treated
 * as abuse/misconfiguration and rejected rather than expanded.
 */
export const MAX_OCCURRENCES_PER_WINDOW = 500;

const DAY_MS = 86_400_000;

export interface PlannedOccurrence {
  startsAt: string; // RFC3339 UTC
  endsAt: string; // startsAt + duration
}

export type PlanResult =
  | { ok: true; occurrences: PlannedOccurrence[] }
  | { ok: false; error: string };

/**
 * The window: start a day in the past so a one-off whose start slipped just
 * behind "now" between create and the first Cron tick still materializes.
 */
export function materializeWindow(now: number = Date.now()): {
  from: Date;
  to: Date;
} {
  return {
    from: new Date(now - DAY_MS),
    to: new Date(now + WINDOW_DAYS * DAY_MS),
  };
}

type Recurrence = RRule | RRuleSet;

/**
 * Bounded expansion. The iterator returns `false` once the cap is exceeded,
 * which halts rrule's generator — a pathological rule costs O(cap), never
 * O(window). `exceeded` distinguishes "legitimately ≤ cap" from "capped".
 */
function expand(
  rule: Recurrence,
  from: Date,
  to: Date,
): { exceeded: boolean; dates: Date[] } {
  const dates: Date[] = [];
  let exceeded = false;
  rule.between(from, to, true, (d: Date) => {
    if (dates.length >= MAX_OCCURRENCES_PER_WINDOW) {
      exceeded = true;
      return false;
    }
    dates.push(d);
    return true;
  });
  return { exceeded, dates };
}

/**
 * Parse + expand + validate an iCal block into occurrence rows. Pure and
 * deterministic given `now`; the only failure modes are the three returned
 * `error` strings (callers surface them to the organizer / log + skip).
 */
export function planOccurrences(
  ical: string,
  durationMin: number,
  now: number = Date.now(),
): PlanResult {
  let rule: Recurrence;
  try {
    rule = rrulestr(ical, { forceset: true });
  } catch {
    return { ok: false, error: "invalid recurrence rule" };
  }

  const { from, to } = materializeWindow(now);
  const { exceeded, dates } = expand(rule, from, to);

  if (exceeded)
    return {
      ok: false,
      error:
        `recurrence is too frequent (more than ${MAX_OCCURRENCES_PER_WINDOW} ` +
        `sessions in the ${WINDOW_DAYS}-day window)`,
    };
  if (dates.length === 0)
    return { ok: false, error: "recurrence produces no occurrences" };

  const occurrences = dates.map((d) => ({
    startsAt: d.toISOString(),
    endsAt: new Date(d.getTime() + durationMin * 60_000).toISOString(),
  }));
  return { ok: true, occurrences };
}

export type RuleValidation = { ok: true } | { ok: false; error: string };

/**
 * Create-time gate. Unlike materialization (which only cares about the
 * *current* rolling window), creation must accept a legitimately far-future
 * series — so non-emptiness is checked against the rule's own first
 * occurrence, and the frequency cap is measured over the 90 days *from that
 * first occurrence*. Rejects the three abusive cases (Finding 1: unparseable,
 * empty, pathologically dense) before the event row is ever stored.
 */
export function validateRule(
  ical: string,
  durationMin: number,
): RuleValidation {
  let rule: Recurrence;
  try {
    rule = rrulestr(ical, { forceset: true });
  } catch {
    return { ok: false, error: "invalid recurrence rule" };
  }

  // First occurrence ever (bounded: stop after the first — cheap even for an
  // open-ended rule, since rrule generates forward from DTSTART).
  const first: Date[] = [];
  rule.all((d: Date) => {
    first.push(d);
    return false;
  });
  if (first.length === 0)
    return { ok: false, error: "recurrence produces no occurrences" };

  // Density measured over the 90 days from the first occurrence. Anchoring
  // `now` at first+1d makes materializeWindow's [now-1d, now+90d] start
  // exactly at the first occurrence.
  const anchor = first[0]!.getTime() + DAY_MS;
  const plan = planOccurrences(ical, durationMin, anchor);
  if (!plan.ok) return plan;
  return { ok: true };
}
