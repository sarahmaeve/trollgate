import { Hono } from "hono";
import type { Env } from "./env";
import { dbHealth } from "./db/queries";
import { scheduled } from "./cron";
import { newToken } from "./id";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchIdentity,
} from "./auth/github";
import {
  startOAuth,
  takeOAuthState,
  establishSession,
  destroySession,
  requireGitHub,
  type Vars,
} from "./auth/session";
import { bootstrapIdentity } from "./org/bootstrap";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trollgate</title>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/app.css">
</head>
<body><main class="stack">${body}</main></body>
</html>`;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );

/** Phase 0/1 health page. */
app.get("/", async (c) => {
  let status: string;
  let ok = false;
  try {
    const h = await dbHealth(c.env);
    ok = h.ok;
    status = `D1 connected · ${h.orgCount} organization(s)`;
  } catch (err) {
    status = `D1 not ready: ${(err as Error).message}`;
  }
  return c.html(
    page(`
    <span class="sticker">Phase&nbsp;1 · auth</span>
    <h1 class="display">TROLLGATE</h1>
    <div class="card">
      <p class="label">System check</p>
      <p class="${ok ? "ok" : "bad"}">${esc(status)}</p>
    </div>
    <a class="btn" href="/me">Sign in with GitHub</a>
    <p class="muted">Moderated signups for study groups, meetups &amp; classes.</p>`),
  );
});

app.get("/auth/github/login", async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.html(
      page(`<div class="card"><p class="label">Not configured</p>
      <p class="bad">GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are unset.</p>
      <p class="muted">Add them to <code>.dev.vars</code> (see
      <code>.dev.vars.example</code>) and restart.</p></div>`),
      500,
    );
  }
  const state = newToken(16);
  await startOAuth(c, state);
  return c.redirect(buildAuthorizeUrl(c.env, state), 302);
});

app.get("/auth/github/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  const expected = await takeOAuthState(c);
  if (!expected || !returnedState || returnedState !== expected) {
    return c.html(
      page(`<div class="card"><p class="bad">Invalid OAuth state.</p>
      <a class="btn" href="/auth/github/login">Try again</a></div>`),
      400,
    );
  }
  if (!code) {
    return c.html(
      page(`<div class="card"><p class="bad">Missing authorization code.</p></div>`),
      400,
    );
  }

  try {
    const token = await exchangeCode(c.env, code);
    const gh = await fetchIdentity(token);
    const identity = await bootstrapIdentity(c.env, gh);
    await establishSession(c, identity);
    return c.redirect("/me", 302);
  } catch (err) {
    return c.html(
      page(`<div class="card"><p class="bad">Sign-in failed: ${esc(
        (err as Error).message,
      )}</p>
      <a class="btn" href="/auth/github/login">Try again</a></div>`),
      502,
    );
  }
});

app.get("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/", 302);
});

/** Authenticated probe — verifies the session + bootstrap. Phase 3 replaces. */
app.get("/me", requireGitHub, async (c) => {
  const id = c.get("identity");
  const org = await c.env.DB.prepare(
    `SELECT name FROM organizations WHERE id = ?1`,
  )
    .bind(id.orgId)
    .first<{ name: string }>();

  return c.html(
    page(`
    <span class="sticker">Signed in</span>
    <h1 class="display">@${esc(id.githubLogin)}</h1>
    <div class="card">
      <p class="label">Identity</p>
      <p>${esc(id.email)}</p>
      <p class="label">Organization</p>
      <p>${esc(org?.name ?? "(missing)")}</p>
    </div>
    <a class="btn" href="/auth/logout">Sign out</a>`),
  );
});

export default {
  fetch: app.fetch,
  scheduled,
};
