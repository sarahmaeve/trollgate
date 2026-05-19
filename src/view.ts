/** Shared HTML shell + escaping. Templates stay semantic; styling is the
 *  Maximalist Pop token system in /public (IMPL.md "Visual design"). */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "./env";

const DEFAULT_BRAND = "Trollgate";

/** Display brand, configurable per deployment via BRAND_NAME. */
export function brandName(env: Env): string {
  return env.BRAND_NAME?.trim() || DEFAULT_BRAND;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;", // Finding 3: also escape single quotes so single-quoted
  //              attribute contexts can't be broken out of.
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]!);
}

/** Soft view state for the global nav (set by loadViewer, never required). */
export interface Viewer {
  signedIn: boolean;
  login: string | null;
  isOrganizer: boolean;
  brand: string;
}

const ANON: Viewer = {
  signedIn: false,
  login: null,
  isOrganizer: false,
  brand: DEFAULT_BRAND,
};

function sidebar(v: Viewer): string {
  const link = (href: string, label: string) =>
    `<li><a href="${href}">${esc(label)}</a></li>`;

  const items = [link("/", "Browse")];
  if (v.isOrganizer) {
    items.push(link("/events", "My events"));
    items.push(link("/events/new", "Create event"));
  }
  if (v.signedIn) {
    items.push(link("/me", "Account"));
    items.push(link("/auth/logout", "Sign out"));
  } else {
    items.push(link("/auth/github/login", "Sign in"));
  }

  return `<nav class="sidebar">
  <a class="brand" href="/">${esc(v.brand)}</a>
  <ul>${items.join("")}</ul>
  ${
    v.signedIn && v.login
      ? `<p class="who label">@${esc(v.login)}</p>`
      : ""
  }
</nav>`;
}

export function layout(body: string, viewer: Viewer = ANON): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(viewer.brand)}</title>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/app.css">
</head>
<body><div class="shell">${sidebar(viewer)}<main class="content stack">${body}</main></div></body>
</html>`;
}

/** layout() with the viewer pulled from request context (set by loadViewer). */
export function chrome(c: Context, body: string): string {
  return layout(body, (c.get("viewer") as Viewer | undefined) ?? ANON);
}

/** Localized timestamp with a safe fallback (never throws on a bad date). */
export function formatInTz(
  iso: string,
  tz: string,
  style: "medium" | "full" = "medium",
): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: style,
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Chromed error page. Sets the HTTP status; nav stays available (no dead end). */
export function errorCard(
  c: Context,
  msg: string,
  opts: { status?: number; href?: string; label?: string } = {},
): Response {
  const href = opts.href ?? "/";
  const label = opts.label ?? "Home";
  const card =
    `<div class="card"><p class="bad">${esc(msg)}</p>` +
    `<a class="btn" href="${esc(href)}">${esc(label)}</a></div>`;
  return c.html(chrome(c, card), (opts.status ?? 400) as ContentfulStatusCode);
}
