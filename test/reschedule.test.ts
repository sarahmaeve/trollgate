/**
 * Per-occurrence reschedule (new behavior — written test-first). Free event:
 * the occurrence moves, confirmed signups stay attached, and each confirmed
 * attendee gets an `event_rescheduled` notice enqueued atomically. Past/invalid
 * moves are rejected with a sticky form and change nothing. No GitHub:
 * fabricated attendees + a forged organizer session.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { applySchema } from "./helpers/db";

beforeEach(applySchema);

const ORG = "org_r";
const USR = "usr_r";
const EVT = "evt_r";
const OCC = "occ_r";
const TOK = "RTOK";
const ADMIN_ID = 7777;
const ORIG_START = "2030-03-01T02:00:00.000Z";

beforeEach(async () => {
  for (const t of [
    "notifications",
    "signups",
    "event_occurrences",
    "events",
    "memberships",
    "users",
    "organizations",
  ])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.SESSIONS.delete(`sess:${TOK}`);
  env.ADMIN_GITHUB_IDS = "";
});

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seed(attendees = 2): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (id,name,contact_email) VALUES (?1,'Org','o@x.test')`,
    ).bind(ORG),
    env.DB.prepare(
      `INSERT INTO users (id,github_id,github_login,email,name)
       VALUES (?1,?2,'org','o@x.test','Org')`,
    ).bind(USR, ADMIN_ID),
    env.DB.prepare(
      `INSERT INTO memberships (org_id,user_id,role) VALUES (?1,?2,'owner')`,
    ).bind(ORG, USR),
    env.DB.prepare(
      `INSERT INTO events
         (id,org_id,title,description,requirements,rrule,timezone,
          duration_min,max_seats,deposit_cents,status)
       VALUES (?1,?2,'Ev','d',NULL,?3,'America/Los_Angeles',60,10,0,'open')`,
    ).bind(
      EVT,
      ORG,
      "DTSTART;TZID=America/Los_Angeles:20300228T180000\nRRULE:FREQ=DAILY;COUNT=1",
    ),
    env.DB.prepare(
      `INSERT INTO event_occurrences (id,event_id,starts_at,ends_at,status)
       VALUES (?1,?2,?3,'2030-03-01T03:00:00.000Z','scheduled')`,
    ).bind(OCC, EVT, ORIG_START),
  ]);
  for (let i = 0; i < attendees; i++)
    await env.DB.prepare(
      `INSERT INTO signups
         (id,link_token,occurrence_id,event_id,github_login,github_id,email,
          status,confirmed_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'confirmed',datetime('now'))`,
    )
      .bind(`s${i}`, `t${i}`, OCC, EVT, `a${i}`, -(i + 1), `a${i}@x.test`)
      .run();

  await env.SESSIONS.put(
    `sess:${TOK}`,
    JSON.stringify({
      identity: {
        userId: USR,
        orgId: ORG,
        githubId: ADMIN_ID,
        githubLogin: "org",
        email: "o@x.test",
      },
    }),
  );
  env.ADMIN_GITHUB_IDS = String(ADMIN_ID);
}

const path = `/manage/${EVT}/occurrences/${OCC}/reschedule`;

function post(body: Record<string, string>, cookie = `tg_sess=${TOK}`) {
  const f = new FormData();
  for (const [k, v] of Object.entries(body)) f.set(k, v);
  return call(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: f,
    }),
  );
}

describe("reschedule an occurrence (free event)", () => {
  it("serves the reschedule form", async () => {
    await seed();
    const res = await call(
      new Request(`http://localhost${path}`, {
        headers: { Cookie: `tg_sess=${TOK}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/reschedul/i);
  });

  it("moves the occurrence, keeps signups, enqueues a notice each", async () => {
    await seed(2);
    const res = await post({
      timezone: "America/Los_Angeles",
      starts_local: "2030-04-10T17:00",
    });
    expect([200, 302]).toContain(res.status);

    const occ = await env.DB.prepare(
      `SELECT starts_at, status FROM event_occurrences WHERE id=?1`,
    )
      .bind(OCC)
      .first<{ starts_at: string; status: string }>();
    expect(occ?.status).toBe("scheduled");
    expect(occ?.starts_at).not.toBe(ORIG_START);
    // 17:00 America/Los_Angeles (PDT, -7 in April) → 00:00Z next day.
    expect(occ?.starts_at).toBe("2030-04-11T00:00:00.000Z");

    const sg = await env.DB.prepare(
      `SELECT COUNT(*) n FROM signups
        WHERE occurrence_id=?1 AND status='confirmed'`,
    )
      .bind(OCC)
      .first<{ n: number }>();
    expect(sg?.n).toBe(2); // still attached, still confirmed

    const nt = await env.DB.prepare(
      `SELECT COUNT(*) n FROM notifications
        WHERE kind='event_rescheduled' AND sent_at IS NULL`,
    ).first<{ n: number }>();
    expect(nt?.n).toBe(2);
  });

  it("rejects a move into the past (sticky, nothing changes)", async () => {
    await seed(2);
    const res = await post({
      timezone: "America/Los_Angeles",
      starts_local: "2020-01-01T10:00",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/future/i);

    const occ = await env.DB.prepare(
      `SELECT starts_at FROM event_occurrences WHERE id=?1`,
    )
      .bind(OCC)
      .first<{ starts_at: string }>();
    expect(occ?.starts_at).toBe(ORIG_START); // unchanged

    const nt = await env.DB.prepare(
      `SELECT COUNT(*) n FROM notifications`,
    ).first<{ n: number }>();
    expect(nt?.n).toBe(0);
  });

  it("forbids a non-member", async () => {
    await seed();
    await env.SESSIONS.put(
      `sess:OTHER`,
      JSON.stringify({
        identity: {
          userId: "nobody",
          orgId: "x",
          githubId: 1,
          githubLogin: "no",
          email: "n@x.test",
        },
      }),
    );
    const res = await post(
      { timezone: "America/Los_Angeles", starts_local: "2030-04-10T17:00" },
      "tg_sess=OTHER",
    );
    expect(res.status).toBe(403);
  });
});
