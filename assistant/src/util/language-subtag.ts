/**
 * The lowercased primary subtag of a BCP 47 (or underscore-separated)
 * language tag: "pt-BR" -> "pt", "es_419" -> "es", "  EN-us " -> "en".
 * Undefined for undefined or blank input. The one language-tag
 * normalizer in the daemon: every language comparison, table lookup, and
 * prompt interpolation goes through this so a regional variant can never
 * slip past a base-subtag consumer.
 */
export function baseLanguageSubtag(language?: string): string | undefined {
  const base = language?.trim().toLowerCase().split(/[-_]/)[0];
  return base ? base : undefined;
}

/**
 * Whether the table carries its own entry for the language, keyed by
 * lowercased base subtag. False for unset languages and for prototype keys
 * ("constructor", "toString") rather than table entries. When this is
 * false, {@link localizedOrDefault} returns the fallback, so callers whose
 * fallback is English text can label the result as English (e.g. for a TTS
 * language hint) instead of the requested language.
 */
export function hasLocalizedEntry(
  table: Readonly<Record<string, unknown>>,
  language: string | undefined,
): boolean {
  const base = baseLanguageSubtag(language);
  return base !== undefined && Object.hasOwn(table, base);
}

/**
 * Look up a per-language value in a plain-record table keyed by lowercase
 * base subtags, falling back when the language is unset, unknown, or a
 * prototype key ("constructor", "toString") rather than a table entry.
 */
export function localizedOrDefault<T>(
  table: Readonly<Record<string, T>>,
  language: string | undefined,
  fallback: T,
): T {
  return hasLocalizedEntry(table, language)
    ? (table[baseLanguageSubtag(language)!] as T)
    : fallback;
}
