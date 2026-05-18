/**
 * Worker bindings + secrets. Explicit (not relying on generated types) so the
 * contract is readable in one place. Keep in sync with wrangler.jsonc.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;

  // Vars
  BASE_URL: string;

  // Secrets (wrangler secret put / .dev.vars). Present from the phase that
  // first needs them; typed here so usage sites are checked.
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  RESEND_API_KEY?: string;
  // Phase 6 (Stripe): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
}
