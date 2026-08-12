import { localizedOrDefault } from "../util/language-subtag.js";

/**
 * Look up a per-language voice override in a provider config's
 * `languageVoices` map. The config schema normalizes map keys to lowercase
 * base subtags at parse time, so this is a single exact lookup on the
 * language's base subtag. Returns undefined when the language is unset,
 * the map has no entry for it, or the entry is blank.
 */
export function resolveLanguageVoiceOverride(
  languageVoices: Readonly<Record<string, string>> | undefined,
  language: string | undefined,
): string | undefined {
  if (!languageVoices) {
    return undefined;
  }
  const voice = localizedOrDefault<string | undefined>(
    languageVoices,
    language,
    undefined,
  );
  return voice?.trim() || undefined;
}
