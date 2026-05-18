/**
 * The persistent personalized link (IMPL.md). `:token` is signups.link_token
 * — an unguessable capability, so this is public (no GitHub re-auth to view
 * or self-cancel; that hardening is deferred). Free events under NoPayment:
 * cancel just sets 'canceled'; the seat frees itself because 'canceled' is
 * not in the seat-counting status set. Refund handling is Phase 6.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { layout, esc } from "../view";

export const reservation = new Hono<{ Bindings: Env }>();

interface SignupView {
  link_token: string;
  status: string;
  event_title: string;
  timezone: string;
  starts_at: string;
  github_login: string;
  email: string;
}

async function load(env: Env, token: string): Promise<SignupView | null> {
  return env.DB.prepare(
    `SELECT s.link_token, s.status, s.github_login, s.email,
            e.title AS event_title, e.timezone, o.starts_at
       FROM signups s
       JOIN event_occurrences o ON o.id = s.occurrence_id
       JOIN events e ON e.id = s.event_id
      WHERE s.link_token = ?1`,
  )
    .bind(token)
    .first<SignupView>();
}

const when = (s: SignupView) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: s.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(s.starts_at));

reservation.get("/r/:token", async (c) => {
  const s = await load(c.env, c.req.param("token"));
  if (!s)
    return c.html(
      layout(`<div class="card"><p class="bad">Reservation not found.</p></div>`),
      404,
    );

  const active = s.status === "confirmed" || s.status === "pending_payment";
  const started = new Date(s.starts_at).getTime() <= Date.now();
  const cancelable = active && !started;

  return c.html(
    layout(`
    <span class="sticker">${esc(s.status)}</span>
    <h1 class="display">${esc(s.event_title)}</h1>
    <div class="card">
      <p class="label">Session</p><p>${esc(when(s))}</p>
      <p class="label">Reserved by</p><p>@${esc(s.github_login)} · ${esc(
        s.email,
      )}</p>
      ${
        cancelable
          ? `<form method="post" action="/r/${esc(s.link_token)}/cancel">
             <button type="submit">Cancel my spot</button></form>`
          : `<p class="muted">${
              s.status === "canceled"
                ? "This reservation was canceled."
                : started
                  ? "This session has started; cancellation is closed."
                  : "Not cancelable."
            }</p>`
      }
    </div>
    <p class="muted">Bookmark this link — it is your reservation.</p>`),
  );
});

reservation.post("/r/:token/cancel", async (c) => {
  const token = c.req.param("token");
  const s = await load(c.env, token);
  if (!s)
    return c.html(
      layout(`<div class="card"><p class="bad">Reservation not found.</p></div>`),
      404,
    );

  if (new Date(s.starts_at).getTime() <= Date.now())
    return c.html(
      layout(`<div class="card"><p class="bad">This session has already
      started — cancellation is closed.</p></div>`),
      409,
    );

  // Guarded: only an active reservation transitions. A second click updates
  // zero rows and is a no-op. Free/NoPayment → no refund; the freed seat is
  // implicit (status leaves the seat-counting set).
  await c.env.DB.prepare(
    `UPDATE signups SET status = 'canceled', canceled_at = datetime('now')
      WHERE link_token = ?1 AND status IN ('confirmed','pending_payment')`,
  )
    .bind(token)
    .run();

  return c.redirect(`/r/${token}`, 302);
});
