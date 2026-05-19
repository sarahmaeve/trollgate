/**
 * Resend transactional email — plain fetch, no SDK (IMPL.md "Notifying
 * attendees"). A Worker cannot do SMTP; Resend is reached over HTTPS.
 *
 * Production note: the From domain must be verified in Resend. We follow
 * IMPL.md and use the org's contact_email as From + Reply-To; verifying that
 * domain is a deploy-time concern, already flagged in the design doc.
 */
import type { Env } from "../env";

const DEFAULT_URL = "https://api.resend.com/emails";

/**
 * The From address. Prod sets MAIL_FROM to an address on the Resend-verified
 * domain (Reply-To stays the org's contact_email so replies reach the
 * organizer). Falls back to the contact email only as a dev convenience —
 * that is NOT deliverable in prod unless the contact's domain is verified.
 */
export function mailFrom(env: Env, contactEmail: string): string {
  return env.MAIL_FROM?.trim() || contactEmail;
}

export interface OutgoingEmail {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
}

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number; skipped?: boolean; error?: string };

export async function sendEmail(
  env: Env,
  msg: OutgoingEmail,
): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    // Unconfigured: leave the row queued (drain will stop early), so it
    // delivers once a key is set rather than being marked failed.
    return { ok: false, status: 0, skipped: true };
  }

  const url = env.RESEND_API_URL ?? DEFAULT_URL;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: msg.from,
        to: [msg.to],
        reply_to: msg.replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (r.ok) return { ok: true, status: r.status };
    return { ok: false, status: r.status, error: await r.text() };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}
