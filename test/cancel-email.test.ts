/**
 * Regression coverage (behavior already shipped + manually verified): an
 * organizer cancels an *attended* event → all confirmed signups are canceled,
 * one notification per attendee is enqueued atomically, and the Cron drain
 * sends each exactly once (idempotent). No GitHub accounts: attendees are
 * seeded signup rows; the organizer is a forged KV session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { applySchema } from "./helpers/db";
import { drainNotifications } from "../src/notify/outbox";

beforeEach(applySchema);

// Storage is per-file, not per-test, in this pool config — reset the rows
// (child → parent for FKs) and the forged session before each case.
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
  env.ADMIN_GITHUB_IDS = ""; // fail-closed unless a test opts in via seed
});

const ORG = "org_d";
const USR = "usr_org";
const EVT = "evt_d";
const OCC = "occ_d";
const TOK = "ORGTOK";
const ADMIN_ID = 4242;
const RESEND = "https://resend.test/emails";

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedAttendedEvent(attendees = 2): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (id,name,contact_email) VALUES (?1,?2,?3)`,
    ).bind(ORG, "Demo Org", "demo@org.test"),
    env.DB.prepare(
      `INSERT INTO users (id,github_id,github_login,email,name)
       VALUES (?1,?2,?3,?4,?5)`,
    ).bind(USR, ADMIN_ID, "org", "org@x.test", "Org"),
    env.DB.prepare(
      `INSERT INTO memberships (org_id,user_id,role) VALUES (?1,?2,'owner')`,
    ).bind(ORG, USR),
    env.DB.prepare(
      `INSERT INTO events
         (id,org_id,title,description,requirements,rrule,timezone,
          duration_min,max_seats,deposit_cents,status)
       VALUES (?1,?2,'Demo Event','d',NULL,?3,'America/Los_Angeles',60,10,0,'open')`,
    ).bind(
      EVT,
      ORG,
      "DTSTART;TZID=America/Los_Angeles:20300101T180000\nRRULE:FREQ=DAILY;COUNT=1",
    ),
    env.DB.prepare(
      `INSERT INTO event_occurrences (id,event_id,starts_at,ends_at,status)
       VALUES (?1,?2,'2030-01-02T02:00:00.000Z','2030-01-02T03:00:00.000Z','scheduled')`,
    ).bind(OCC, EVT),
  ]);

  for (let i = 0; i < attendees; i++) {
    await env.DB.prepare(
      `INSERT INTO signups
         (id,link_token,occurrence_id,event_id,github_login,github_id,email,
          status,confirmed_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'confirmed',datetime('now'))`,
    )
      .bind(
        `sgn_${i}`,
        `tok_${i}`,
        OCC,
        EVT,
        `att${i}`,
        -(i + 1),
        `att${i}@x.test`,
      )
      .run();
  }

  await env.SESSIONS.put(
    `sess:${TOK}`,
    JSON.stringify({
      identity: {
        userId: USR,
        orgId: ORG,
        githubId: ADMIN_ID,
        githubLogin: "org",
        email: "org@x.test",
      },
    }),
  );
  env.ADMIN_GITHUB_IDS = String(ADMIN_ID);
}

function cancelReq(): Request {
  return new Request(`http://localhost/manage/${EVT}/cancel`, {
    method: "POST",
    headers: { Cookie: `tg_sess=${TOK}` },
  });
}

describe("cancel an attended event → outbox", () => {
  it("cancels every confirmed signup and enqueues one notice each", async () => {
    await seedAttendedEvent(3);
    const res = await call(cancelReq());
    expect(res.status).toBe(200);

    const ev = await env.DB.prepare(
      `SELECT status FROM events WHERE id=?1`,
    )
      .bind(EVT)
      .first<{ status: string }>();
    expect(ev?.status).toBe("canceled");

    const sg = await env.DB.prepare(
      `SELECT COUNT(*) n FROM signups WHERE event_id=?1 AND status='confirmed'`,
    )
      .bind(EVT)
      .first<{ n: number }>();
    expect(sg?.n).toBe(0);

    const nt = await env.DB.prepare(
      `SELECT COUNT(*) n FROM notifications
        WHERE kind='event_canceled' AND sent_at IS NULL`,
    ).first<{ n: number }>();
    expect(nt?.n).toBe(3);
  });
});

describe("notification drain (mocked Resend)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete env.RESEND_API_KEY;
    delete env.RESEND_API_URL;
    delete env.MAIL_FROM;
  });

  it("sends each notice exactly once and is idempotent", async () => {
    await seedAttendedEvent(2);
    await call(cancelReq());

    env.RESEND_API_KEY = "test";
    env.RESEND_API_URL = RESEND;
    env.MAIL_FROM = "notifications@trollgate.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "sent" }), { status: 200 }),
      );

    const r1 = await drainNotifications(env);
    expect(r1.sent).toBe(2);
    expect(r1.failed).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(RESEND);

    // Deliverability: From is the platform sender, Reply-To the org contact.
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.from).toBe("notifications@trollgate.test");
    expect(body.reply_to).toBe("demo@org.test");
    expect(body.to).toEqual(["att0@x.test"]);

    const unsent = await env.DB.prepare(
      `SELECT COUNT(*) n FROM notifications WHERE sent_at IS NULL`,
    ).first<{ n: number }>();
    expect(unsent?.n).toBe(0);

    // Idempotent: nothing left to consider, no further sends.
    const r2 = await drainNotifications(env);
    expect(r2.considered).toBe(0);
    expect(r2.sent).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("leaves notices queued when Resend is unconfigured", async () => {
    await seedAttendedEvent(2);
    await call(cancelReq());

    const r = await drainNotifications(env); // no RESEND_API_KEY
    expect(r.skipped).toBe(true);
    expect(r.sent).toBe(0);

    const unsent = await env.DB.prepare(
      `SELECT COUNT(*) n FROM notifications WHERE sent_at IS NULL`,
    ).first<{ n: number }>();
    expect(unsent?.n).toBe(2);
  });
});
