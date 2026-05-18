/**
 * Organizer surface (Phase 4): dashboard, attendee list (HTML + CSV — the
 * explicit trollgate.md MVP bullet), and series cancel. Authorization is by
 * membership in the event's org; owner/admin may cancel, staff is read-only.
 * Cancel enqueues `event_canceled` notifications in the same D1 batch;
 * Resend delivery is Phase 5.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { requireGitHub, type Vars } from "../auth/session";
import { layout, esc } from "../view";
import { eventCanceledNotificationStmts } from "../notify/outbox";

export const manage = new Hono<{ Bindings: Env; Variables: Vars }>();

manage.use("/manage/*", requireGitHub);

interface AuthorizedEvent {
  id: string;
  title: string;
  description: string;
  timezone: string;
  max_seats: number;
  status: string;
  role: string; // owner | admin | staff
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

const forbidden = (c: any) =>
  c.html(
    layout(`<div class="card"><p class="bad">Not authorized for this
    event.</p><a class="btn" href="/">Home</a></div>`),
    403,
  );

const fmt = (iso: string, tz: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

manage.get("/manage/:id", async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const { results: occ } = await c.env.DB.prepare(
    `SELECT o.starts_at, o.status,
            (SELECT COUNT(*) FROM signups s
              WHERE s.occurrence_id = o.id AND s.status = 'confirmed')
              AS confirmed
       FROM event_occurrences o
      WHERE o.event_id = ?1
      ORDER BY o.starts_at`,
  )
    .bind(ev.id)
    .all<{ starts_at: string; status: string; confirmed: number }>();

  const canCancel =
    (ev.role === "owner" || ev.role === "admin") && ev.status === "open";

  const rows = occ
    .map(
      (o) =>
        `<li>${esc(fmt(o.starts_at, ev.timezone))} —
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
    ${
      canCancel
        ? `<form method="post" action="/manage/${esc(ev.id)}/cancel">
           <button type="submit">Cancel this event</button></form>`
        : ev.status !== "open"
          ? `<p class="muted">Event is ${esc(ev.status)}.</p>`
          : `<p class="muted">Your role (${esc(
              ev.role,
            )}) cannot cancel.</p>`
    }`),
  );
});

interface AttendeeRow {
  github_login: string;
  email: string;
  status: string;
  starts_at: string;
}

async function confirmedAttendees(
  env: Env,
  eventId: string,
): Promise<AttendeeRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.github_login, s.email, s.status, o.starts_at
       FROM signups s
       JOIN event_occurrences o ON o.id = s.occurrence_id
      WHERE s.event_id = ?1 AND s.status = 'confirmed'
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
        `<tr><td>${esc(fmt(r.starts_at, ev.timezone))}</td>
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

  if (ev.role !== "owner" && ev.role !== "admin")
    return c.html(
      layout(`<div class="card"><p class="bad">Your role (${esc(
        ev.role,
      )}) cannot cancel this event.</p></div>`),
      403,
    );

  if (ev.status !== "open")
    return c.redirect(`/manage/${ev.id}`, 302);

  // Snapshot confirmed signups before flipping, to enqueue notifications.
  const affected = await confirmedAttendees(c.env, ev.id);
  const affectedIds = await c.env.DB.prepare(
    `SELECT id, email FROM signups
      WHERE event_id = ?1 AND status = 'confirmed'`,
  )
    .bind(ev.id)
    .all<{ id: string; email: string }>();

  const batch = [
    c.env.DB.prepare(
      `UPDATE events SET status='canceled' WHERE id=?1 AND status='open'`,
    ).bind(ev.id),
    c.env.DB.prepare(
      `UPDATE event_occurrences SET status='canceled'
        WHERE event_id=?1 AND status='scheduled'`,
    ).bind(ev.id),
    c.env.DB.prepare(
      `UPDATE signups SET status='canceled', canceled_at=datetime('now')
        WHERE event_id=?1 AND status='confirmed'`,
    ).bind(ev.id),
    c.env.DB.prepare(
      `UPDATE signups SET status='abandoned'
        WHERE event_id=?1 AND status='pending_payment'`,
    ).bind(ev.id),
    // Outbox enqueue, same batch as the cancel (atomic). Resend delivery
    // happens on the Cron drain (Phase 5).
    ...eventCanceledNotificationStmts(c.env, affectedIds.results),
  ];

  await c.env.DB.batch(batch);

  return c.html(
    layout(`
    <span class="sticker">Canceled</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>Event canceled. ${affected.length} confirmed attendee(s) queued
      for a cancellation email (delivery: Phase&nbsp;5).</p>
    </div>
    <a class="btn" href="/manage/${esc(ev.id)}">Back</a>`),
  );
});
