/**
 * Organizer surface: dashboard, attendee list (HTML + CSV — the explicit
 * trollgate.md MVP bullet), and series cancel. Authorization is by membership
 * in the event's org; owner/admin may cancel, staff is read-only. Cancel
 * enqueues `event_canceled` notifications in the same D1 batch; Resend
 * delivery is the Cron drain.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { requireGitHub, requireOrganizer, type Vars } from "../auth/session";
import { chrome, esc, formatInTz, errorCard } from "../view";
import {
  eventCanceledNotificationStmts,
  eventRescheduledNotificationStmts,
} from "../notify/outbox";
import { planReschedule, type RescheduleInput } from "./event-form";
import { timezoneOptions } from "./timezones";
import { csvField } from "./csv";
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
manage.use("/manage/*", requireOrganizer);

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

interface AuthorizedEvent {
  id: string;
  title: string;
  description: string;
  timezone: string;
  max_seats: number;
  duration_min: number;
  deposit_cents: number;
  status: EventStatus;
  role: Role;
}

async function authorize(
  env: Env,
  userId: string,
  eventId: string,
): Promise<AuthorizedEvent | null> {
  return env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.timezone, e.max_seats,
            e.duration_min, e.deposit_cents, e.status, m.role
       FROM events e
       JOIN memberships m ON m.org_id = e.org_id
      WHERE e.id = ?1 AND m.user_id = ?2`,
  )
    .bind(eventId, userId)
    .first<AuthorizedEvent>();
}

const forbidden = (c: Ctx) =>
  errorCard(c, "Not authorized for this event.", { status: 403 });

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
    `SELECT o.id, o.starts_at, o.status,
            (SELECT COUNT(*) FROM signups s
              WHERE s.occurrence_id = o.id
                AND s.status = '${SIGNUP_STATUS.confirmed}') AS confirmed
       FROM event_occurrences o
      WHERE o.event_id = ?1
      ORDER BY o.starts_at`,
  )
    .bind(ev.id)
    .all<{ id: string; starts_at: string; status: string; confirmed: number }>();

  const reschedulable = (o: { status: string; starts_at: string }) =>
    o.status === OCCURRENCE_STATUS.scheduled &&
    new Date(o.starts_at).getTime() > Date.now();

  const rows = occ
    .map(
      (o) =>
        `<li>${esc(formatInTz(o.starts_at, ev.timezone))} —
         ${o.confirmed}/${ev.max_seats}
         <span class="label">${esc(o.status)}</span>${
           reschedulable(o)
             ? ` <a href="/manage/${esc(ev.id)}/occurrences/${esc(
                 o.id,
               )}/reschedule">reschedule</a>`
             : ""
         }</li>`,
    )
    .join("");

  return c.html(
    chrome(
      c,
      `
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
    chrome(
      c,
      `
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

manage.get("/manage/:id/list.csv", async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const rows = await confirmedAttendees(c.env, ev.id);
  const lines = [
    ["session_starts_at_utc", "github_login", "email", "status"]
      .map(csvField)
      .join(","),
    ...rows.map((r) =>
      [r.starts_at, r.github_login, r.email, r.status].map(csvField).join(","),
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
    return errorCard(c, `Your role (${ev.role}) cannot cancel this event.`, {
      href: `/manage/${ev.id}`,
      label: "Back",
      status: 403,
    });

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
    chrome(
      c,
      `
    <span class="sticker">Canceled</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>Event canceled. ${affected.length} confirmed attendee(s) queued
      for a cancellation email.</p>
    </div>
    <a class="btn" href="/manage/${esc(ev.id)}">Back</a>`,
    ),
  );
});

interface OccRow {
  id: string;
  starts_at: string;
  status: string;
}

/** Load an occurrence that is reschedulable: belongs to the event, still
 *  scheduled, and has not already started. */
async function loadReschedulable(
  env: Env,
  eventId: string,
  occId: string,
): Promise<OccRow | { error: string }> {
  const occ = await env.DB.prepare(
    `SELECT id, starts_at, status FROM event_occurrences
      WHERE id = ?1 AND event_id = ?2`,
  )
    .bind(occId, eventId)
    .first<OccRow>();
  if (!occ) return { error: "Session not found." };
  if (occ.status !== OCCURRENCE_STATUS.scheduled)
    return { error: "This session is no longer scheduled." };
  if (new Date(occ.starts_at).getTime() <= Date.now())
    return { error: "This session has already started." };
  return occ;
}

function renderRescheduleForm(
  c: Ctx,
  ev: AuthorizedEvent,
  occ: OccRow,
  raw: RescheduleInput,
  errors: string[],
): string {
  const tz = raw.timezone || ev.timezone;
  const tzOptions = timezoneOptions()
    .map((z) => `<option${z === tz ? " selected" : ""}>${esc(z)}</option>`)
    .join("");
  const errorBlock =
    errors.length > 0
      ? `<div class="card"><p class="bad">Please fix:</p><ul>${errors
          .map((e) => `<li>${esc(e)}</li>`)
          .join("")}</ul></div>`
      : "";
  return chrome(
    c,
    `
    <span class="sticker">Reschedule</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card"><p class="label">Currently</p>
      <p>${esc(formatInTz(occ.starts_at, ev.timezone))}</p></div>
    ${errorBlock}
    <form class="card" method="post"
      action="/manage/${esc(ev.id)}/occurrences/${esc(occ.id)}/reschedule">
      <p class="label">Timezone</p>
      <select name="timezone" required>${tzOptions}</select>
      <p class="label">New date &amp; time (local)</p>
      <input name="starts_local" type="datetime-local" required
        value="${esc(raw.starts_local)}">
      <button type="submit">Reschedule &amp; notify attendees</button>
    </form>
    <a class="btn" href="/manage/${esc(ev.id)}">Back</a>`,
  );
}

const RESCHEDULE = "/manage/:id/occurrences/:occId/reschedule";

manage.get(RESCHEDULE, async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const occ = await loadReschedulable(c.env, ev.id, c.req.param("occId"));
  if ("error" in occ) return errorCard(c, occ.error, { status: 409 });

  // Paid events: reschedule must refund + warn attendees (Phase 6, behind
  // the payment seam). Free events reschedule freely below.
  if (ev.deposit_cents > 0)
    return errorCard(
      c,
      "Rescheduling a paid event (refund + attendee warning) arrives in Phase 6.",
      { status: 501, href: `/manage/${ev.id}`, label: "Back" },
    );

  return c.html(
    renderRescheduleForm(c, ev, occ, { timezone: "", starts_local: "" }, []),
  );
});

manage.post(RESCHEDULE, async (c) => {
  const uid = c.get("identity").userId;
  const ev = await authorize(c.env, uid, c.req.param("id"));
  if (!ev) return forbidden(c);

  const occ = await loadReschedulable(c.env, ev.id, c.req.param("occId"));
  if ("error" in occ) return errorCard(c, occ.error, { status: 409 });

  if (ev.deposit_cents > 0)
    return errorCard(
      c,
      "Rescheduling a paid event (refund + attendee warning) arrives in Phase 6.",
      { status: 501, href: `/manage/${ev.id}`, label: "Back" },
    );

  const f = await c.req.formData();
  const input: RescheduleInput = {
    timezone: String(f.get("timezone") ?? ""),
    starts_local: String(f.get("starts_local") ?? ""),
  };

  const plan = planReschedule(input, ev.duration_min);
  if (!plan.ok)
    return c.html(
      renderRescheduleForm(c, ev, occ, plan.raw, plan.errors),
      400,
    );

  const { results: attendees } = await c.env.DB.prepare(
    `SELECT id, email FROM signups
      WHERE occurrence_id = ?1 AND status = '${SIGNUP_STATUS.confirmed}'`,
  )
    .bind(occ.id)
    .all<{ id: string; email: string }>();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE event_occurrences SET starts_at = ?1, ends_at = ?2
        WHERE id = ?3 AND event_id = ?4
          AND status = '${OCCURRENCE_STATUS.scheduled}'`,
    ).bind(plan.startsAt, plan.endsAt, occ.id, ev.id),
    // Same batch as the move (atomic); drained by the Cron.
    ...eventRescheduledNotificationStmts(c.env, attendees),
  ]);

  return c.redirect(`/manage/${ev.id}`, 302);
});
