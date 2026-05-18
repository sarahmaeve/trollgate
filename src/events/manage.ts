/**
 * Create-event flow (Phase 2). Dashboard / cancel / list land in Phase 4.
 *
 * The owner hand-writes a recurrence body (IMPL.md defers a builder UI); we
 * assemble the iCal DTSTART;TZID + RRULE so materialization is timezone-correct
 * and deterministic. Deposit is forced to 0 for the MVP — paid events need the
 * Phase 6 StripePayment provider, so allowing >0 here would break the
 * NoPayment invariant.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { requireGitHub, type Vars } from "../auth/session";
import { materializeEvent } from "./materialize";
import { validateRule } from "./recurrence";
import { newId } from "../id";
import { layout, esc } from "../view";

export const events = new Hono<{ Bindings: Env; Variables: Vars }>();

const SINGLE_RULE = "FREQ=DAILY;COUNT=1"; // one-off when no recurrence given

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "2026-06-01T18:00" → "20260601T180000" (iCal local basic format). */
function toICalBasic(local: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return `${y}${mo}${d}T${h}${mi}00`;
}

function buildICal(tz: string, local: string, ruleBody: string): string {
  return `DTSTART;TZID=${tz}:${toICalBasic(local)}\nRRULE:${ruleBody}`;
}

events.use("/events/*", requireGitHub);

events.get("/events/new", (c) =>
  c.html(
    layout(`
    <span class="sticker">New event</span>
    <h1 class="display">Create</h1>
    <form class="card" method="post" action="/events">
      <p class="label">Title</p>
      <input name="title" required maxlength="120">
      <p class="label">Description</p>
      <textarea name="description" required rows="3"></textarea>
      <p class="label">Requirements (optional)</p>
      <input name="requirements" maxlength="240">
      <p class="label">Timezone (IANA)</p>
      <input name="timezone" required placeholder="America/Chicago" value="America/Chicago">
      <p class="label">First session (local)</p>
      <input name="starts_local" type="datetime-local" required>
      <p class="label">Duration (minutes)</p>
      <input name="duration_min" type="number" min="1" value="60" required>
      <p class="label">Recurrence (RRULE body — blank = one-off)</p>
      <input name="rule" placeholder="FREQ=WEEKLY;BYDAY=TU;COUNT=8">
      <p class="label">Max seats</p>
      <input name="max_seats" type="number" min="1" value="10" required>
      <button type="submit">Create event</button>
    </form>
    <p class="muted">Paid deposits arrive in Phase&nbsp;6; MVP events are free.</p>`),
  ),
);

events.post("/events", async (c) => {
  const id = c.get("identity");
  const f = await c.req.formData();
  const get = (k: string) => String(f.get(k) ?? "").trim();

  const title = get("title");
  const description = get("description");
  const requirements = get("requirements") || null;
  const timezone = get("timezone");
  const startsLocal = get("starts_local");
  const durationMin = parseInt(get("duration_min"), 10);
  const ruleBody = get("rule") || SINGLE_RULE;
  const maxSeats = parseInt(get("max_seats"), 10);

  const errs: string[] = [];
  if (!title) errs.push("title required");
  if (!description) errs.push("description required");
  if (!validTimezone(timezone)) errs.push("invalid IANA timezone");
  if (!toICalBasic(startsLocal)) errs.push("invalid first-session datetime");
  if (!Number.isInteger(durationMin) || durationMin < 1)
    errs.push("duration must be a positive integer");
  if (!Number.isInteger(maxSeats) || maxSeats < 1)
    errs.push("max seats must be a positive integer");

  let ical = "";
  if (errs.length === 0) {
    ical = buildICal(timezone, startsLocal, ruleBody);
    // Bounded validation (Finding 1): rejects an unparseable, empty, OR
    // pathologically frequent rule before the event row is ever stored, so
    // an abusive series can't be persisted and poison the Cron. Far-future
    // series are still accepted (validated against their first occurrence).
    const v = validateRule(ical, durationMin);
    if (!v.ok) errs.push(v.error);
  }

  if (errs.length > 0) {
    return c.html(
      layout(
        `<div class="card"><p class="bad">Could not create event</p>
        <ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
        <a class="btn" href="/events/new">Back</a></div>`,
      ),
      400,
    );
  }

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
      title,
      description,
      requirements,
      ical,
      timezone,
      durationMin,
      maxSeats,
    )
    .run();

  await materializeEvent(c.env, {
    id: eventId,
    rrule: ical,
    duration_min: durationMin,
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

  if (!ev) {
    return c.html(
      layout(`<div class="card"><p class="bad">Event not found.</p></div>`),
      404,
    );
  }

  const { results: occ } = await c.env.DB.prepare(
    `SELECT starts_at, ends_at, status FROM event_occurrences
      WHERE event_id = ?1 ORDER BY starts_at`,
  )
    .bind(eventId)
    .all<{ starts_at: string; ends_at: string; status: string }>();

  const rows = occ
    .map(
      (o) =>
        `<li>${esc(o.starts_at)} → ${esc(o.ends_at)} <span class="label">${esc(
          o.status,
        )}</span></li>`,
    )
    .join("");

  return c.html(
    layout(`
    <span class="sticker">${esc(ev.status)}</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>${esc(ev.description)}</p>
      <p class="label">Timezone</p><p>${esc(ev.timezone)}</p>
      <p class="label">Seats / session</p><p>${ev.max_seats}</p>
      <p class="label">Occurrences (${occ.length})</p>
      <ul>${rows || "<li>(none materialized yet)</li>"}</ul>
    </div>
    <a class="btn" href="/events/new">Create another</a>`),
  );
});
