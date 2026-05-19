/**
 * Signup (free path). requireGitHub-gated. The final schema keeps no extra
 * per-signup fields, so the "form" is a confirm step. NoPayment → the guarded
 * insert lands the row directly as 'confirmed' (no Stripe hop).
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { requireGitHub, type Vars } from "../auth/session";
import { chrome, esc, formatInTz, errorCard } from "../view";
import {
  getOccurrenceContext,
  reserveConfirmedSeat,
  type OccurrenceContext,
} from "../db/queries";
import { EVENT_STATUS, OCCURRENCE_STATUS } from "../db/constants";
import { NoPayment } from "../payment";

export const signup = new Hono<{ Bindings: Env; Variables: Vars }>();

const payment = new NoPayment();

signup.use("/o/*", requireGitHub);

type Gate =
  | { ok: true; ctx: OccurrenceContext }
  | { ok: false; msg: string; code: 404 | 409 };

async function gate(env: Env, occurrenceId: string): Promise<Gate> {
  const ctx = await getOccurrenceContext(env, occurrenceId);
  if (!ctx) return { ok: false, msg: "Session not found.", code: 404 };
  if (
    ctx.event_status !== EVENT_STATUS.open ||
    ctx.occ_status !== OCCURRENCE_STATUS.scheduled
  )
    return { ok: false, msg: "This session is no longer open.", code: 409 };
  if (new Date(ctx.starts_at).getTime() <= Date.now())
    return { ok: false, msg: "This session has already started.", code: 409 };
  return { ok: true, ctx };
}

signup.get("/o/:id/signup", async (c) => {
  const id = c.get("identity");
  const g = await gate(c.env, c.req.param("id"));
  if (!g.ok) return errorCard(c, g.msg, { status: g.code });

  const { ctx } = g;
  return c.html(
    chrome(
      c,
      `
    <span class="sticker">Confirm signup</span>
    <h1 class="display">${esc(ctx.event_title)}</h1>
    <form class="card" method="post" action="/o/${esc(ctx.occurrence_id)}/signup">
      <p class="label">Session</p>
      <p>${esc(formatInTz(ctx.starts_at, ctx.timezone))}</p>
      <p class="label">Signing up as</p>
      <p>@${esc(id.githubLogin)} · ${esc(id.email)}</p>
      <button type="submit">Confirm signup</button>
    </form>
    <a class="btn" href="/e/${esc(ctx.event_id)}">Back</a>`),
  );
});

signup.post("/o/:id/signup", async (c) => {
  const id = c.get("identity");
  const g = await gate(c.env, c.req.param("id"));
  if (!g.ok) return errorCard(c, g.msg, { status: g.code });

  const { ctx } = g;

  // NoPayment: free events confirm directly. Phase 6 branches here on
  // payment.required(ctx) → Stripe Checkout → pending_payment.
  if (payment.required({ depositCents: ctx.deposit_cents }))
    return errorCard(c, "Paid events arrive in Phase 6.", { status: 501 });

  const r = await reserveConfirmedSeat(c.env, {
    occurrenceId: ctx.occurrence_id,
    eventId: ctx.event_id,
    githubLogin: id.githubLogin,
    githubId: id.githubId,
    email: id.email,
  });

  if (r.kind === "full")
    return errorCard(c, "Sorry — this session is full.", {
      href: `/e/${ctx.event_id}`,
      label: "Back",
      status: 409,
    });

  // ok or duplicate → land on the persistent personal link.
  return c.redirect(`/r/${r.linkToken}`, 302);
});
