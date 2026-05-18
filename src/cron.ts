/**
 * scheduled() handler. Per IMPL.md "Scheduled cleanup":
 *   1. materialize occurrences from rrule        (Phase 2 — live)
 *   2. abandoned-sweep of stale pending_payment  (no-op until Phase 6 Stripe)
 *   3. drain the notifications outbox via Resend  (Phase 5)
 */
import type { Env } from "./env";
import { materializeAllOpen } from "./events/materialize";

export async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const r = await materializeAllOpen(env);
  console.log(
    `cron: materialized ${r.inserted} new occurrence(s) of ${r.considered} considered`,
  );
  // Step 2 (abandoned-sweep) and step 3 (notify-drain) arrive in later phases.
}
