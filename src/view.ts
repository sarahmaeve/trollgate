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
