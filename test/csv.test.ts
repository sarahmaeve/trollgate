import { describe, it, expect } from "vitest";
import { csvField } from "../src/events/csv";

describe("csvField (Finding 4 — CSV formula injection)", () => {
  it("RFC 4180 quotes every field and doubles embedded quotes", () => {
    expect(csvField("plain")).toBe('"plain"');
    expect(csvField('a "quoted" b')).toBe('"a ""quoted"" b"');
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("neutralizes a leading formula trigger so spreadsheets don't execute it", () => {
    // =, +, -, @, tab and CR are the spreadsheet formula triggers.
    for (const evil of [
      "=cmd|'/c calc'!A1",
      "+1+1",
      "-2+3",
      "@SUM(A1)",
      "\t=1+1",
      "\r=1+1",
    ]) {
      const out = csvField(evil);
      // The cell value (inside the quotes) must start with the neutralizing
      // single quote, not the trigger character.
      expect(out.startsWith(`"'`)).toBe(true);
    }
  });

  it("leaves a safe field (e.g. an ISO date or normal login) untouched", () => {
    expect(csvField("2026-06-02T23:00:00.000Z")).toBe(
      '"2026-06-02T23:00:00.000Z"',
    );
    expect(csvField("octocat")).toBe('"octocat"');
  });
});
