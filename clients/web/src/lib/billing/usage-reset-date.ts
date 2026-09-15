/**
 * The date the Plan tile's usage panel prints under its title: the end of the
 * billing cycle the bundle turns over on, as a short month and day in the
 * reader's language. `locale` is threaded in from `i18n.language` rather than
 * assumed, so en-GB keeps its day-first order. It lives in `lib/billing` so the
 * chat menu's usage panel can share it without a cross-domain import.
 */

/**
 * Format an ISO instant as a short month and day. Falls back to the raw string
 * if the value isn't parseable so we never render "Invalid Date". Distinct from
 * `utils/format-date`'s `formatFriendlyDate`, which also carries the year
 * outside the current one.
 */
export function formatUsageResetDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(d);
}
