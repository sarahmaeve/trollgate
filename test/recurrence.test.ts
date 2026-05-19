import { describe, it, expect } from "vitest";
import {
  planOccurrences,
  validateRule,
  buildRuleBody,
  MAX_WEEKLY_COUNT,
  MAX_OCCURRENCES_PER_WINDOW,
} from "../src/events/recurrence";

// Deterministic "now" so the 90-day materialization window is fixed.
const NOW = Date.parse("2026-06-01T00:00:00Z");
const ical = (rule: string, dt = "20260602T180000") =>
  `DTSTART;TZID=America/Chicago:${dt}\nRRULE:${rule}`;

describe("planOccurrences", () => {
  it("expands a one-off (COUNT=1) to a single occurrence", () => {
    const r = planOccurrences(ical("FREQ=DAILY;COUNT=1"), 60, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.occurrences).toHaveLength(1);
    const { startsAt, endsAt } = r.occurrences[0]!;
    // ends_at is starts_at + duration.
    expect(new Date(endsAt).getTime() - new Date(startsAt).getTime()).toBe(
      60 * 60_000,
    );
  });

  it("expands a bounded weekly series", () => {
    const r = planOccurrences(ical("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), 90, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.occurrences).toHaveLength(8);
  });

  it("rejects a rule that produces no occurrences in the window", () => {
    // Single date far in the past — outside the [now-1d, now+90d] window.
    const r = planOccurrences(
      ical("FREQ=DAILY;COUNT=1", "20260101T180000"),
      60,
      NOW,
    );
    expect(r).toEqual({ ok: false, error: expect.stringContaining("no occurrences") });
  });

  it("rejects an unparseable recurrence rule", () => {
    const r = planOccurrences("DTSTART:not-a-date\nRRULE:FREQ=NONSENSE", 60, NOW);
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining("invalid recurrence rule"),
    });
  });

  // Finding 1: the DoS case. A sub-daily rule would expand to millions of
  // dates over a 90-day window; the guard must reject it *cheaply* (bounded
  // iteration), not hang or OOM. A fast assertion proves the cap short-circuits
  // generation: an unbounded expansion could never return in time.
  it("rejects a pathologically frequent rule without exploding", () => {
    const start = Date.now();
    const r = planOccurrences(ical("FREQ=SECONDLY"), 60, NOW);
    const elapsedMs = Date.now() - start;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(String(MAX_OCCURRENCES_PER_WINDOW));
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("rejects FREQ=MINUTELY over the window (too many sessions)", () => {
    const r = planOccurrences(ical("FREQ=MINUTELY"), 60, NOW);
    expect(r.ok).toBe(false);
  });
});

describe("buildRuleBody (friendly form → RRULE body)", () => {
  it("single session → one-off rule", () => {
    expect(buildRuleBody({ frequency: "once" })).toEqual({
      ok: true,
      rule: "FREQ=DAILY;COUNT=1",
    });
  });

  it("weekly → FREQ=WEEKLY with the chosen count (weekday implied by DTSTART)", () => {
    expect(buildRuleBody({ frequency: "weekly", count: 8 })).toEqual({
      ok: true,
      rule: "FREQ=WEEKLY;COUNT=8",
    });
    expect(buildRuleBody({ frequency: "weekly", count: 1 })).toEqual({
      ok: true,
      rule: "FREQ=WEEKLY;COUNT=1",
    });
  });

  it("rejects a non-positive / non-integer / over-cap weekly count", () => {
    for (const count of [0, -3, 2.5, Number.NaN, MAX_WEEKLY_COUNT + 1]) {
      const r = buildRuleBody({ frequency: "weekly", count });
      expect(r.ok).toBe(false);
    }
  });

  it("accepts the boundary weekly count", () => {
    expect(buildRuleBody({ frequency: "weekly", count: MAX_WEEKLY_COUNT })).toEqual(
      { ok: true, rule: `FREQ=WEEKLY;COUNT=${MAX_WEEKLY_COUNT}` },
    );
  });

  it("rejects an unknown frequency", () => {
    // @ts-expect-error — exercising the runtime guard for bad form input
    expect(buildRuleBody({ frequency: "yearly", count: 3 }).ok).toBe(false);
  });
});

describe("validateRule (create-time gate)", () => {
  it("accepts a normal weekly series", () => {
    expect(validateRule(ical("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), 60)).toEqual({
      ok: true,
    });
  });

  it("accepts an open-ended (no COUNT/UNTIL) weekly series", () => {
    expect(validateRule(ical("FREQ=WEEKLY;BYDAY=TU"), 60)).toEqual({
      ok: true,
    });
  });

  // Regression guard: a legitimately far-future first session (well beyond
  // the rolling 90-day materialization window) must still be creatable.
  it("accepts a one-off whose first session is >90 days out", () => {
    const farOut = "20270601T180000"; // ~1 year ahead
    expect(validateRule(ical("FREQ=DAILY;COUNT=1", farOut), 60)).toEqual({
      ok: true,
    });
  });

  it("rejects a pathologically frequent rule (Finding 1)", () => {
    const r = validateRule(ical("FREQ=SECONDLY"), 60);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(String(MAX_OCCURRENCES_PER_WINDOW));
  });

  it("rejects an unparseable rule", () => {
    expect(validateRule("DTSTART:bad\nRRULE:FREQ=NOPE", 60)).toEqual({
      ok: false,
      error: expect.stringContaining("invalid recurrence rule"),
    });
  });
});
