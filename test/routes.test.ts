import { describe, it, expect, beforeEach } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { applySchema } from "./helpers/db";

beforeEach(applySchema);

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("public surface (DB-backed — proves the Workers pool + schema)", () => {
  it("GET / renders with no events", async () => {
    const res = await call(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No open events yet.");
  });
});

describe("Finding 5 — POST /events must be auth-gated", () => {
  // A fully valid create payload: if requireGitHub does NOT cover the bare
  // `/events` path, the handler runs unauthenticated, dereferences an
  // undefined identity at the INSERT, and 500s. The secure, expected
  // behavior is a 302 redirect to the GitHub login — never reaching the
  // handler body. This test is the regression guard for that gap.
  it("redirects an unauthenticated POST /events to login (no 500)", async () => {
    const form = new FormData();
    form.set("title", "Regression Event");
    form.set("description", "created without a session");
    form.set("timezone", "America/Chicago");
    form.set("starts_local", "2026-06-02T18:00");
    form.set("duration_min", "60");
    form.set("frequency", "once");
    form.set("max_seats", "10");

    const res = await call(
      new Request("http://localhost/events", {
        method: "POST",
        body: form,
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/github/login");

    // And nothing was written by an unauthenticated request.
    const { count } = (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM events",
    ).first<{ count: number }>())!;
    expect(count).toBe(0);
  });
});
