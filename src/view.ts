/** Shared HTML shell + escaping. Templates stay semantic; styling is the
 *  Maximalist Pop token system in /public (IMPL.md "Visual design"). */

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );
}

export function layout(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trollgate</title>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/app.css">
</head>
<body><main class="stack">${body}</main></body>
</html>`;
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

/** A full-page error card. Callers set the HTTP status on c.html(...). */
export function errorCard(
  msg: string,
  back: { href: string; label?: string } = { href: "/", label: "Home" },
): string {
  return layout(
    `<div class="card"><p class="bad">${esc(msg)}</p>` +
      `<a class="btn" href="${esc(back.href)}">${esc(
        back.label ?? "Back",
      )}</a></div>`,
  );
}
