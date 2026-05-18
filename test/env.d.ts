// Test-only ambient types: bind `cloudflare:test`'s injected env to the
// Worker's Env contract, and allow importing schema.sql as a raw string.
import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
