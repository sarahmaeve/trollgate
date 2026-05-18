/**
 * Prefixed unique ids for PKs. The schema comments say "ulid"; we don't need
 * lexical sortability for these rows, so a prefixed UUIDv4 keeps it
 * dependency-free while staying an opaque TEXT key.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** URL-safe high-entropy token (session ids, link tokens, OAuth state). */
export function newToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
