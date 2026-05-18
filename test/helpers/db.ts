import { env } from "cloudflare:test";
import schemaSql from "../../schema.sql?raw";

/**
 * Apply schema.sql to the test D1. Miniflare's D1 starts empty and (with
 * isolated storage) is reset between tests, so call this in beforeEach for
 * any DB-backed suite.
 *
 * `--` comments are stripped to end-of-line *first* (schema.sql has inline
 * comments containing `;`, e.g. line 13), then statements are split on `;`.
 * The schema has no `--` or `;` inside string literals, so this is sufficient.
 */
export async function applySchema(): Promise<void> {
  const statements = schemaSql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
}
