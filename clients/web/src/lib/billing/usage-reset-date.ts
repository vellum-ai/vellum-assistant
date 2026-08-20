/**
 * The date the usage bars print beside themselves: the end of the cycle the
 * reading measures, as a short month and day in the reader's language. Shared
 * by the billing page's Usage Balance panel and the preferences menu's panel
 * so the same cycle can never be written two ways.
 */
export function formatUsageResetDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}
