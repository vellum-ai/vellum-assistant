/**
 * The set of locales the app ships, plus the negotiation that maps an ordered
 * list of user-preferred BCP 47 tags onto one of them.
 *
 * Negotiation is deliberately simple and explicit rather than delegating to
 * `Intl.LocaleMatcher` (still a stage-1 proposal) or i18next's own detector:
 * we match the full tag first, then fall back to the primary language subtag,
 * so `es-419` and `es-MX` both resolve to `es` without needing an entry each.
 *
 * References:
 * - https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Language
 * - https://www.rfc-editor.org/rfc/rfc5646 (BCP 47 tag structure)
 */

/** Locale used when nothing else matches. Also the source language for copy. */
export const DEFAULT_LOCALE = "en";

/**
 * Locales with a translation catalog under `src/i18n/locales/`.
 *
 * Adding a locale means: add the tag here, add the catalog directory, and add
 * the loader entry in `catalogs.ts`. All three are checked at compile time:
 * `catalogs.ts` types its registry as `Record<SupportedLocale, …>`, so a
 * missing loader is a type error rather than a runtime 404.
 */
export const SUPPORTED_LOCALES = ["en", "es", "ru"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Endonyms: each locale's name in its own language, which is what a language
 * picker should show. A user who has the UI in a language they can't read
 * needs to find their own language by sight, not in translation.
 */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  es: "Español",
  ru: "Русский",
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Pick the best supported locale for an ordered list of preferred tags.
 *
 * Each tag is tried at full length and then truncated to its primary subtag
 * before moving to the next preference. A user who prefers `es-MX` over `en`
 * gets `es`, not `en`. Returns {@link DEFAULT_LOCALE} when nothing matches.
 */
export function negotiateLocale(preferred: readonly string[]): SupportedLocale {
  for (const tag of preferred) {
    const normalized = tag.trim().toLowerCase();
    if (normalized === "") {
      continue;
    }
    if (isSupportedLocale(normalized)) {
      return normalized;
    }
    const base = normalized.split("-")[0];
    if (isSupportedLocale(base)) {
      return base;
    }
  }
  return DEFAULT_LOCALE;
}
