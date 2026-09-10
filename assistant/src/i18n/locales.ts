/**
 * Locales the daemon can resolve user-facing copy into.
 *
 * Keep this set aligned with `clients/web/src/i18n/supported-locales.ts`.
 * A locale that exists only here cannot be requested by the web app; a
 * locale that exists only there cannot be resolved for CLI or HTTP
 * consumers that go through this module.
 */

export const DEFAULT_LOCALE = "en";

export const SUPPORTED_LOCALES = ["en", "es", "ru", "zh", "zh-TW"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Pick the best shipped locale for an ordered list of preferred BCP 47 tags.
 *
 * Full tag first, then the primary language subtag, so `es-MX` resolves to
 * `es`. `zh-Hant` / `zh-HK` / `zh-MO` map to `zh-TW`.
 */
export function negotiateLocale(preferred: readonly string[]): SupportedLocale {
  for (const tag of preferred) {
    const normalized = tag.trim();
    if (normalized === "") {
      continue;
    }
    const exact = SUPPORTED_LOCALES.find(
      (locale) => locale.toLowerCase() === normalized.toLowerCase(),
    );
    if (exact) {
      return exact;
    }
    const lower = normalized.toLowerCase();
    if (
      lower === "zh-hant" ||
      lower.startsWith("zh-hant-") ||
      lower === "zh-hk" ||
      lower === "zh-mo"
    ) {
      return "zh-TW";
    }
    const base = normalized.split("-")[0]?.toLowerCase();
    const baseMatched = SUPPORTED_LOCALES.find(
      (locale) => locale.toLowerCase() === base,
    );
    if (baseMatched) {
      return baseMatched;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Parse an `Accept-Language` header into preference order and negotiate.
 *
 * Quality values are honored; the header is a hint, not a required input.
 * Missing or empty headers resolve to {@link DEFAULT_LOCALE}.
 */
export function localeFromAcceptLanguage(
  header: string | null | undefined,
): SupportedLocale {
  if (header == null || header.trim() === "") {
    return DEFAULT_LOCALE;
  }
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      let quality = 1;
      for (const param of params) {
        const [name, value] = param.trim().split("=");
        if (name === "q" && value !== undefined) {
          const parsed = Number.parseFloat(value);
          if (Number.isFinite(parsed)) {
            quality = parsed;
          }
        }
      }
      return { tag: tag?.trim() ?? "", quality };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.tag);
  return negotiateLocale(tags);
}
