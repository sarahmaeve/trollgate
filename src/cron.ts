/**
 * scheduled() handler. Per IMPL.md "Scheduled cleanup":
 *   1. materialize occurrences from rrule        (Phase 2 — live)
 *   2. abandoned-sweep of stale pending_payment  (no-op until Phase 6 Stripe)
 *   3. drain the notifications outbox via Resend  (Phase 5)
 */
import type { Env } from "./env";
import { materializeAllOpen } from "./events/materialize";
import { drainNotifications } from "./notify/outbox";

export async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const m = await materializeAllOpen(env);
  console.log(
    `cron: materialized ${m.inserted} new occurrence(s) of ${m.considered} considered`,
  );

  // Step 2 (abandoned-sweep) is a no-op until Phase 6 creates pending_payment.

  const n = await drainNotifications(env);
  console.log(
    `cron: notifications sent=${n.sent} failed=${n.failed} ` +
      `considered=${n.considered}${n.skipped ? " (RESEND_API_KEY unset)" : ""}`,
  );
}
