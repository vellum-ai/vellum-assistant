/**
 * The date the Plan tile's usage panel prints under its title: the end of the
 * billing cycle the bundle turns over on, as a short month and day in the
 * reader's language. It lives in `lib/billing` so the chat menu's usage panel
 * can share it without a cross-domain import.
 */

import { formatLocale } from "@/i18n";

/**
 * Format an ISO instant as a short month and day. Falls back to the raw string
 * if the value isn't parseable so we never render "Invalid Date". Distinct from
 * `utils/format-date`'s `formatFriendlyDate`, which also carries the year
 * outside the current one.
 *
 * `locale` defaults to {@link formatLocale}, the host region under the app's
 * language, never the catalog language: negotiation collapses en-GB to `en`,
 * which would flip an en-GB host out of its day-first order. Callers normally
 * omit it.
 */
export function formatUsageResetDate(
  iso: string,
  locale: string = formatLocale(),
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(d);
}
