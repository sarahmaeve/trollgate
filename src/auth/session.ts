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
import { errorCard, brandName, type Viewer } from "../view";

const COOKIE = "tg_sess";
const PRE_AUTH_TTL = 600; // 10 min — long enough for the GitHub round-trip
// Absolute expiry, not sliding: a session ends 1 hour after login
// regardless of activity (requireGitHub does not refresh it). Deliberate —
// short-lived for an identity/payments admin tool; re-login is one click.
// Drives both the KV TTL and the cookie Max-Age (single source).
const SESSION_TTL = 60 * 60;

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

export type Vars = { identity: Identity; viewer: Viewer };

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

// --- KV session lifecycle (Context-free, unit-testable) ---

/**
 * Begin OAuth: write a fresh pre-auth session holding only the CSRF state,
 * and invalidate any session the caller already held — starting a new login
 * supersedes the current one, so its KV entry must not be left orphaned
 * (it would otherwise stay valid for the full TTL after re-login).
 */
export async function beginOAuthSession(
  env: Env,
  priorToken: string | null,
  state: string,
): Promise<string> {
  if (priorToken) await env.SESSIONS.delete(kvKey(priorToken));
  const token = newToken();
  await write(env, token, { oauthState: state }, PRE_AUTH_TTL);
  return token;
}

/** Read + delete the pre-auth session so the OAuth state is single-use. */
export async function consumeOAuthState(
  env: Env,
  token: string | null,
): Promise<string | null> {
  if (!token) return null;
  const s = await read(env, token);
  await env.SESSIONS.delete(kvKey(token));
  return s?.oauthState ?? null;
}

/** Rotate to a fresh identity session (fixation), dropping the prior token. */
export async function establishIdentitySession(
  env: Env,
  priorToken: string | null,
  identity: Identity,
): Promise<string> {
  if (priorToken) await env.SESSIONS.delete(kvKey(priorToken));
  const token = newToken();
  await write(env, token, { identity }, SESSION_TTL);
  return token;
}

// --- Context wrappers (cookie I/O only; logic above) ---

/** Begin OAuth: fresh CSRF-state session, prior session invalidated. */
export async function startOAuth(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  state: string,
): Promise<void> {
  const token = await beginOAuthSession(
    c.env,
    getCookie(c, COOKIE) ?? null,
    state,
  );
  setSessionCookie(c, c.env, token);
}

/** Pop the stored OAuth state (single-use; pre-auth session consumed). */
export async function takeOAuthState(
  c: Context<{ Bindings: Env; Variables: Vars }>,
): Promise<string | null> {
  return consumeOAuthState(c.env, getCookie(c, COOKIE) ?? null);
}

/** Authenticated: rotate the token (fixation) and store the identity. */
export async function establishSession(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  identity: Identity,
): Promise<void> {
  const token = await establishIdentitySession(
    c.env,
    getCookie(c, COOKIE) ?? null,
    identity,
  );
  setSessionCookie(c, c.env, token);
}

export async function destroySession(
  c: Context<{ Bindings: Env; Variables: Vars }>,
): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.SESSIONS.delete(kvKey(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

/**
 * Soft, non-redirecting: resolve the viewer for the global nav on every
 * request (signed-in pages and public/anon alike). Never blocks.
 */
export const loadViewer: MiddlewareHandler<{
  Bindings: Env;
  Variables: Vars;
}> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  const id = token ? (await read(c.env, token))?.identity : undefined;
  c.set("viewer", {
    signedIn: !!id,
    login: id?.githubLogin ?? null,
    isOrganizer: id ? isOrganizer(c.env, id.githubId) : false,
    brand: brandName(c.env),
  });
  await next();
};

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

/** GitHub ids allowed to create/manage events. Empty set → fail closed. */
export function adminIds(env: Env): Set<number> {
  return new Set(
    (env.ADMIN_GITHUB_IDS ?? "")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n)),
  );
}

export function isOrganizer(env: Env, githubId: number): boolean {
  return adminIds(env).has(githubId);
}

/**
 * Gate after requireGitHub: only allowlisted GitHub ids may create/manage
 * events. Everyone else keeps attendee access (public signup is untouched).
 */
export const requireOrganizer: MiddlewareHandler<{
  Bindings: Env;
  Variables: Vars;
}> = async (c, next) => {
  const id = c.get("identity");
  if (!id || !isOrganizer(c.env, id.githubId))
    return errorCard(c, "You don't have organizer access on this instance.", {
      status: 403,
    });
  await next();
};
