import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  isSecureCookie,
  beginOAuthSession,
  consumeOAuthState,
  establishIdentitySession,
  type Identity,
} from "../src/auth/session";
import type { Env } from "../src/env";

const envFor = (baseUrl: string) => ({ BASE_URL: baseUrl }) as Env;

describe("isSecureCookie (Finding 6 — fail closed on non-HTTPS)", () => {
  it("requires Secure for an https deployment", () => {
    expect(isSecureCookie(envFor("https://trollgate.example.com"))).toBe(true);
  });

  it("allows non-Secure only for local http development", () => {
    expect(isSecureCookie(envFor("http://localhost:8787"))).toBe(false);
    expect(isSecureCookie(envFor("http://127.0.0.1:8787"))).toBe(false);
    expect(isSecureCookie(envFor("http://[::1]:8787"))).toBe(false);
  });

  it("fails closed: a non-local http BASE_URL still gets a Secure cookie", () => {
    // A misconfigured production deploy (http instead of https) must not
    // silently ship the session token in cleartext-eligible cookies.
    expect(isSecureCookie(envFor("http://trollgate.example.com"))).toBe(true);
  });

  it("fails closed on an unparseable BASE_URL", () => {
    expect(isSecureCookie(envFor("not-a-url"))).toBe(true);
    expect(isSecureCookie(envFor(""))).toBe(true);
  });
});

const IDENTITY: Identity = {
  userId: "usr_test",
  orgId: "org_test",
  githubId: 1178870,
  githubLogin: "sarahmaeve",
  email: "sarah.maeve.m@gmail.com",
};

async function sessionKeys(): Promise<string[]> {
  const { keys } = await env.SESSIONS.list();
  return keys.map((k) => k.name).filter((n) => n.startsWith("sess:"));
}

describe("session KV lifecycle", () => {
  beforeEach(async () => {
    for (const name of await sessionKeys()) await env.SESSIONS.delete(name);
  });

  it("OAuth state is single-use (pre-auth session consumed)", async () => {
    const pre = await beginOAuthSession(env, null, "state-abc");
    expect(await consumeOAuthState(env, pre)).toBe("state-abc");
    // Second read: pre-auth session is gone, replay yields nothing.
    expect(await consumeOAuthState(env, pre)).toBeNull();
  });

  it("re-login does not orphan the prior identity session", async () => {
    // First login.
    const pre1 = await beginOAuthSession(env, null, "s1");
    await consumeOAuthState(env, pre1);
    const id1 = await establishIdentitySession(env, pre1, IDENTITY);
    expect(await env.SESSIONS.get(`sess:${id1}`)).not.toBeNull();

    // Re-login while the browser still holds the id1 identity cookie.
    const pre2 = await beginOAuthSession(env, id1, "s2");
    await consumeOAuthState(env, pre2);
    const id2 = await establishIdentitySession(env, pre2, IDENTITY);

    // The prior identity session must be invalidated, not left valid for
    // its full TTL; exactly one identity session should remain.
    expect(await env.SESSIONS.get(`sess:${id1}`)).toBeNull();
    expect(await env.SESSIONS.get(`sess:${id2}`)).not.toBeNull();
    expect(await sessionKeys()).toEqual([`sess:${id2}`]);
  });
});
