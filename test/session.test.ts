import { describe, it, expect } from "vitest";
import { isSecureCookie } from "../src/auth/session";
import type { Env } from "../src/env";

const env = (baseUrl: string) => ({ BASE_URL: baseUrl }) as Env;

describe("isSecureCookie (Finding 6 — fail closed on non-HTTPS)", () => {
  it("requires Secure for an https deployment", () => {
    expect(isSecureCookie(env("https://trollgate.example.com"))).toBe(true);
  });

  it("allows non-Secure only for local http development", () => {
    expect(isSecureCookie(env("http://localhost:8787"))).toBe(false);
    expect(isSecureCookie(env("http://127.0.0.1:8787"))).toBe(false);
    expect(isSecureCookie(env("http://[::1]:8787"))).toBe(false);
  });

  it("fails closed: a non-local http BASE_URL still gets a Secure cookie", () => {
    // A misconfigured production deploy (http instead of https) must not
    // silently ship the session token in cleartext-eligible cookies.
    expect(isSecureCookie(env("http://trollgate.example.com"))).toBe(true);
  });

  it("fails closed on an unparseable BASE_URL", () => {
    expect(isSecureCookie(env("not-a-url"))).toBe(true);
    expect(isSecureCookie(env(""))).toBe(true);
  });
});
