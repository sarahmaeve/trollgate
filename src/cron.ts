/**
 * scheduled() handler. Per IMPL.md "Scheduled cleanup":
 *   1. materialize occurrences from rrule        (Phase 2)
 *   2. abandoned-sweep of stale pending_payment  (no-op until Phase 6 Stripe)
 *   3. drain the notifications outbox via Resend  (Phase 5)
 * Phase 0: wired but inert, so later phases add logic without touching index.ts.
 */
import type { Env } from "./env";

export async function scheduled(
  _event: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // Phases 2 / 5 / 6 fill these in.
}
