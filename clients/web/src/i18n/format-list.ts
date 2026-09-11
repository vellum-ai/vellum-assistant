import { currentLocale } from "@/i18n/i18n";

/**
 * Names joined for the active locale ("a, b, and c"), so a sentence built
 * around them reads as one rather than as a comma-separated dump.
 */
export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(currentLocale(), {
    style: "long",
    type: "conjunction",
  }).format(items);
}
