/**
 * GitHub OAuth web flow — plain fetch, no SDK (IMPL.md "GitHub OAuth").
 * Four HTTPS calls: authorize redirect, token exchange, /user, /user/emails.
 */
import type { Env } from "../env";

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const SCOPE = "read:user user:email";
const UA = "trollgate";

export interface GitHubIdentity {
  id: number;
  login: string;
  name: string | null;
  email: string; // primary + verified
}

export function callbackUrl(env: Env): string {
  return `${env.BASE_URL}/auth/github/callback`;
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const u = new URL(AUTHORIZE);
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", callbackUrl(env));
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

export async function exchangeCode(env: Env, code: string): Promise<string> {
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(env),
    }),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const j = (await r.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`token exchange: ${j.error ?? "no token"}`);
  return j.access_token;
}

async function ghGet(path: string, token: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
    },
  });
}

export async function fetchIdentity(token: string): Promise<GitHubIdentity> {
  const ur = await ghGet("/user", token);
  if (!ur.ok) throw new Error(`/user failed: ${ur.status}`);
  const u = (await ur.json()) as {
    id: number;
    login: string;
    name: string | null;
  };

  const er = await ghGet("/user/emails", token);
  if (!er.ok) throw new Error(`/user/emails failed: ${er.status}`);
  const emails = (await er.json()) as {
    email: string;
    primary: boolean;
    verified: boolean;
  }[];

  const pick =
    emails.find((e) => e.primary && e.verified) ??
    emails.find((e) => e.verified);
  if (!pick) throw new Error("no verified GitHub email");

  return { id: u.id, login: u.login, name: u.name, email: pick.email };
}
