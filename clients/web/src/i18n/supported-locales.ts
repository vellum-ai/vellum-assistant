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
export const SUPPORTED_LOCALES = ["en", "es"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Endonyms: each locale's name in its own language, which is what a language
 * picker should show. A user who has the UI in a language they can't read
 * needs to find their own language by sight, not in translation.
 */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  es: "Español",
};

/**
 * Accented-English pseudolocale, for finding copy that never reached a
 * catalog. See `pseudo-locale.ts` for what it does and `docs/I18N.md` for how
 * to turn it on.
 *
 * Deliberately absent from {@link SUPPORTED_LOCALES}: it is not a language
 * anyone reads, so {@link negotiateLocale} must never return it and a language
 * picker driven by {@link LOCALE_LABELS} must never offer it. The only way in
 * is to set the stored `device:locale` preference to it by hand.
 *
 * `en-XA` is the tag Android and Chrome use for this, so a developer who has
 * met one of those recognizes it.
 */
export const PSEUDO_LOCALE = "en-XA";

export type PseudoLocale = typeof PSEUDO_LOCALE;

/**
 * A locale the app can actually render: the shipped set plus the pseudolocale.
 * Everything on the rendering path (catalog loading, the active locale, the
 * document element) is typed against this; everything a user chooses from is
 * typed against {@link SupportedLocale}.
 */
export type ActiveLocale = SupportedLocale | PseudoLocale;

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function isPseudoLocale(value: unknown): value is PseudoLocale {
  return value === PSEUDO_LOCALE;
}

export function isActiveLocale(value: unknown): value is ActiveLocale {
  return isSupportedLocale(value) || isPseudoLocale(value);
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
