import { describe, it, expect } from "vitest";
import { esc } from "../src/view";

describe("esc (Finding 3 — escape single quotes)", () => {
  it("escapes the existing HTML metacharacters", () => {
    expect(esc(`a & b < c > d "q"`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;q&quot;",
    );
  });

  it("escapes single quotes so single-quoted attribute sinks are safe", () => {
    // Without this, a value rendered into attr='...' could break out.
    expect(esc("it's a 'test'")).toBe("it&#39;s a &#39;test&#39;");
    expect(esc("'")).not.toContain("'");
  });
});
