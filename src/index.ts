import { Hono } from "hono";
import type { Env } from "./env";
import { dbHealth } from "./db/queries";
import { scheduled } from "./cron";

const app = new Hono<{ Bindings: Env }>();

/**
 * Phase 0 health page. Confirms the Worker serves, static assets load, and
 * D1 is reachable with the schema applied. Replaced by the real landing page
 * in Phase 3.
 */
app.get("/", async (c) => {
  let status: string;
  let ok = false;
  try {
    const h = await dbHealth(c.env);
    ok = h.ok;
    status = `D1 connected · ${h.orgCount} organization(s) seeded`;
  } catch (err) {
    status = `D1 not ready: ${(err as Error).message}`;
  }

  return c.html(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trollgate</title>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main class="stack">
    <span class="sticker">Phase&nbsp;0 · scaffold</span>
    <h1 class="display">TROLLGATE</h1>
    <div class="card">
      <p class="label">System check</p>
      <p class="${ok ? "ok" : "bad"}">${status}</p>
    </div>
    <p class="muted">Moderated signups for study groups, meetups &amp; classes.</p>
  </main>
</body>
</html>`,
  );
});

export default {
  fetch: app.fetch,
  scheduled,
};
