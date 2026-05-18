import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// All tests run inside workerd via Miniflare, with the same bindings the
// Worker uses in production (D1 + KV) sourced from wrangler.jsonc. The
// pure-logic suites (recurrence, email) run here too — they are environment
// agnostic, so one pool keeps the setup simple.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-05-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
