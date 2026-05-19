/**
 * Create-event flow. Deposit is forced to 0 for the MVP — paid events need
 * the Phase 6 StripePayment provider, so allowing >0 here would break the
 * NoPayment invariant. Recurrence is a friendly form (one-off / weekly-by-N),
 * not a raw RRULE; iCal assembly + validation live in event-form.ts.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { requireGitHub, requireOrganizer, type Vars } from "../auth/session";
import { materializeEvent } from "./materialize";
import {
  parseCreateEventForm,
  type RawEventForm,
  type EventFormFields,
} from "./event-form";
import { timezoneOptions } from "./timezones";
import { newId } from "../id";
import { chrome, esc, errorCard, formatInTz } from "../view";

export const events = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULTS: EventFormFields = {
  title: "",
  description: "",
  requirements: "",
  timezone: "America/Los_Angeles",
  starts_local: "",
  duration_min: "60",
  frequency: "once",
  weekly_count: "8",
  max_seats: "10",
};

function renderEventForm(
  c: Parameters<typeof chrome>[0],
  raw: EventFormFields,
  errors: string[],
): string {
  const v = (k: keyof EventFormFields) => esc(raw[k] !== "" ? raw[k] : DEFAULTS[k]);
  const sel = (k: "timezone" | "frequency", opt: string) =>
    (raw[k] || DEFAULTS[k]) === opt ? " selected" : "";

  const tzOptions = timezoneOptions()
    .map((z) => `<option${sel("timezone", z)}>${esc(z)}</option>`)
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
    <span class="sticker">New event</span>
    <h1 class="display">Create</h1>
    ${errorBlock}
    <form class="card" method="post" action="/events">
      <p class="label">Title</p>
      <input name="title" required maxlength="120" value="${v("title")}">
      <p class="label">Description</p>
      <textarea name="description" required rows="3">${v("description")}</textarea>
      <p class="label">Requirements (optional)</p>
      <input name="requirements" maxlength="240" value="${v("requirements")}">
      <p class="label">Timezone</p>
      <select name="timezone" required>${tzOptions}</select>
      <p class="label">First session (local)</p>
      <input name="starts_local" type="datetime-local" required value="${v(
        "starts_local",
      )}">
      <p class="label">Duration (minutes)</p>
      <input name="duration_min" type="number" min="1" value="${v(
        "duration_min",
      )}" required>
      <p class="label">Repeats</p>
      <select name="frequency" required>
        <option value="once"${sel("frequency", "once")}>Single session</option>
        <option value="weekly"${sel("frequency", "weekly")}>Weekly</option>
      </select>
      <p class="label">If weekly: number of sessions</p>
      <input name="weekly_count" type="number" min="1" value="${v(
        "weekly_count",
      )}">
      <p class="label">Max seats</p>
      <input name="max_seats" type="number" min="1" value="${v(
        "max_seats",
      )}" required>
      <button type="submit">Create event</button>
    </form>
    <p class="muted">Weekly repeats on the first session's weekday.
    Paid deposits arrive in Phase&nbsp;6; MVP events are free.</p>`,
  );
}

events.use("/events/*", requireGitHub);
events.use("/events/*", requireOrganizer);

events.get("/events", async (c) => {
  const id = c.get("identity");
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, status FROM events
      WHERE org_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(id.orgId)
    .all<{ id: string; title: string; status: string }>();

  const rows = results
    .map(
      (e) =>
        `<li class="card"><a href="/manage/${esc(e.id)}">${esc(
          e.title,
        )}</a> <span class="label">${esc(e.status)}</span></li>`,
    )
    .join("");

  return c.html(
    chrome(
      c,
      `
    <span class="sticker">My events</span>
    <h1 class="display">Events</h1>
    <ul class="stack" style="padding:0;list-style:none">${
      rows || '<li class="muted">No events yet.</li>'
    }</ul>
    <a class="btn" href="/events/new">Create event</a>`,
    ),
  );
});

events.get("/events/new", (c) => c.html(renderEventForm(c, DEFAULTS, [])));

events.post("/events", async (c) => {
  const id = c.get("identity");
  const f = await c.req.formData();
  const raw: RawEventForm = {};
  for (const k of Object.keys(DEFAULTS) as (keyof EventFormFields)[])
    raw[k] = String(f.get(k) ?? "");

  const parsed = parseCreateEventForm(raw);
  if (!parsed.ok)
    // Sticky: re-render the same form with the submitted values + errors,
    // not a dead-end error page that loses the user's input.
    return c.html(renderEventForm(c, parsed.raw, parsed.errors), 400);

  const { values } = parsed;
  const eventId = newId("evt");
  await c.env.DB.prepare(
    `INSERT INTO events
       (id, org_id, title, description, requirements, rrule, timezone,
        duration_min, max_seats, deposit_cents, status)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,'open')`,
  )
    .bind(
      eventId,
      id.orgId,
      values.title,
      values.description,
      values.requirements,
      values.ical,
      values.timezone,
      values.durationMin,
      values.maxSeats,
    )
    .run();

  await materializeEvent(c.env, {
    id: eventId,
    rrule: values.ical,
    duration_min: values.durationMin,
  });

  return c.redirect(`/events/${eventId}`, 302);
});

events.get("/events/:id", async (c) => {
  const id = c.get("identity");
  const eventId = c.req.param("id");

  const ev = await c.env.DB.prepare(
    `SELECT id, title, description, timezone, max_seats, status
       FROM events WHERE id = ?1 AND org_id = ?2`,
  )
    .bind(eventId, id.orgId)
    .first<{
      id: string;
      title: string;
      description: string;
      timezone: string;
      max_seats: number;
      status: string;
    }>();

  if (!ev) return errorCard(c, "Event not found.", { status: 404 });

  const { results: occ } = await c.env.DB.prepare(
    `SELECT starts_at, ends_at, status FROM event_occurrences
      WHERE event_id = ?1 ORDER BY starts_at`,
  )
    .bind(eventId)
    .all<{ starts_at: string; ends_at: string; status: string }>();

  const rows = occ
    .map(
      (o) =>
        `<li>${esc(formatInTz(o.starts_at, ev.timezone))} <span class="label">${esc(
          o.status,
        )}</span></li>`,
    )
    .join("");

  return c.html(
    chrome(
      c,
      `
    <span class="sticker">${esc(ev.status)}</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>${esc(ev.description)}</p>
      <p class="label">Timezone</p><p>${esc(ev.timezone)}</p>
      <p class="label">Seats / session</p><p>${ev.max_seats}</p>
      <p class="label">Occurrences (${occ.length})</p>
      <ul>${rows || "<li>(none materialized yet)</li>"}</ul>
    </div>
    <a class="btn" href="/manage/${esc(ev.id)}">Manage</a>`,
    ),
  );
});
