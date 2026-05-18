/**
 * The single Stripe seam (IMPL.md "Build plan"). The signup/cancel flow
 * depends on PaymentProvider, never on Stripe directly. MVP wires NoPayment;
 * Phase 6 adds a StripePayment implementing the same interface plus the
 * webhook route — no schema or seat/cancel-logic changes.
 */

export interface EventLike {
  depositCents: number;
}

export interface SignupLike {
  id: string;
  email: string;
}

export interface PaymentProvider {
  /** Does this event require payment before a signup is confirmed? */
  required(event: EventLike): boolean;

  /** Begin payment; returns a URL to redirect the user to. */
  startCheckout(event: EventLike, signup: SignupLike): Promise<{ url: string }>;

  /** Refund a paid signup. Must be idempotent (IMPL.md one-refund-max). */
  refund(signup: SignupLike): Promise<void>;
}

/**
 * MVP implementation: every event is free. startCheckout is unreachable
 * because required() is always false and the signup handler only calls it
 * when depositCents > 0 — asserted, not silently ignored.
 */
export class NoPayment implements PaymentProvider {
  required(_event: EventLike): boolean {
    return false;
  }

  async startCheckout(
    event: EventLike,
    _signup: SignupLike,
  ): Promise<{ url: string }> {
    throw new Error(
      `NoPayment.startCheckout called for a paid event (depositCents=${event.depositCents}); ` +
        `paid events require the Phase 6 StripePayment provider`,
    );
  }

  async refund(_signup: SignupLike): Promise<void> {
    // Nothing was charged under NoPayment.
  }
}
