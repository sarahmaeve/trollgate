/**
 * Notification outbox (IMPL.md "Notifying attendees"). Enqueue happens in the
 * SAME D1 batch as the cancel (atomic); the Cron drains it. The `sent_at`
 * guard makes redelivery idempotent — no attendee is double-emailed.
 */
import type { Env } from "../env";
import { newId } from "../id";
import { sendEmail } from "./send";

const DRAIN_LIMIT = 50; // bound work per Cron tick

/**
 * Prepared INSERTs to fold into the cancel batch (kept here so the outbox
 * schema lives in one place). ON CONFLICT(signup_id, kind) DO NOTHING makes
 * a re-cancel a no-op.
 */
export function eventCanceledNotificationStmts(
  env: Env,
  signups: { id: string; email: string }[],
) {
  return signups.map((s) =>
    env.DB.prepare(
      `INSERT INTO notifications (id, signup_id, kind, to_email)
       VALUES (?1, ?2, 'event_canceled', ?3)
       ON CONFLICT(signup_id, kind) DO NOTHING`,
    ).bind(newId("ntf"), s.id, s.email),
  );
}

interface PendingRow {
  notif_id: string;
  to_email: string;
  kind: string;
  event_title: string;
  starts_at: string;
  timezone: string;
  contact_email: string;
}

export interface DrainResult {
  considered: number;
  sent: number;
  failed: number;
  skipped: boolean;
}

function buildEmail(r: PendingRow) {
  const when = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: r.timezone,
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date(r.starts_at));
    } catch {
      return r.starts_at;
    }
  })();
  const subject = `Canceled: ${r.event_title}`;
  const text =
    `Your session "${r.event_title}" scheduled for ${when} has been ` +
    `canceled by the organizer. No action is needed. ` +
    `Questions: ${r.contact_email}`;
  const html =
    `<p>Your session <strong>${r.event_title}</strong> scheduled for ` +
    `${when} has been <strong>canceled</strong> by the organizer.</p>` +
    `<p>No action is needed. Questions: ` +
    `<a href="mailto:${r.contact_email}">${r.contact_email}</a></p>`;
  return { subject, text, html };
}

/** Send queued notifications. Idempotent via the sent_at guard. */
export async function drainNotifications(env: Env): Promise<DrainResult> {
  const { results } = await env.DB.prepare(
    `SELECT n.id AS notif_id, n.to_email, n.kind,
            e.title AS event_title, o.starts_at, e.timezone,
            org.contact_email
       FROM notifications n
       JOIN signups s            ON s.id = n.signup_id
       JOIN event_occurrences o  ON o.id = s.occurrence_id
       JOIN events e             ON e.id = s.event_id
       JOIN organizations org    ON org.id = e.org_id
      WHERE n.sent_at IS NULL
      ORDER BY n.created_at
      LIMIT ?1`,
  )
    .bind(DRAIN_LIMIT)
    .all<PendingRow>();

  const out: DrainResult = {
    considered: results.length,
    sent: 0,
    failed: 0,
    skipped: false,
  };

  for (const row of results) {
    const { subject, text, html } = buildEmail(row);
    const res = await sendEmail(env, {
      to: row.to_email,
      from: row.contact_email,
      replyTo: row.contact_email,
      subject,
      text,
      html,
    });

    if (res.ok) {
      // Idempotent guard: only an unsent row transitions.
      await env.DB.prepare(
        `UPDATE notifications SET sent_at = datetime('now')
          WHERE id = ?1 AND sent_at IS NULL`,
      )
        .bind(row.notif_id)
        .run();
      out.sent++;
    } else if (res.skipped) {
      // Unconfigured (no API key) — stop; every row would skip. Leave
      // queued for a later run once RESEND_API_KEY is set.
      out.skipped = true;
      break;
    } else {
      await env.DB.prepare(
        `UPDATE notifications SET attempts = attempts + 1 WHERE id = ?1`,
      )
        .bind(row.notif_id)
        .run();
      out.failed++;
      console.error(
        `notify ${row.notif_id} failed (${res.status}): ${res.error ?? ""}`,
      );
    }
  }

  return out;
}
