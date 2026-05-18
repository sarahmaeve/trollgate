/**
 * On first login: upsert the user (keyed by github_id), and if they belong
 * to no organization, auto-create one with an owner membership. Idempotent —
 * a returning user just resolves to their existing user + org.
 *
 * This is the "another person signing in gets their own auto-created org"
 * path from IMPL.md. The seeded org is only a local-dev convenience; real
 * logins self-bootstrap here.
 */
import type { Env } from "../env";
import type { GitHubIdentity } from "../auth/github";
import type { Identity } from "../auth/session";
import { newId } from "../id";

export async function bootstrapIdentity(
  env: Env,
  gh: GitHubIdentity,
): Promise<Identity> {
  // Upsert user. RETURNING id yields the existing row's id on conflict
  // (DO UPDATE keeps the PK), so this is stable across logins.
  const userRow = await env.DB.prepare(
    `INSERT INTO users (id, github_id, github_login, email, name)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(github_id) DO UPDATE SET
       github_login = excluded.github_login,
       email        = excluded.email,
       name         = excluded.name
     RETURNING id`,
  )
    .bind(newId("usr"), gh.id, gh.login, gh.email, gh.name)
    .first<{ id: string }>();

  if (!userRow) throw new Error("user upsert returned no row");
  const userId = userRow.id;

  // Already a member of an org? Resolve and return.
  const existing = await env.DB.prepare(
    `SELECT org_id FROM memberships WHERE user_id = ?1 LIMIT 1`,
  )
    .bind(userId)
    .first<{ org_id: string }>();

  let orgId: string;
  if (existing) {
    orgId = existing.org_id;
  } else {
    orgId = newId("org");
    const orgName = gh.name?.trim() || gh.login;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organizations (id, name, contact_email)
         VALUES (?1, ?2, ?3)`,
      ).bind(orgId, orgName, gh.email),
      env.DB.prepare(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES (?1, ?2, 'owner')`,
      ).bind(orgId, userId),
    ]);
  }

  return {
    userId,
    orgId,
    githubId: gh.id,
    githubLogin: gh.login,
    email: gh.email,
  };
}
