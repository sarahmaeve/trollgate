/**
 * Typed D1 helpers. The guarded seat-cap INSERT (IMPL.md "Seat caps") will
 * live here in Phase 3. Phase 0 only needs a connectivity probe.
 */
import type { Env } from "../env";

export interface HealthResult {
  ok: boolean;
  orgCount: number;
}

/** Confirms D1 is reachable and the schema is applied. */
export async function dbHealth(env: Env): Promise<HealthResult> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM organizations",
  ).first<{ n: number }>();
  return { ok: true, orgCount: row?.n ?? 0 };
}
