import { describe, it, expect } from "vitest";
import { esc, brandName } from "../src/view";
import type { Env } from "../src/env";

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

describe("brandName (configurable in production)", () => {
  const env = (v?: string) => ({ BRAND_NAME: v }) as Env;

  it("defaults to Trollgate when unset or blank", () => {
    expect(brandName(env())).toBe("Trollgate");
    expect(brandName(env(""))).toBe("Trollgate");
    expect(brandName(env("   "))).toBe("Trollgate");
  });

  it("uses the configured brand, trimmed", () => {
    expect(brandName(env("Git Up & Go"))).toBe("Git Up & Go");
    expect(brandName(env("  Acme  "))).toBe("Acme");
  });
});
