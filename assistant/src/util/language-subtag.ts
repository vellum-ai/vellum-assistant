/**
 * The lowercased primary subtag of a BCP 47 (or underscore-separated)
 * language tag: "pt-BR" -> "pt", "es_419" -> "es". Undefined in,
 * undefined out.
 */
export function baseLanguageSubtag(language?: string): string | undefined {
  return language?.toLowerCase().split(/[-_]/)[0];
}
