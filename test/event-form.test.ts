import { describe, it, expect } from "vitest";
import { timezoneOptions } from "../src/events/timezones";
import { parseCreateEventForm, planReschedule } from "../src/events/event-form";

describe("timezoneOptions (dropdown source)", () => {
  it("returns a deduped, sorted IANA list including common zones", () => {
    const tz = timezoneOptions();
    expect(tz.length).toBeGreaterThan(50);
    expect(tz).toContain("UTC");
    expect(tz).toContain("America/Chicago");
    expect([...tz]).toEqual([...tz].sort());
    expect(new Set(tz).size).toBe(tz.length);
  });
});

const base = {
  title: "Study Group",
  description: "Weekly TS",
  requirements: "",
  timezone: "America/Chicago",
  starts_local: "2026-06-02T18:00",
  duration_min: "60",
  frequency: "once",
  weekly_count: "",
  max_seats: "10",
};

// base's first session is 2026-06-02 18:00 America/Chicago = 23:00Z (CDT).
const BEFORE = Date.parse("2026-06-01T00:00:00Z"); // first session is future
const AFTER = Date.parse("2026-07-01T00:00:00Z"); // first session is past

describe("parseCreateEventForm", () => {
  it("accepts a valid one-off and yields the iCal + rule", () => {
    const r = parseCreateEventForm(base, BEFORE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values.ruleBody).toBe("FREQ=DAILY;COUNT=1");
    expect(r.values.timezone).toBe("America/Chicago");
    expect(r.values.maxSeats).toBe(10);
  });

  it("accepts a valid weekly series with a count", () => {
    const r = parseCreateEventForm(
      { ...base, frequency: "weekly", weekly_count: "8" },
      BEFORE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values.ruleBody).toBe("FREQ=WEEKLY;COUNT=8");
  });

  it("rejects a one-off whose first session is in the past", () => {
    const r = parseCreateEventForm(base, AFTER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/future/i);
  });

  it("rejects a weekly series whose first session is in the past", () => {
    const r = parseCreateEventForm(
      { ...base, frequency: "weekly", weekly_count: "8" },
      AFTER,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/future/i);
  });

  it("collects multiple errors and echoes raw input back (sticky form)", () => {
    const r = parseCreateEventForm(
      {
        ...base,
        title: "",
        timezone: "Not/AZone",
        duration_min: "0",
        frequency: "weekly",
        weekly_count: "nope",
      },
      BEFORE,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    // Raw values are returned so the form can be re-rendered unchanged.
    expect(r.raw.timezone).toBe("Not/AZone");
    expect(r.raw.title).toBe("");
  });

  it("rejects an invalid first-session datetime", () => {
    const r = parseCreateEventForm({ ...base, starts_local: "June 2nd" });
    expect(r.ok).toBe(false);
  });
});

describe("planReschedule (same future/tz guards as creation)", () => {
  const at = (s: string) => Date.parse(s);

  it("moves to a valid future time and recomputes end from duration", () => {
    const r = planReschedule(
      { timezone: "America/Los_Angeles", starts_local: "2030-01-02T18:00" },
      90,
      at("2029-01-01T00:00:00Z"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 18:00 America/Los_Angeles (PST, -8) → 02:00Z next day.
    expect(r.startsAt).toBe("2030-01-03T02:00:00.000Z");
    expect(new Date(r.endsAt).getTime() - new Date(r.startsAt).getTime()).toBe(
      90 * 60_000,
    );
  });

  it("rejects a move into the past (same guard as initial scheduling)", () => {
    const r = planReschedule(
      { timezone: "America/Los_Angeles", starts_local: "2030-01-02T18:00" },
      60,
      at("2031-01-01T00:00:00Z"),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/future/i);
    expect(r.raw.timezone).toBe("America/Los_Angeles"); // sticky
  });

  it("rejects an invalid timezone", () => {
    const r = planReschedule(
      { timezone: "Not/AZone", starts_local: "2030-01-02T18:00" },
      60,
      at("2029-01-01T00:00:00Z"),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid datetime", () => {
    const r = planReschedule(
      { timezone: "America/Los_Angeles", starts_local: "soon" },
      60,
      at("2029-01-01T00:00:00Z"),
    );
    expect(r.ok).toBe(false);
  });
});
