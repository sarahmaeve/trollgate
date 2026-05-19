/**
 * IANA timezone helpers. The dropdown is populated from the runtime's own
 * zone database (no hardcoded list to drift); a small fallback covers
 * runtimes lacking Intl.supportedValuesOf.
 */
const FALLBACK = [
  "UTC",
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function timezoneOptions(): string[] {
  const supported = (
    Intl as { supportedValuesOf?: (key: "timeZone") => string[] }
  ).supportedValuesOf;
  const list = supported ? supported("timeZone") : FALLBACK;
  return [...new Set([...list, "UTC"])].sort();
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
