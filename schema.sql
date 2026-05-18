-- Trollgate D1 schema.
-- Apply locally:  npx wrangler d1 execute trollgate --local --file ./schema.sql
-- Apply remote:   npx wrangler d1 execute trollgate          --file ./schema.sql
--
-- Design rationale lives in IMPL.md (keep this file and that doc in sync).
-- Tables are ordered so every REFERENCES target is created first.

-- Tenancy: one org seeded for v0; another person signing in gets their own
-- auto-created org. stripe_account is the Stripe Connect seam (NULL = global).
CREATE TABLE IF NOT EXISTS organizations (
    id              TEXT PRIMARY KEY,           -- ulid
    name            TEXT NOT NULL,
    contact_email   TEXT NOT NULL,              -- v0 contact; future: org_contacts(type,value)
    stripe_account  TEXT,                       -- NULL = use global account (Connect seam)
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Authenticated humans. Identity is GitHub (owners and attendees alike).
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,           -- ulid
    github_id       INTEGER NOT NULL UNIQUE,
    github_login    TEXT NOT NULL,
    email           TEXT NOT NULL,              -- verified GitHub primary email
    name            TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who may manage an org's events, and at what privilege.
CREATE TABLE IF NOT EXISTS memberships (
    org_id          TEXT NOT NULL REFERENCES organizations(id),
    user_id         TEXT NOT NULL REFERENCES users(id),
    role            TEXT NOT NULL,              -- 'owner' | 'admin' | 'staff'
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, user_id)
);

-- A "series template". A fixed (non-repeating) event is just a series
-- whose rrule produces exactly one occurrence -- single code path.
CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,           -- ulid
    org_id          TEXT NOT NULL REFERENCES organizations(id),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    requirements    TEXT,                       -- free text shown pre-signup
    rrule           TEXT NOT NULL,              -- iCal RRULE; single-shot uses COUNT=1
    timezone        TEXT NOT NULL,              -- IANA, e.g. 'America/Chicago' (DST-correct expansion)
    duration_min    INTEGER NOT NULL,           -- occurrence length; applied at materialization
    max_seats       INTEGER NOT NULL,           -- per occurrence
    deposit_cents   INTEGER NOT NULL DEFAULT 0, -- 0 = free, 500 = $5; per occurrence
    status          TEXT NOT NULL DEFAULT 'open', -- 'open' | 'canceled' (cancels whole series)
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Concrete sessions, materialized from rrule by the Cron (rolling window).
CREATE TABLE IF NOT EXISTS event_occurrences (
    id              TEXT PRIMARY KEY,           -- ulid; referenced by signups.occurrence_id
    event_id        TEXT NOT NULL REFERENCES events(id),
    starts_at       TEXT NOT NULL,              -- RFC3339 UTC (expanded from rrule+timezone)
    ends_at         TEXT NOT NULL,              -- starts_at + duration_min
    status          TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'canceled'
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (event_id, starts_at)                -- idempotent re-materialization
);

-- One row per attendee per session. Seat caps are enforced by a guarded
-- conditional INSERT against this table (see IMPL.md "Seat caps"), counting
-- status IN ('confirmed','pending_payment','refund_pending').
-- Status: pending_payment | confirmed | abandoned | canceled
--         | refund_pending | canceled_refunded
CREATE TABLE IF NOT EXISTS signups (
    id              TEXT PRIMARY KEY,           -- ulid (internal identity only)
    link_token      TEXT NOT NULL UNIQUE,       -- 256-bit CSPRNG; the /r/<token> capability
    occurrence_id   TEXT NOT NULL REFERENCES event_occurrences(id),
    event_id        TEXT NOT NULL REFERENCES events(id),  -- denormalized: cheap "whole series" queries
    github_login    TEXT NOT NULL,
    github_id       INTEGER NOT NULL,
    email           TEXT NOT NULL,              -- verified GitHub primary email
    status          TEXT NOT NULL,
    stripe_session  TEXT,                       -- Checkout Session id
    stripe_payment  TEXT,                       -- PaymentIntent id (for refunds)
    refund_id       TEXT,                       -- Stripe Refund id; set once, never reissued
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at    TEXT,
    canceled_at     TEXT,
    UNIQUE (occurrence_id, github_id)           -- one signup per GitHub user per session
);

-- Async email outbox. Written in the same D1 batch as the cancel; drained
-- by the Cron. sent_at guard makes redelivery idempotent (no double-email).
CREATE TABLE IF NOT EXISTS notifications (
    id              TEXT PRIMARY KEY,           -- ulid
    signup_id       TEXT NOT NULL REFERENCES signups(id),
    kind            TEXT NOT NULL,              -- 'event_canceled' (more later)
    to_email        TEXT NOT NULL,              -- snapshot of signups.email at enqueue
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at         TEXT,                       -- NULL = not yet sent
    attempts        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (signup_id, kind)                    -- one email of a kind per signup
);

CREATE INDEX IF NOT EXISTS idx_occ_event       ON event_occurrences(event_id);
CREATE INDEX IF NOT EXISTS idx_occ_starts      ON event_occurrences(starts_at);
CREATE INDEX IF NOT EXISTS idx_signups_occ     ON signups(occurrence_id);
CREATE INDEX IF NOT EXISTS idx_signups_event   ON signups(event_id);
CREATE INDEX IF NOT EXISTS idx_signups_status  ON signups(status);
CREATE INDEX IF NOT EXISTS idx_notif_unsent    ON notifications(sent_at);
