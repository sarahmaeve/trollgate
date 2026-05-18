/**
 * Organizer surface: dashboard, attendee list (HTML + CSV — the explicit
 * trollgate.md MVP bullet), and series cancel. Authorization is by membership
 * in the event's org; owner/admin may cancel, staff is read-only. Cancel
 * enqueues `event_canceled` notifications in the same D1 batch; Resend
 * delivery is the Cron drain.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { requireGitHub, type Vars } from "../auth/session";
import { layout, esc, formatInTz, errorCard } from "../view";
import { eventCanceledNotificationStmts } from "../notify/outbox";
import {
  ROLE,
  EVENT_STATUS,
  OCCURRENCE_STATUS,
  SIGNUP_STATUS,
  type Role,
  type EventStatus,
} from "../db/constants";

export const manage = new Hono<{ Bindings: Env; Variables: Vars }>();

manage.use("/manage/*", requireGitHub);

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

interface AuthorizedEvent {
  id: string;
  title: string;
  description: string;
  timezone: string;
  max_seats: number;
  status: EventStatus;
  role: Role;
}

async function authorize(
  env: Env,
  userId: string,
  eventId: string,
): Promise<AuthorizedEvent | null> {
  return env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.timezone, e.max_seats, e.status,
            m.role
       FROM events e
       JOIN memberships m ON m.org_id = e.org_id
      WHERE e.id = ?1 AND m.user_id = ?2`,
  )
    .bind(eventId, userId)
    .first<AuthorizedEvent>();
}

const forbidden = (c: Ctx) =>
  c.html(errorCard("Not authorized for this event."), 403);

const canCancel = (ev: AuthorizedEvent) =>
  (ev.role === ROLE.owner || ev.role === ROLE.admin) &&
  ev.status === EVENT_STATUS.open;

function cancelControl(ev: AuthorizedEvent): string {
  if (canCancel(ev))
    return `<form method="post" action="/manage/${esc(ev.id)}/cancel">
      <button type="submit">Cancel this event</button></form>`;
  if (ev.status !== EVENT_STATUS.open)
    return `<p class="muted">Event is ${esc(ev.status)}.</p>`;
  return `<p class="muted">Your role (${esc(ev.role)}) cannot cancel.</p>`;
}

manage.get("/manage/:id", async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const { results: occ } = await c.env.DB.prepare(
    `SELECT o.starts_at, o.status,
            (SELECT COUNT(*) FROM signups s
              WHERE s.occurrence_id = o.id
                AND s.status = '${SIGNUP_STATUS.confirmed}') AS confirmed
       FROM event_occurrences o
      WHERE o.event_id = ?1
      ORDER BY o.starts_at`,
  )
    .bind(ev.id)
    .all<{ starts_at: string; status: string; confirmed: number }>();

  const rows = occ
    .map(
      (o) =>
        `<li>${esc(formatInTz(o.starts_at, ev.timezone))} —
         ${o.confirmed}/${ev.max_seats}
         <span class="label">${esc(o.status)}</span></li>`,
    )
    .join("");

  return c.html(
    layout(`
    <span class="sticker">${esc(ev.status)} · ${esc(ev.role)}</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>${esc(ev.description)}</p>
      <p class="label">Sessions</p>
      <ul>${rows || "<li>(none)</li>"}</ul>
    </div>
    <a class="btn" href="/manage/${esc(ev.id)}/list">Attendee list</a>
    <a class="btn" href="/manage/${esc(ev.id)}/list.csv">Download CSV</a>
    ${cancelControl(ev)}`),
  );
});

interface AttendeeRow {
  signup_id: string;
  github_login: string;
  email: string;
  status: string;
  starts_at: string;
}

/** Confirmed reservations across the series — feeds list, CSV, and cancel. */
async function confirmedAttendees(
  env: Env,
  eventId: string,
): Promise<AttendeeRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS signup_id, s.github_login, s.email, s.status, o.starts_at
       FROM signups s
       JOIN event_occurrences o ON o.id = s.occurrence_id
      WHERE s.event_id = ?1 AND s.status = '${SIGNUP_STATUS.confirmed}'
      ORDER BY o.starts_at, s.github_login`,
  )
    .bind(eventId)
    .all<AttendeeRow>();
  return results;
}

manage.get("/manage/:id/list", async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const rows = await confirmedAttendees(c.env, ev.id);
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(formatInTz(r.starts_at, ev.timezone))}</td>
         <td>@${esc(r.github_login)}</td><td>${esc(r.email)}</td></tr>`,
    )
    .join("");

  return c.html(
    layout(`
    <span class="sticker">Attendees · ${rows.length}</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <table>
        <thead><tr><th>Session</th><th>GitHub</th><th>Email</th></tr></thead>
        <tbody>${body || '<tr><td colspan="3">No confirmed reservations.</td></tr>'}</tbody>
      </table>
    </div>
    <a class="btn" href="/manage/${esc(ev.id)}/list.csv">Download CSV</a>
    <a class="btn" href="/manage/${esc(ev.id)}">Back</a>`),
  );
});

/** RFC 4180: quote every field, escape embedded quotes by doubling. */
const csv = (v: string) => `"${v.replace(/"/g, '""')}"`;

manage.get("/manage/:id/list.csv", async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const rows = await confirmedAttendees(c.env, ev.id);
  const lines = [
    ["session_starts_at_utc", "github_login", "email", "status"]
      .map(csv)
      .join(","),
    ...rows.map((r) =>
      [r.starts_at, r.github_login, r.email, r.status].map(csv).join(","),
    ),
  ];
  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="trollgate-${ev.id}.csv"`,
    },
  });
});

manage.post("/manage/:id/cancel", async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  if (ev.role !== ROLE.owner && ev.role !== ROLE.admin)
    return c.html(
      errorCard(`Your role (${ev.role}) cannot cancel this event.`, {
        href: `/manage/${ev.id}`,
        label: "Back",
      }),
      403,
    );

  if (ev.status !== EVENT_STATUS.open)
    return c.redirect(`/manage/${ev.id}`, 302);

  // Snapshot confirmed signups once — used for both the notification
  // enqueue and the count shown below.
  const affected = await confirmedAttendees(c.env, ev.id);

  const batch = [
    c.env.DB.prepare(
      `UPDATE events SET status='${EVENT_STATUS.canceled}'
        WHERE id=?1 AND status='${EVENT_STATUS.open}'`,
    ).bind(ev.id),
    c.env.DB.prepare(
      `UPDATE event_occurrences SET status='${OCCURRENCE_STATUS.canceled}'
        WHERE event_id=?1 AND status='${OCCURRENCE_STATUS.scheduled}'`,
    ).bind(ev.id),
    c.env.DB.prepare(
      `UPDATE signups SET status='${SIGNUP_STATUS.canceled}',
              canceled_at=datetime('now')
        WHERE event_id=?1 AND status='${SIGNUP_STATUS.confirmed}'`,
    ).bind(ev.id),
    c.env.DB.prepare(
      `UPDATE signups SET status='${SIGNUP_STATUS.abandoned}'
        WHERE event_id=?1 AND status='${SIGNUP_STATUS.pendingPayment}'`,
    ).bind(ev.id),
    // Outbox enqueue, same batch as the cancel (atomic). Resend delivery
    // happens on the Cron drain.
    ...eventCanceledNotificationStmts(
      c.env,
      affected.map((a) => ({ id: a.signup_id, email: a.email })),
    ),
  ];

  await c.env.DB.batch(batch);

  return c.html(
    layout(`
    <span class="sticker">Canceled</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>Event canceled. ${affected.length} confirmed attendee(s) queued
      for a cancellation email.</p>
    </div>
    <a class="btn" href="/manage/${esc(ev.id)}">Back</a>`),
  );
});
