import { describe, it, expect } from "vitest";
import { buildEmail, type PendingRow } from "../src/notify/outbox";

const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  notif_id: "ntf_1",
  to_email: "attendee@example.com",
  kind: "event_canceled",
  event_title: "Yoga 101",
  starts_at: "2026-06-02T23:00:00.000Z",
  timezone: "America/Chicago",
  contact_email: "host@example.com",
  ...over,
});

describe("buildEmail", () => {
  it("renders a normal cancellation email", () => {
    const m = buildEmail(row());
    expect(m.subject).toContain("Yoga 101");
    expect(m.html).toContain("<strong>Yoga 101</strong>");
  });

  // Finding 2: event_title is organizer-controlled free text delivered as
  // raw HTML to every attendee. It must be escaped in the HTML body so an
  // organizer cannot inject markup / phishing links into platform email.
  it("escapes attacker-controlled markup in the HTML body", () => {
    const m = buildEmail(
      row({
        event_title: `<script>alert(1)</script><a href="https://evil">x</a>`,
        contact_email: `a"><img src=x onerror=alert(1)>@evil.com`,
      }),
    );
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).not.toContain('<a href="https://evil">');
    expect(m.html).toContain("&lt;script&gt;");
  });
});
