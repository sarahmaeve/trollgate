-- Local/dev seed: the single v0 organization, its owner, and the membership.
-- Idempotent (INSERT OR IGNORE) so it is safe to re-run.
--
-- TODO before first real login: replace github_id / github_login below with
-- the owner's actual GitHub identity (the OAuth callback will also upsert
-- users on first login, so this is only a convenience for local dev).

INSERT OR IGNORE INTO organizations (id, name, contact_email)
VALUES ('org_seed', 'Git Up and Go', 'sarah@gitupandgo.com');

INSERT OR IGNORE INTO users (id, github_id, github_login, email, name)
VALUES ('usr_seed', 0, 'REPLACE_ME', 'sarah@gitupandgo.com', 'Sarah');

INSERT OR IGNORE INTO memberships (org_id, user_id, role)
VALUES ('org_seed', 'usr_seed', 'owner');
