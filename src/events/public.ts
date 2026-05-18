/**
 * Public, no-auth pages: the landing event list and the series detail with
 * live per-occurrence seat counts (IMPL.md route map GET / and /e/:eventId).
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { layout, esc } from "../view";

export const pub = new Hono<{ Bindings: Env }>();

function fmt(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

pub.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.timezone,
            MIN(o.starts_at) AS next_at
       FROM events e
       LEFT JOIN event_occurrences o
         ON o.event_id = e.id
        AND o.status = 'scheduled'
        AND o.starts_at >= datetime('now')
      WHERE e.status = 'open'
      GROUP BY e.id
      ORDER BY next_at IS NULL, next_at`,
  ).all<{
    id: string;
    title: string;
    description: string;
    timezone: string;
    next_at: string | null;
  }>();

  const cards = results
    .map(
      (e) => `<a class="card" href="/e/${esc(e.id)}" style="text-decoration:none">
      <p class="label">${
        e.next_at ? "Next · " + esc(fmt(e.next_at, e.timezone)) : "No upcoming sessions"
      }</p>
      <h2 class="display" style="font-size:1.66rem">${esc(e.title)}</h2>
      <p>${esc(e.description)}</p></a>`,
    )
    .join("");

  return c.html(
    layout(`
    <span class="sticker">Trollgate</span>
    <h1 class="display">Sign up</h1>
    ${cards || '<div class="card"><p class="muted">No open events yet.</p></div>'}
    <a class="btn" href="/events/new">Organizer? Create an event</a>`),
  );
});

pub.get("/e/:id", async (c) => {
  const eventId = c.req.param("id");

  const ev = await c.env.DB.prepare(
    `SELECT id, title, description, requirements, timezone, max_seats, status
       FROM events WHERE id = ?1 AND status = 'open'`,
  )
    .bind(eventId)
    .first<{
      id: string;
      title: string;
      description: string;
      requirements: string | null;
      timezone: string;
      max_seats: number;
      status: string;
    }>();

  if (!ev) {
    return c.html(
      layout(`<div class="card"><p class="bad">Event not found.</p>
      <a class="btn" href="/">Back</a></div>`),
      404,
    );
  }

  const { results: occ } = await c.env.DB.prepare(
    `SELECT o.id, o.starts_at,
            (SELECT COUNT(*) FROM signups s
              WHERE s.occurrence_id = o.id
                AND s.status IN ('confirmed','pending_payment','refund_pending'))
              AS taken
       FROM event_occurrences o
      WHERE o.event_id = ?1
        AND o.status = 'scheduled'
        AND o.starts_at >= datetime('now')
      ORDER BY o.starts_at`,
  )
    .bind(eventId)
    .all<{ id: string; starts_at: string; taken: number }>();

  const sessions = occ
    .map((o) => {
      const full = o.taken >= ev.max_seats;
      const seats = `${o.taken} / ${ev.max_seats} seats`;
      const action = full
        ? `<span class="label">FULL</span>`
        : `<a class="btn" href="/o/${esc(o.id)}/signup">Sign up</a>`;
      return `<li class="card">
        <p class="label">${esc(fmt(o.starts_at, ev.timezone))}</p>
        <p>${seats}</p>${action}</li>`;
    })
    .join("");

  return c.html(
    layout(`
    <span class="sticker">Event</span>
    <h1 class="display">${esc(ev.title)}</h1>
    <div class="card">
      <p>${esc(ev.description)}</p>
      ${
        ev.requirements
          ? `<p class="label">Requirements</p><p>${esc(ev.requirements)}</p>`
          : ""
      }
      <p class="label">Timezone</p><p>${esc(ev.timezone)}</p>
    </div>
    <p class="label">Upcoming sessions</p>
    <ul class="stack" style="padding:0;list-style:none">${
      sessions || "<li class=\"muted\">No upcoming sessions.</li>"
    }</ul>
    <a class="btn" href="/">Back</a>`),
  );
});
