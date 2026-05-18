/**
 * CSV field encoding for the attendee export.
 *
 * Two concerns:
 *  - RFC 4180: quote every field, escape embedded quotes by doubling.
 *  - Finding 4 (CSV formula injection): a spreadsheet treats a cell beginning
 *    with `= + - @` (or a leading TAB/CR) as a formula. Attendee-derived
 *    fields (notably `email`) flow into this export, so a crafted value could
 *    execute on the organizer's machine. Neutralize by prefixing such a value
 *    with a single quote, which forces the spreadsheet to treat it as text.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const guarded = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
