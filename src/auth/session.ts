/**
 * Sessions: opaque 256-bit token in an httpOnly cookie, data in KV
 * (IMPL.md — KV is the recommended session store). The token is rotated
 * after authentication to prevent session fixation. OAuth CSRF state lives
 * in the pre-auth session so one cookie covers the whole flow.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { newToken } from "../id";

const COOKIE = "tg_sess";
const PRE_AUTH_TTL = 600; // 10 min — long enough for the GitHub round-trip
// Absolute expiry, not sliding: a session ends 7 days after login
// regardless of activity (requireGitHub does not refresh it). Deliberate.
const SESSION_TTL = 7 * 24 * 60 * 60;

export interface Identity {
  userId: string;
  orgId: string;
  githubId: number;
  githubLogin: string;
  email: string;
}

interface SessionData {
  oauthState?: string;
  identity?: Identity;
}

export type Vars = { identity: Identity };

const kvKey = (token: string) => `sess:${token}`;

// Plain http is only legitimate for local development; anywhere else a
// non-https BASE_URL is a misconfiguration.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the session cookie must carry the `Secure` attribute (Finding 6).
 * Fails closed: anything that isn't explicitly local http — including a
 * misconfigured non-https production BASE_URL or an unparseable one — gets
 * `Secure`, so a deploy mistake breaks auth visibly rather than silently
 * shipping the session token over cleartext.
 */
export function isSecureCookie(env: Env): boolean {
  let url: URL;
  try {
    url = new URL(env.BASE_URL);
  } catch {
    return true;
  }
  if (url.protocol === "https:") return true;
  return !LOCAL_HOSTS.has(url.hostname);
}

function setSessionCookie(c: Context, env: Env, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: isSecureCookie(env),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

async function read(env: Env, token: string): Promise<SessionData | null> {
  const raw = await env.SESSIONS.get(kvKey(token));
  return raw ? (JSON.parse(raw) as SessionData) : null;
}

async function write(
  env: Env,
  token: string,
  data: SessionData,
  ttl: number,
): Promise<void> {
  await env.SESSIONS.put(kvKey(token), JSON.stringify(data), {
    expirationTtl: ttl,
  });
}

/** Begin OAuth: fresh session holding only the CSRF state. */
export async function startOAuth(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  state: string,
): Promise<void> {
  const token = newToken();
  await write(c.env, token, { oauthState: state }, PRE_AUTH_TTL);
  setSessionCookie(c, c.env, token);
}

/**
 * Pop the stored OAuth state and consume the pre-auth session so the state
 * is genuinely single-use (a replayed callback within the TTL cannot reuse
 * it) and abandoned flows don't linger until TTL.
 */
export async function takeOAuthState(
  c: Context<{ Bindings: Env; Variables: Vars }>,
): Promise<string | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const s = await read(c.env, token);
  await c.env.SESSIONS.delete(kvKey(token));
  return s?.oauthState ?? null;
}

/** Authenticated: rotate the token (fixation) and store the identity. */
export async function establishSession(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  identity: Identity,
): Promise<void> {
  const old = getCookie(c, COOKIE);
  if (old) await c.env.SESSIONS.delete(kvKey(old));

  const token = newToken();
  await write(c.env, token, { identity }, SESSION_TTL);
  setSessionCookie(c, c.env, token);
}

export async function destroySession(
  c: Context<{ Bindings: Env; Variables: Vars }>,
): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.SESSIONS.delete(kvKey(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Gate: redirect to GitHub login unless a session identity exists. */
export const requireGitHub: MiddlewareHandler<{
  Bindings: Env;
  Variables: Vars;
}> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  const session = token ? await read(c.env, token) : null;
  if (!session?.identity) {
    return c.redirect("/auth/github/login", 302);
  }
  c.set("identity", session.identity);
  await next();
};
