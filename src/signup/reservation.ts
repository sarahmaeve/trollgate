/**
 * The persistent personalized link (IMPL.md). `:token` is signups.link_token
 * — an unguessable capability, so this is public (no GitHub re-auth to view
 * or self-cancel; that hardening is deferred). Free events under NoPayment:
 * cancel just sets 'canceled'; the seat frees itself because 'canceled' is
 * not in the seat-counting status set. Refund handling is Phase 6.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { layout, esc, formatInTz, errorCard } from "../view";
import {
  SIGNUP_STATUS,
  CANCELABLE_STATUSES,
  CANCELABLE_STATUSES_SQL,
  type SignupStatus,
} from "../db/constants";

export const reservation = new Hono<{ Bindings: Env }>();

interface SignupView {
  link_token: string;
  status: SignupStatus;
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

const isActive = (st: SignupStatus) =>
  (CANCELABLE_STATUSES as readonly string[]).includes(st);

function statusNotice(s: SignupView, started: boolean): string {
  if (s.status === SIGNUP_STATUS.canceled)
    return "This reservation was canceled.";
  if (started) return "This session has started; cancellation is closed.";
  return "Not cancelable.";
}

reservation.get("/r/:token", async (c) => {
  const s = await load(c.env, c.req.param("token"));
  if (!s) return c.html(errorCard("Reservation not found."), 404);

  const started = new Date(s.starts_at).getTime() <= Date.now();
  const cancelable = isActive(s.status) && !started;

  const control = cancelable
    ? `<form method="post" action="/r/${esc(s.link_token)}/cancel">
       <button type="submit">Cancel my spot</button></form>`
    : `<p class="muted">${statusNotice(s, started)}</p>`;

  return c.html(
    layout(`
    <span class="sticker">${esc(s.status)}</span>
    <h1 class="display">${esc(s.event_title)}</h1>
    <div class="card">
      <p class="label">Session</p><p>${esc(
        formatInTz(s.starts_at, s.timezone),
      )}</p>
      <p class="label">Reserved by</p><p>@${esc(s.github_login)} · ${esc(
        s.email,
      )}</p>
      ${control}
    </div>
    <p class="muted">Bookmark this link — it is your reservation.</p>`),
  );
});

reservation.post("/r/:token/cancel", async (c) => {
  const token = c.req.param("token");
  const s = await load(c.env, token);
  if (!s) return c.html(errorCard("Reservation not found."), 404);

  if (new Date(s.starts_at).getTime() <= Date.now())
    return c.html(
      errorCard("This session has already started — cancellation is closed."),
      409,
    );

  // Guarded: only an active reservation transitions. A second click updates
  // zero rows and is a no-op. Free/NoPayment → no refund; the freed seat is
  // implicit (status leaves the seat-counting set).
  await c.env.DB.prepare(
    `UPDATE signups SET status = '${SIGNUP_STATUS.canceled}',
            canceled_at = datetime('now')
      WHERE link_token = ?1 AND status IN ${CANCELABLE_STATUSES_SQL}`,
  )
    .bind(token)
    .run();

  return c.redirect(`/r/${token}`, 302);
});
