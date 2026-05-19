-- Local demo data: an "attended" event with confirmed attendees, so you can
-- cancel it in the browser and watch the outbox / Resend sink — no GitHub
-- accounts needed (attendees are seeded rows, ids negative so they can never
-- collide with real GitHub ids).
--
-- Re-runnable (clears its own rows first). The demo event is attached to the
-- org owned by the most-recently-created user — i.e. you, after a real
-- GitHub login. Log in once before running, or it lands on the seed org and
-- you won't be authorized to cancel it.
--
--   npm run seed:demo

DELETE FROM notifications WHERE signup_id IN
  (SELECT id FROM signups WHERE event_id = 'evt_demo');
DELETE FROM signups            WHERE event_id = 'evt_demo';
DELETE FROM event_occurrences  WHERE event_id = 'evt_demo';
DELETE FROM events             WHERE id = 'evt_demo';

INSERT INTO events
  (id, org_id, title, description, requirements, rrule, timezone,
   duration_min, max_seats, deposit_cents, status)
SELECT
  'evt_demo',
  (SELECT m.org_id FROM memberships m
     JOIN users u ON u.id = m.user_id
    WHERE m.role = 'owner'
    ORDER BY u.created_at DESC LIMIT 1),
  'DEMO — Attended Event',
  'Seeded demo with confirmed attendees. Cancel me to exercise the outbox.',
  NULL,
  'DTSTART;TZID=America/Los_Angeles:20350101T180000' || char(10) ||
    'RRULE:FREQ=DAILY;COUNT=1',
  'America/Los_Angeles',
  60, 10, 0, 'open';

INSERT INTO event_occurrences (id, event_id, starts_at, ends_at, status)
VALUES (
  'occ_demo', 'evt_demo',
  strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '+30 days'),
  strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '+30 days', '+1 hour'),
  'scheduled');

INSERT INTO signups
  (id, link_token, occurrence_id, event_id, github_login, github_id, email,
   status, confirmed_at)
VALUES
  ('sgn_demo1','tok_demo1','occ_demo','evt_demo','demo_attendee_1',-101,
   'demo1@example.test','confirmed',datetime('now')),
  ('sgn_demo2','tok_demo2','occ_demo','evt_demo','demo_attendee_2',-102,
   'demo2@example.test','confirmed',datetime('now')),
  ('sgn_demo3','tok_demo3','occ_demo','evt_demo','demo_attendee_3',-103,
   'demo3@example.test','confirmed',datetime('now'));
