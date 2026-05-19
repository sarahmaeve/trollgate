# Trollgate Implementation: TypeScript on Cloudflare

Implementation reference for [trollgate.md](./trollgate.md): a moderated signup
service for free / low-cost study groups, chat sessions, and classes.

**Target scale (drives right-sizing):** free study groups of 2–10 and
meetups / stand-ups of 5–25 attendees per occurrence; low signup
concurrency. Explicitly *not* 1:1 scheduling, consulting, or a Calendly /
calendar-management replacement. Design choices are sized for this — small,
sporadic load — not for high-concurrency bursts.

Stack chosen for **Cloudflare-native ("Option A1")**, all primitives
first-classed by Cloudflare end to end:

| Concern | Choice | Notes |
|---|---|---|
| Runtime / routing | Cloudflare **Worker** + [Hono](https://hono.dev) | First-class TS on Workers |
| Events + signups | **D1** (SQLite-as-a-service) | Relational; atomic batch transactions; 10 GB / paid |
| Sessions | **Workers KV** | Cloudflare recommends KV for session storage |
| Seat caps (race-safe) | Single guarded D1 `INSERT` + `UNIQUE` constraints | D1 is single-threaded/transactional — no Durable Object needed at this scale |
| Occurrence materialization + cleanup | **Cron Trigger** (`scheduled` handler) | Expands `rrule`; sweeps abandoned/refund-pending rows; drains email outbox |
| GitHub OAuth | plain `fetch` | No SDK — four HTTPS calls (see below) |
| Stripe | official `stripe` npm SDK | `createFetchHttpClient()` + `constructEventAsync()` |
| Outbound email | **Resend** via plain `fetch` | No SMTP on Workers; outbox table drained by Cron |

Why not the alternatives: a persistent Go binary + local SQLite cannot run on
Workers (Go is WASM-only, not first-class) and loses local disk on Cloudflare
Containers (ephemeral disk, 1–3 s cold starts). Rust is first-class but
WASM-only (`workers-rs` is work-in-progress; no `tokio`; constrained crate
ecosystem). TS trades Rust's compile-time safety for a mature ecosystem (real
Stripe SDK, Hono, no `wasm32` dependency constraints) — lower risk for a small
money-handling service.

---

## Domain model

Trollgate manages **events**, owned by **organizations**, run by
**users**. Each event has a schedule, seat cap, optional deposit, and many
signups. Every signup gets a persistent personalized link.

Tenancy is modeled from v0 even though only one org exists initially — a
single seeded `organizations` row + one `users` row (you, via GitHub) + one
`memberships` row with `role='owner'`. This supports both scaling axes with
no code change: another person signing in gets their own auto-created org;
a small team adds more `memberships` to a shared org. Retrofitting a tenant
key later is a painful migration, so `events.org_id` exists now.

**Decided:** owners authenticate through the **same GitHub OAuth** as
signups (an owner is just a `User` whose membership `role='owner'`) — one
identity system, no separate owner login. Deposits use a **single global
Stripe account** for v0, but `organizations.stripe_account` and an optional
Stripe routing parameter are reserved now so Stripe Connect drops in later
without a schema migration.

### D1 schema

The schema is **code, and [`schema.sql`](./schema.sql) is the single source
of truth** — this doc describes intent, not the authoritative DDL. If the two
disagree, `schema.sql` wins; update it first, then reconcile the prose here.

Shape, at a glance (see the file for columns, constraints, and inline notes):

| Table | Purpose |
|---|---|
| `organizations` | Tenant. `stripe_account` is the Connect seam (NULL = global). |
| `users` | Authenticated humans; identity is GitHub (owners and attendees alike). |
| `memberships` | `(org_id, user_id, role)` — who may manage an org's events. |
| `events` | Series template (`rrule` + `timezone`); a fixed event is `COUNT=1`. |
| `event_occurrences` | Concrete sessions materialized from `rrule` by the Cron. |
| `signups` | One *active* signup per (session, user) via a partial unique index; `link_token` is the `/r/<token>` capability. |
| `notifications` | Async email outbox, drained by the Cron. |

Signup status enum: `pending_payment | confirmed | abandoned | canceled |
refund_pending | canceled_refunded`.

**rrule-edit policy:** an owner editing `rrule` after occurrences exist must
never delete an occurrence that has signups — re-materialization only *adds*
future occurrences and adjusts not-yet-populated ones. Canceling an
occurrence with signups follows the refund path, it is not a silent delete.

### Signup status lifecycle

```
                         deposit_cents = 0
 (form submit) ──────────────────────────────────────────► confirmed
       │                                                       │
       │ deposit_cents > 0                                     │ free, or paid:
       ▼                                                       │ user/owner cancel
 pending_payment ──webhook: checkout.session.completed──► confirmed
       │   │                                                   │
       │   │ owner/user cancels (NO money captured yet)         │ paid: cancel
       │   ▼                                                   │ allowed only if
       │  canceled  ◄────────────────────────────────────────  │ now < starts_at-24h
       │  (no refund — nothing was charged)                     ▼
       │                                                  refund_pending
       │ Cron: >1h old, no payment                              │ Stripe refund
       ▼                                                        │ (idempotency key
   abandoned                                                    ▼  = signup id)
                                                          canceled_refunded
       scheduler cancels event ──► every confirmed PAID signup → refund_pending
                                   every confirmed FREE signup → canceled
                                   every pending_payment       → abandoned (no refund)
```

`confirmed` for a free event is reached directly at form submit — no Stripe
hop. The webhook remains the **source of truth** for any paid confirmation.

Statuses: `pending_payment | confirmed | abandoned | canceled |
refund_pending | canceled_refunded`.

### Refund policy (decided)

- **Full refund only**, and **only** when canceled (by user or by the
  scheduler canceling the series) **more than 24h before the occurrence's
  `starts_at`**. No partial refunds. Inside 24h: cancel is still allowed but
  forfeits the deposit (`confirmed → canceled`, no money returned).
- **Never refund a `pending_payment` row.** It was never charged (Checkout
  not completed); on any cancel it goes straight to `abandoned`/`canceled`.
- **One refund maximum per signup**, enforced three ways so a double-cancel
  (e.g. user clicks cancel *and* owner cancels the series concurrently)
  cannot pay out twice:
  1. The only transition that initiates a refund is a guarded write
     `UPDATE signups SET status='refund_pending' WHERE id=? AND
     status='confirmed'` — it succeeds for exactly one caller; the loser
     updates zero rows and stops.
  2. The Stripe `refunds.create` call passes an **idempotency key = the
     signup id**, so even a retry/race at the API boundary is deduped by
     Stripe itself.
  3. On success, `refund_id` is recorded and status → `canceled_refunded`
     (terminal). A row already `refund_pending`/`canceled_refunded` never
     re-enters the refund path.

---

## Route map

```
GET  /                         landing / event list (public)
GET  /e/:eventId               series detail: title, requirements, list of
                               upcoming occurrences w/ "N of M seats" each (public)

GET  /auth/github/login        → redirect to GitHub authorize
GET  /auth/github/callback     exchange code, fetch verified email; upsert users row;
                               auto-create org + owner membership on first login;
                               create KV session

# Authenticated (RequireGitHub middleware)
GET  /o/:occurrenceId/signup   signup form (rejects if occurrence started or full)
POST /o/:occurrenceId/signup   create signup row; free → confirmed,
                               paid → pending_payment + Stripe Checkout
GET  /signup/success           UX only — webhook is truth
GET  /signup/canceled          UX only
GET  /r/:token                 persistent personalized link: status + cancel button
POST /r/:token/cancel          self-cancel; full refund iff paid & >24h pre-occurrence

# Organizer (auth: session user has a membership in this event's org_id;
#            'owner'/'admin' may cancel & refund, 'staff' may only view lists)
GET  /manage/:eventId          owner dashboard
POST /manage/:eventId/cancel   cancel event; refund ALL confirmed paid signups
GET/POST /manage/:eventId/occurrences/:occId/reschedule
                               move one occurrence (same future/tz guards as
                               create); free → keep signups + notify
                               (event_rescheduled); paid → refund + warn (P6)
GET  /manage/:eventId/list     confirmed signups as HTML
GET  /manage/:eventId/list.csv confirmed signups as CSV

# Stripe — NOT behind auth, raw body required
POST /webhooks/stripe          verify signature; mark confirmed (idempotent)
```

`:token` is `signups.link_token` — 256 bits from `crypto.getRandomValues`,
base64url-encoded, looked up via its UNIQUE index. It is a capability
separate from the PK: independently revocable/rotatable without touching
foreign keys, and the internal `id` never appears in a URL. Chosen because
this link can trigger a refund (a money action), so identity and capability
must not be conflated.

---

## GitHub OAuth (no SDK — plain `fetch`)

Verified against GitHub's docs. Four HTTPS calls:

1. **Authorize redirect:**
   `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=…&scope=read:user%20user:email&state=<csrf>`
   Store `state` in the KV session before redirecting.
2. **Token exchange:** `POST https://github.com/login/oauth/access_token`
   with `client_id`, `client_secret`, `code`, `redirect_uri`, and header
   **`Accept: application/json`** → `{ "access_token": "gho_…" }`.
3. **User:** `GET https://api.github.com/user`, `Authorization: Bearer <token>`.
4. **Email:** `GET https://api.github.com/user/emails` (needs `user:email`
   scope) → array of `{ email, primary, verified }`. Pick `primary &&
   verified`. A verified GitHub primary email satisfies trollgate's "email
   from a verified source" requirement — the GitHub path doubles as email
   verification, so no separate email-verify flow is needed for the MVP.

```ts
// auth/github.ts (sketch)
const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN     = "https://github.com/login/oauth/access_token";
const API       = "https://api.github.com";

export async function exchangeCode(env: Env, code: string): Promise<string> {
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.BASE_URL}/auth/github/callback`,
    }),
  });
  const { access_token } = await r.json<{ access_token: string }>();
  return access_token;
}

export async function fetchVerifiedEmail(token: string): Promise<string> {
  const r = await fetch(`${API}/user/emails`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "trollgate" },
  });
  const emails = await r.json<{ email: string; primary: boolean; verified: boolean }[]>();
  const pick = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  if (!pick) throw new Error("no verified GitHub email");
  return pick.email;
}
```

CSRF: compare the `state` query param against the value stashed in the KV
session; reject on mismatch. (GitHub also supports PKCE `code_challenge=S256`
— add it if hardening beyond the MVP.)

---

## Seat caps via a guarded D1 insert

A separate `SELECT COUNT(*)` then `INSERT` would race. The fix at this scale
(2–25 attendees/occurrence, sporadic signups) is **not** a Durable Object —
a D1 database is single-threaded and a statement is transactional, so a
single capacity-guarded conditional insert is atomic on its own:

```sql
-- One statement: inserts only if the seat count is still under the cap.
-- Rows affected = 0  → occurrence full (reject).
-- Rows affected = 1  → seat taken.
-- Partial unique index uq_signups_active separately rejects a second
-- *active* signup by the same user (canceled rows excluded).
INSERT INTO signups (id, link_token, occurrence_id, event_id,
                     github_login, github_id, email, status)
SELECT ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM signups
        WHERE occurrence_id = ?
          AND status IN ('confirmed','pending_payment','refund_pending'))
      < (SELECT max_seats FROM events WHERE id = ?);
```

`pending_payment` counts toward the cap (a seat is held while the Stripe
hop is in flight); the Cron's abandoned-row sweep frees seats that never
pay. "N of M seats" on `/e/:eventId` is the same `COUNT(*)`. No reserve /
release lifecycle, no DO binding, no state to keep in sync with the row —
and still correct well past the stated scale because D1 serializes anyway.
The webhook only flips `pending_payment → confirmed` (no recount needed —
the seat was already held at insert).

---

## Stripe (paid events only — `deposit_cents > 0`)

Workers caveat: the Stripe Node SDK works, but you must configure the fetch
HTTP client and use the **async** webhook verifier (Web Crypto, not Node
`crypto`):

```ts
import Stripe from "stripe";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  httpClient: Stripe.createFetchHttpClient(),   // required on Workers
});

// Checkout: $deposit_cents, metadata carries the linkage
const cs = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{
    price_data: {
      currency: "usd",
      product_data: { name: event.title },
      unit_amount: event.deposit_cents,
    },
    quantity: 1,
  }],
  customer_email: signup.email,
  success_url: `${env.BASE_URL}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${env.BASE_URL}/signup/canceled`,
  metadata: { signup_id: signup.id, event_id: event.id, org_id: org.id },
}, connectOpts(org));   // Connect seam — see below

// Connect seam: v0 orgs have stripe_account = NULL → undefined → global
// account. When an org connects its own Stripe account, the same call
// routes to it with zero schema/refund-path changes.
function connectOpts(org: Organization): Stripe.RequestOptions | undefined {
  return org.stripe_account ? { stripeAccount: org.stripe_account } : undefined;
}
// Refunds pass the same connectOpts(org) so money returns from the
// account that collected it.

// Webhook: source of truth
const event = await stripe.webhooks.constructEventAsync(  // async on Workers
  await req.text(),
  req.headers.get("stripe-signature")!,
  env.STRIPE_WEBHOOK_SECRET,
);
```

Idempotency: `MarkConfirmed` is `UPDATE signups SET status='confirmed',
stripe_payment=?, confirmed_at=datetime('now') WHERE id=? AND
status='pending_payment'` — a second webhook delivery updates zero rows and
does not error. Capture the `payment_intent` from the session for later
refunds.

### Refund paths

Both paths share one refund primitive (full refund, one-max, see policy
above): guarded `confirmed → refund_pending`, then
`stripe.refunds.create({ payment_intent }, { idempotencyKey: signupId })`,
then record `refund_id` and `→ canceled_refunded`. The seat frees itself:
`canceled_refunded` is not in the counted status set, so the next
capacity-guarded insert sees one fewer seat taken — no explicit release.

- **User self-cancel** (`POST /r/:token/cancel`): allowed only while the
  occurrence is `scheduled` and `now < starts_at - 24h`. Paid →  refund
  primitive. Free → just `canceled`. Inside 24h → `canceled`, **no refund**
  (deposit forfeited, per policy).
- **Re-signup after cancel (decided fee policy):** a canceled signup leaves
  the active-uniqueness slot free, so for **free events the user may sign up
  again** (a fresh row + new `link_token`; the old canceled one stays as
  history). For **paid events re-signup is blocked** — a
  cancel → $5 refund → re-signup loop is abuse. Enforced in app code
  (`priorSignupExists` on the Phase 6 paid reserve path), not the schema;
  the free path only checks for an *active* prior signup.
- **Scheduler cancels series** (`POST /manage/:eventId/cancel`): event
  `status='canceled'`; for every occurrence and its signups —
  `confirmed` + paid → refund primitive (regardless of the 24h rule: the
  org canceled, so the user is always made whole); `confirmed` + free →
  `canceled`; `pending_payment` → `abandoned` (never charged, no refund).
  Stripe calls are external and **not** in the D1 batch, so each is
  retryable; a Cron sweep retries any stuck `refund_pending`.
- **Reschedule occurrence** (`/manage/:eventId/occurrences/:occId/reschedule`):
  per-occurrence move under the *same* guards as initial scheduling (valid
  IANA tz, parseable datetime, new instant must be in the future — same
  `firstOccurrence` tz/DST path; sticky form on error). **Free:** the
  occurrence's `starts_at`/`ends_at` change, confirmed signups stay attached,
  one `event_rescheduled` notice per attendee is enqueued in the same D1
  batch. **Paid (Phase 6):** same refund primitive as cancel (attendees paid
  for a specific time and did not consent to the new one) → refund + release
  the paid confirmed signups, new time opens for fresh signups. **Mandatory
  warning interstitial** before *cancel OR reschedule* whenever
  `deposit_cents > 0`: "this refunds $X to N attendees — confirm." Today the
  route hard-stops paid events at the seam (501) until Phase 6 wires this.

> The DB side (D1 batch) is atomic and rolls back on failure, but the Stripe
> refund API is not part of it. Treat refunds as idempotent external effects
> keyed by `signup_id`, never assume one-shot success.

---

## Notifying attendees (event cancellation email)

A Worker cannot send SMTP. Cloudflare's `send_email` binding only reaches
*verified* addresses (not arbitrary attendees), and MailChannels' free
Workers tier ended in 2024. So outbound transactional mail goes through
**Resend**, called as a plain `fetch()` (`POST https://api.resend.com/emails`,
`Authorization: Bearer $RESEND_API_KEY`) — no SDK, consistent with the
GitHub-OAuth approach. Requires a verified sending domain (SPF/DKIM/DMARC);
`From` / `Reply-To` is the org's `contact_email`.

Recipients = `signups` across all occurrences of the canceled event whose
`status ∈ {confirmed, refund_pending, canceled_refunded}` (had a seat).
`pending_payment`/`abandoned` are excluded.

**Never send inside the cancel request** (Workers wall/CPU limits, external
latency, partial failure with no retry, and email must not block the
cancel/refund). Same decoupling as refunds — an **outbox drained by the
existing Cron**:

1. `POST /manage/:eventId/cancel`, in the *same D1 batch* that flips event /
   occurrence / signup statuses and enqueues refunds, also inserts one
   `notifications` row per recipient (`kind='event_canceled'`, `sent_at`
   NULL). The `UNIQUE(signup_id, kind)` constraint makes enqueue idempotent.
2. The Cron drains `sent_at IS NULL`: send via Resend, `UPDATE … SET
   sent_at=datetime('now')` on success; bump `attempts` on failure for the
   next sweep. The `sent_at` guard makes redelivery safe — **no attendee is
   double-emailed**, the same safety shape as one-refund-max.

Worst-case delivery latency is one Cron interval (~15 min) — acceptable for
a cancellation notice; tighten the cron or move to Cloudflare Queues later
if needed.

---

## Scheduled cleanup (Cron Trigger)

`wrangler.jsonc`:

```jsonc
{ "triggers": { "crons": ["*/15 * * * *"] } }   // UTC; ~minute granularity
```

`scheduled()` handler each run:

1. **Materialize occurrences.** For every `open` event, expand `rrule` in the
   event's `timezone` with `rrule.js` over a rolling window (next ~90 days) and
   `INSERT … ON CONFLICT(event_id, starts_at) DO NOTHING` into
   `event_occurrences` — idempotent, so re-runs only add genuinely new
   sessions. Never delete an occurrence with signups (rrule-edit policy).
2. `UPDATE signups SET status='abandoned' WHERE status='pending_payment' AND
   created_at < datetime('now','-1 hour')`. No release step — `abandoned`
   leaves the counted status set, so the seat is freed automatically.
3. Retry any `refund_pending` rows (scheduler-cancel refund safety net).
4. Drain `notifications` where `sent_at IS NULL` → send via Resend → set
   `sent_at` (idempotent; see Notifying attendees).

---

## Environment / bindings

```jsonc
// wrangler.jsonc (excerpt)
{
  "d1_databases":   [{ "binding": "DB",    "database_name": "trollgate" }],
  "kv_namespaces":  [{ "binding": "SESSIONS" }],
  "vars":   { "BASE_URL": "https://trollgate.example.com" },
  "triggers": { "crons": ["*/15 * * * *"] }
}
```

Secrets via `wrangler secret put` (never in `wrangler.jsonc`):
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `SESSION_SECRET`, `RESEND_API_KEY`.

---

## Local development

```bash
npm create cloudflare@latest trollgate -- --type hello-world-typescript
npm i hono stripe rrule
npx wrangler d1 create trollgate
npx wrangler d1 execute trollgate --local --file ./schema.sql

npx wrangler dev                                     # app on :8787
stripe listen --forward-to localhost:8787/webhooks/stripe   # prints whsec_…
```

Stripe test cards: `4242 4242 4242 4242` (success),
`4000 0000 0000 9995` (decline), `4000 0025 0000 3155` (3DS).

---

## MVP scope (per trollgate.md)

In: display event, manage event, GitHub signup flow, owner list HTML + CSV.

Maps to: `/e/:eventId`, `/manage/:eventId`, `/auth/github/*` +
`/o/:occurrenceId/signup`, `/manage/:eventId/list[.csv]`. Seat caps, optional
deposit, and the personal link / cancel-refund lifecycle are built into the
model above but can ship behind a single-occurrence (`rrule` with `COUNT=1`),
free event first — the occurrence machinery still runs, it just produces one
row, so there is no separate "non-repeating" code path to throw away later.

Email in v0: **cancellation notices are in scope** (Resend + outbox, above).
Stripe sends payment receipts itself.

Recurrence is a **friendly form** (single session, or weekly × N — weekday
implied by the first session; `event-form.ts`/`recurrence.ts`), not a raw
RRULE. Timezone is a dropdown from the runtime IANA list; brand is
`BRAND_NAME`-configurable; the create form is sticky on validation error
(submitted values + inline errors, no dead-end page).

Deferred past MVP: standalone email-verification path (GitHub's verified email
covers identity for v0), series-subscription signup (per-occurrence only for
v0), richer recurrence (daily/monthly, intervals, end-by-date — only
once/weekly-by-count for v0), discount codes, welcome/logistics emails (other
`notifications.kind`s reuse the same outbox later), account-age anti-abuse
filter (keep lenient).

---

## Visual design

The visual language is **code-adjacent: [`DESIGN.md`](./DESIGN.md) is the
single source of truth** ("Maximalist Pop"), the third seam alongside
`schema.sql` (data) and the `PaymentProvider` interface (payments). This doc
states intent; `DESIGN.md` states the authoritative tokens. If they differ,
`DESIGN.md` wins.

The token→stylesheet seam, no build step:

- The YAML front-matter of `DESIGN.md` (colors, typography, spacing,
  rounded, shadows, component recipes) maps 1:1 to CSS custom properties in
  a hand-written `public/tokens.css` (`--color-primary: #FF2D7A`,
  `--radius-md: 20px`, `--shadow-md: 8px 8px 0 0 rgba(20,20,20,.22)`, …).
- Server-rendered Hono templates use semantic classes bound to those
  variables. Rebranding = edit `DESIGN.md` tokens, regenerate `tokens.css` —
  no template changes, same pattern as swapping the payment impl.
- Fonts (Bungee, Space Grotesk, IBM Plex Mono) are **self-hosted** static
  assets, not hot-linked — fewer third-party requests, better Worker perf,
  no external runtime dependency.

This is *not* a classless-CSS baseline: "Maximalist Pop" explicitly forbids
subtle borders, default form controls, and quiet palettes, so controls are
fully styled (thick black keylines, hard offset shadows, clipped corners).

**MVP fidelity scope.** Implement faithfully now: the full token system,
the type scale, palette, keyline+offset-shadow card/button/input treatment,
clipped corners. **Defer to a post-MVP decorative pass** (does not violate
the language): halftone-dot fields, burst rays, rotated sticker ribbons,
grid-breaking overlap badges. Accessibility: WCAG-contrast-check each
text-on-color token pair as built; adjust text color within the palette
where a pair fails (the language values "legible structure").

---

## Build plan (MVP — no Stripe, expandable)

Stripe is a single seam, not scattered stubs: a `PaymentProvider` interface
with a `NoPayment` impl for the MVP; `StripePayment` + the webhook route drop
in later with no migration (`schema.sql` already carries `deposit_cents`,
`stripe_*`, `refund_id`, and the `pending_payment`/`refund_*` statuses).

Module layout:

```
src/
  index.ts              Hono app; exports { fetch, scheduled }
  env.ts                typed bindings (DB, SESSIONS, vars, secrets)
  db/queries.ts         typed D1 helpers (guarded seat-cap insert lives here)
  auth/github.ts        OAuth login/callback + fetchVerifiedEmail
  auth/session.ts       KV session + RequireGitHub middleware
  org/bootstrap.ts      auto-create org + owner membership on first login
  events/manage.ts      create/cancel event, dashboard, list HTML/CSV
  events/materialize.ts rrule → occurrences (called by cron)
  signup/handlers.ts    form + guarded insert (free → confirmed)
  signup/reservation.ts /r/:token view + self-cancel
  notify/{outbox,send}.ts  enqueue + Resend drain
  payment/index.ts      PaymentProvider iface + NoPayment (Stripe later)
  cron.ts               scheduled(): materialize + abandoned-sweep + notify-drain
public/
  tokens.css            CSS custom properties generated from DESIGN.md YAML
  fonts/                self-hosted Bungee / Space Grotesk / IBM Plex Mono
  app.css               Maximalist Pop component styles, driven by tokens.css
```

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Scaffold** | `create cloudflare`, Hono, `wrangler.jsonc` (D1+KV+cron, no DO), apply `schema.sql` local, seed org+owner, `tokens.css` from `DESIGN.md` + self-hosted fonts + `app.css` core treatment | `wrangler dev` serves a styled health page; DB queryable |
| **1. Auth** | GitHub OAuth, KV session, `RequireGitHub`, org bootstrap on first login | Log in via GitHub; org+owner row auto-created |
| **2. Events + occurrences** | `events/manage.ts` create-event; `materialize.ts`; cron expands `rrule` (incl. `COUNT=1`) | Creating an event populates `event_occurrences` |
| **3. Public + signup** | Landing/list, event detail w/ live seat count, signup form, guarded insert (`NoPayment` → `confirmed`), `/r/:token` view+cancel | A GitHub user signs up for a free occurrence; seat count moves; self-cancel works |
| **4. Manage surface** | Dashboard, cancel event/occurrence, **list HTML + CSV** (explicit trollgate.md MVP bullet) | Owner sees confirmed attendees, exports CSV, cancels a series |
| **5. Cancellation email** | `notify` outbox + Resend send; cron drain step | Canceling a series emails verified attendees once |

Phases 0–4 = the trollgate.md MVP exactly. Phase 5 adds the Stripe-free
cancel-and-notify capability. **Phase 6 (out of MVP) = the Stripe layer**:
`StripePayment` impl, `/signup/checkout`, `/webhooks/stripe`, refund flows —
slots into the seam, no schema or seat/cancel-logic changes. The cron
`abandoned`-sweep ships in MVP as a no-op (no `pending_payment` rows until
paid events exist) so Phase 6 needs no cron changes.

---

## Threat model (carried forward)

- GitHub OAuth proves control of a GitHub account, not identity — a motivated
  actor can make one. The optional $5 raises cost-per-account sharply; bots
  almost never pay.
- **Webhook signature verification is non-negotiable** — without it anyone can
  POST a fake "payment succeeded." Use `constructEventAsync` and reject on
  failure before touching the DB.
- The `/webhooks/stripe` route must be outside auth and read the **raw** body.
- Session secret and Stripe/GitHub secrets via `wrangler secret`, never in
  source or `wrangler.jsonc`.
- High-stakes workshops (private code, sensitive material): add a manual
  organizer review step before granting access — the two filters are strong
  but not identity proof.
