# Deploying Trollgate

Production runbook for the Cloudflare Worker. Reflects the codebase as of the
MVP + live-test hardening (no Stripe — paid events are sealed at the seam and
return 501 until Phase 6).

Stack recap: one Worker (Hono) + **D1** (`DB`), **KV** (`SESSIONS`), static
**assets** (`ASSETS`, serves `/public`), and a **cron trigger** (every 15 min:
materialize occurrences, abandoned-sweep, drain the notification outbox).

---

## 0. Prerequisites

- A Cloudflare account; `npx wrangler login` (or a `CLOUDFLARE_API_TOKEN` in CI
  with Workers Scripts / D1 / KV / Workers Routes permissions).
- A domain you control, on Cloudflare DNS (for the app URL **and** the email
  sending domain — they can differ).
- A **production** GitHub OAuth App (separate from the dev one — a GitHub
  OAuth App has a single callback host).
- A Resend account.

---

## 1. Provision data stores (one-time)

```bash
npx wrangler d1 create trollgate
npx wrangler kv namespace create SESSIONS
```

Put the returned ids into the **`env.production`** block of
`wrangler.jsonc`, replacing the markers:
- `env.production.d1_databases[0].database_id` ← `REPLACE_WITH_PROD_D1_ID`
- `env.production.kv_namespaces[0].id` ← `REPLACE_WITH_PROD_KV_ID`

(The top-level placeholder zeros are for local `wrangler dev` only. Prod runs
from the `env.production` block — see §6 — which never inherits the localhost
dev `vars`/bindings.)

---

## 2. Apply the schema

```bash
npx wrangler d1 execute trollgate --remote --file ./schema.sql
```

`schema.sql` is `CREATE TABLE IF NOT EXISTS` + the `uq_signups_active` partial
index — safe to run once. Do **not** run `seed.sql` / `scripts/seed-demo.sql`
against prod (local-dev fixtures only).

> **Schema changes after launch are migrations, not re-applies.** Once prod
> has data, `IF NOT EXISTS` won't alter existing tables and you can't just
> `DROP`. Write a forward migration SQL and apply with `--remote`. (The local
> "drop & re-apply" shortcut used in dev does not transfer.)

---

## 3. Secrets and vars

**Secrets** — set **per environment** with `--env production` (never in
`wrangler.jsonc`):

```bash
npx wrangler secret put GITHUB_CLIENT_ID     --env production
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler secret put RESEND_API_KEY       --env production
```

**Vars** — set in the `env.production` block of `wrangler.jsonc` (added for
exactly this; named envs don't inherit the localhost dev `vars`). Replace
every `REPLACE_*`:

| Var | Prod value | Effect if left default |
|---|---|---|
| `BASE_URL` | `https://<your-domain>` | **Cookies lose `Secure`** unless https (fail-closed `isSecureCookie`); OAuth callback URL wrong |
| `ADMIN_GITHUB_IDS` | comma-sep numeric GitHub ids of organizers | empty ⇒ **nobody can create/manage events** (fail-closed) |
| `MAIL_FROM` | an address on your Resend-verified domain | falls back to org contact ⇒ **mail not deliverable** |
| `BRAND_NAME` | your brand (optional) | shows "Trollgate" |
| `RESEND_API_URL` | leave unset | unset ⇒ real Resend API (correct) |

Phase 6 only (not yet): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

---

## 4. GitHub OAuth (production app)

Register a second OAuth App (https://github.com/settings/developers):
- Homepage URL: `https://<your-domain>`
- **Authorization callback URL (exact):**
  `https://<your-domain>/auth/github/callback`
- Device Flow: off.

Its client id/secret are the `GITHUB_*` secrets above. `BASE_URL` drives the
callback the app sends to GitHub, so the two must match host-for-host.

---

## 5. Email deliverability (Resend)

1. In Resend, add and **verify your sending domain** — add the SPF (TXT),
   DKIM (CNAME), and a DMARC (TXT) records to that domain's DNS.
2. Set `MAIL_FROM` to an address on that verified domain (e.g.
   `notifications@<sending-domain>`). `Reply-To` is automatically the event
   org's `contact_email`, so replies reach the organizer while SPF/DKIM pass.
3. Smoke-test once with a real send to your own inbox (see §7).

This is the one-verified-sender / any-org-contact model — see IMPL.md
"Notifying attendees".

---

## 6. Deploy

```bash
npm test            # 53/53 expected
npx tsc --noEmit
npx wrangler deploy --env production
```

`--env production` is required — it selects the `env.production` block
(real ids, https `BASE_URL`, real `MAIL_FROM`). A bare `wrangler deploy`
would ship the localhost dev defaults. The deploy uploads the Worker, the
`/public` assets, and registers the cron trigger. Point the domain at the
Worker (custom domain / route in the dashboard, or `routes` in config).

---

## 7. Post-deploy smoke test

1. `GET https://<domain>/` → 200, sidebar shows **Browse / Sign in**.
2. Sign in with GitHub → lands on `/me`; if you're in `ADMIN_GITHUB_IDS` the
   sidebar shows **Create event / My events**.
3. Create a future event → it appears under `/e/:id` with seats.
4. Sign up (or `seed`-equivalent), then cancel from `/manage/:id`.
5. Within ~15 min (or trigger cron) the cancellation email arrives at your
   address, `From:` your `MAIL_FROM`, `Reply-To:` the org contact.
6. Re-trigger cron → no duplicate email (idempotent drain).

---

## 8. Operations

All commands take `--env production` (the prod Worker is `trollgate`; without
the flag they target the dev/top-level config).

- **Logs:** `npx wrangler tail --env production` (live) or the dashboard. The
  cron logs a `cron: materialized … / notifications sent=… ` line each run.
- **Backups:** reservations are real data even pre-Stripe — schedule
  `npx wrangler d1 export trollgate --remote --output backup-$(date +%F).sql`
  (D1 is addressed by name, env-independent).
- **Cron health:** dashboard → Worker → Triggers → last run / errors. A poison
  notification is auto-dropped after `MAX_NOTIFICATION_ATTEMPTS` (10).
- **Rollback:** `npx wrangler deployments list --env production` then
  `npx wrangler rollback [<id>] --env production`.
- **Rotating secrets:** `wrangler secret put <NAME> --env production` again;
  sessions are opaque KV tokens (no signing secret to rotate). Rotating the
  GitHub secret invalidates in-flight OAuth only.

---

## 9. Known limitations at this release

- **No payments.** Paid events (`deposit_cents > 0`) are rejected at the seam
  (501) for signup, cancel, and reschedule. Keep all events free until Phase 6
  adds Stripe + the refund/warning interstitial.
- **Sessions are absolute 1 h, not sliding** — active users re-login hourly.
- **DST-edge recurrence** correctness across spring-forward/fall-back is a
  documented, not-yet-hardened item (IMPL.md). Low risk for short-horizon
  events; revisit before long recurring series.
- **Schema migrations** are manual forward SQL (see §2).
- One GitHub OAuth App per host: dev and prod are separate apps.
