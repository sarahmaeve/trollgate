/**
 * Pure create-event form parsing/validation. Returns either parsed values
 * (incl. the composed iCal) or the raw input + collected errors, so the
 * route can re-render a sticky form instead of a dead-end error page.
 */
import { buildRuleBody, validateRule, firstOccurrence } from "./recurrence";
import { isValidTimezone } from "./timezones";

export interface ParsedEvent {
  title: string;
  description: string;
  requirements: string | null;
  timezone: string;
  startsLocal: string;
  durationMin: number;
  ruleBody: string;
  ical: string;
  maxSeats: number;
}

export interface EventFormFields {
  title: string;
  description: string;
  requirements: string;
  timezone: string;
  starts_local: string;
  duration_min: string;
  frequency: string;
  weekly_count: string;
  max_seats: string;
}

/** Raw, possibly-incomplete input straight off the request. */
export type RawEventForm = Partial<EventFormFields>;

export type ParseResult =
  | { ok: true; values: ParsedEvent }
  | { ok: false; raw: EventFormFields; errors: string[] };

/** "2026-06-01T18:00" → "20260601T180000" (iCal local basic), or null. */
function toICalBasic(local: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return `${y}${mo}${d}T${h}${mi}00`;
}

export function parseCreateEventForm(
  input: RawEventForm,
  now: number = Date.now(),
): ParseResult {
  const raw: EventFormFields = {
    title: (input.title ?? "").trim(),
    description: (input.description ?? "").trim(),
    requirements: (input.requirements ?? "").trim(),
    timezone: (input.timezone ?? "").trim(),
    starts_local: (input.starts_local ?? "").trim(),
    duration_min: (input.duration_min ?? "").trim(),
    frequency: (input.frequency ?? "").trim(),
    weekly_count: (input.weekly_count ?? "").trim(),
    max_seats: (input.max_seats ?? "").trim(),
  };

  const errors: string[] = [];
  if (!raw.title) errors.push("Title is required.");
  if (!raw.description) errors.push("Description is required.");
  if (!isValidTimezone(raw.timezone)) errors.push("Pick a valid timezone.");

  const basic = toICalBasic(raw.starts_local);
  if (!basic) errors.push("Pick a valid first-session date and time.");

  const durationMin = Number(raw.duration_min);
  if (!Number.isInteger(durationMin) || durationMin < 1)
    errors.push("Duration must be a whole number of minutes (≥ 1).");

  const maxSeats = Number(raw.max_seats);
  if (!Number.isInteger(maxSeats) || maxSeats < 1)
    errors.push("Max seats must be a whole number (≥ 1).");

  const rule =
    raw.frequency === "weekly"
      ? buildRuleBody({ frequency: "weekly", count: Number(raw.weekly_count) })
      : raw.frequency === "once"
        ? buildRuleBody({ frequency: "once" })
        : { ok: false as const, error: "Choose how often this repeats." };
  if (!rule.ok) errors.push(rule.error);

  if (errors.length > 0) return { ok: false, raw, errors };

  const ical = `DTSTART;TZID=${raw.timezone}:${basic}\nRRULE:${
    (rule as { ok: true; rule: string }).rule
  }`;

  const v = validateRule(ical, durationMin);
  if (!v.ok) return { ok: false, raw, errors: [v.error] };

  // The first session must not already be in the past — scheduling a
  // session that has happened is never intended (signup is separately
  // gated, but the event itself shouldn't be creatable in the past).
  const first = firstOccurrence(ical);
  if (first && first.getTime() <= now)
    return {
      ok: false,
      raw,
      errors: ["First session must be in the future."],
    };

  return {
    ok: true,
    values: {
      title: raw.title,
      description: raw.description,
      requirements: raw.requirements || null,
      timezone: raw.timezone,
      startsLocal: raw.starts_local,
      durationMin,
      ruleBody: (rule as { ok: true; rule: string }).rule,
      ical,
      maxSeats,
    },
  };
}

export interface RescheduleInput {
  timezone: string;
  starts_local: string;
}

export type RescheduleResult =
  | { ok: true; startsAt: string; endsAt: string }
  | { ok: false; raw: RescheduleInput; errors: string[] };

/**
 * Move a single occurrence to a new local time. Same guards as initial
 * scheduling: valid IANA tz, parseable datetime, and the new instant must be
 * in the future. The tz→UTC conversion goes through the *same* one-off iCal
 * + firstOccurrence path as creation, so DST behavior is identical (no second
 * conversion code path to drift). Duration is the event's, unchanged.
 */
export function planReschedule(
  input: RescheduleInput,
  durationMin: number,
  now: number = Date.now(),
): RescheduleResult {
  const raw: RescheduleInput = {
    timezone: (input.timezone ?? "").trim(),
    starts_local: (input.starts_local ?? "").trim(),
  };

  const errors: string[] = [];
  if (!isValidTimezone(raw.timezone)) errors.push("Pick a valid timezone.");
  const basic = toICalBasic(raw.starts_local);
  if (!basic) errors.push("Pick a valid date and time.");

  if (errors.length > 0) return { ok: false, raw, errors };

  const ical = `DTSTART;TZID=${raw.timezone}:${basic}\nRRULE:FREQ=DAILY;COUNT=1`;
  const start = firstOccurrence(ical);
  if (!start) return { ok: false, raw, errors: ["Invalid date and time."] };
  if (start.getTime() <= now)
    return { ok: false, raw, errors: ["New time must be in the future."] };

  return {
    ok: true,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + durationMin * 60_000).toISOString(),
  };
}
