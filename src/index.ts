import { Hono } from "hono";
import type { Env } from "./env";
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
  loadViewer,
  type Vars,
} from "./auth/session";
import { bootstrapIdentity } from "./org/bootstrap";
import { chrome, esc, errorCard } from "./view";
import { events } from "./events/manage";
import { manage } from "./events/dashboard";
import { pub } from "./events/public";
import { signup } from "./signup/handlers";
import { reservation } from "./signup/reservation";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Resolve nav state for every request before any route renders.
app.use("*", loadViewer);

// Distinct path spaces; order is not significant between them.
app.route("/", events); // /events/* (organizer, auth)
app.route("/", manage); // /manage/* (organizer, auth)
app.route("/", signup); // /o/:id/signup (auth)
app.route("/", reservation); // /r/:token (public capability)
app.route("/", pub); // / and /e/:id (public)

app.get("/auth/github/login", async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.html(
      chrome(
        c,
        `<div class="card"><p class="label">Not configured</p>
      <p class="bad">GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are unset.</p>
      <p class="muted">Add them to <code>.dev.vars</code> (see
      <code>.dev.vars.example</code>) and restart.</p></div>`,
      ),
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

  const back = { href: "/auth/github/login", label: "Try again" };
  const expected = await takeOAuthState(c);
  if (!expected || !returnedState || returnedState !== expected)
    return errorCard(c, "Invalid OAuth state.", { ...back, status: 400 });
  if (!code)
    return errorCard(c, "Missing authorization code.", { ...back, status: 400 });

  try {
    const token = await exchangeCode(c.env, code);
    const gh = await fetchIdentity(token);
    const identity = await bootstrapIdentity(c.env, gh);
    await establishSession(c, identity);
    return c.redirect("/me", 302);
  } catch (err) {
    return errorCard(c, `Sign-in failed: ${(err as Error).message}`, {
      ...back,
      status: 502,
    });
  }
});

app.get("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/", 302);
});

/** Signed-in account view: confirms the session + bootstrapped org. */
app.get("/me", requireGitHub, async (c) => {
  const id = c.get("identity");
  const org = await c.env.DB.prepare(
    `SELECT name FROM organizations WHERE id = ?1`,
  )
    .bind(id.orgId)
    .first<{ name: string }>();

  return c.html(
    chrome(
      c,
      `
    <span class="sticker">Account</span>
    <h1 class="display">@${esc(id.githubLogin)}</h1>
    <div class="card">
      <p class="label">Identity</p>
      <p>${esc(id.email)}</p>
      <p class="label">Organization</p>
      <p>${esc(org?.name ?? "(missing)")}</p>
    </div>`,
    ),
  );
});

export default {
  fetch: app.fetch,
  scheduled,
};
