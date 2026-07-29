/**
 * Curated spoken-language catalog for STT settings.
 *
 * The set is exactly Deepgram nova-3's `multi` (code-switching) roster,
 * because the managed relay pins nova-3. Extending it requires verifying
 * nova-3 monolingual support in Deepgram's docs first.
 */

export interface SttLanguageOption {
  code: string;
  label: string;
  nativeLabel?: string;
  description?: string;
}

/** Sentinel meaning "unset / provider default": recognition defaults to English. */
export const STT_LANGUAGE_DEFAULT_CODE = "";

export const STT_MULTI_CODE = "multi";

export const STT_LANGUAGES: readonly SttLanguageOption[] = [
  {
    code: STT_LANGUAGE_DEFAULT_CODE,
    label: "English (default)",
    description: "Speech recognition defaults to English.",
  },
  {
    code: STT_MULTI_CODE,
    label: "Multilingual",
    description:
      "Follows you between languages mid-sentence: English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, and Dutch.",
  },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "it", label: "Italian", nativeLabel: "Italiano" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
];

/**
 * Dropdown options for a picker whose current selection is `currentCode`:
 * the catalog, plus a synthetic "(custom)" entry when the code sits outside
 * it. `services.stt.language` accepts any non-empty string (the CLI and chat
 * config edits write codes like "en-US"), and a trigger that renders blank
 * for such a value invites an accidental overwrite; the synthetic entry
 * keeps the persisted value visible while picking a catalog option still
 * overwrites it normally.
 */
export function sttLanguageOptionsFor(
  currentCode: string,
): readonly SttLanguageOption[] {
  const inCatalog = STT_LANGUAGES.some((option) => option.code === currentCode);
  if (inCatalog) {
    return STT_LANGUAGES;
  }
  return [
    ...STT_LANGUAGES,
    { code: currentCode, label: `${currentCode} (custom)` },
  ];
}

/**
 * Suggested STT language for a browser locale (`navigator.language`), or
 * `null` when no suggestion applies (English, empty, or outside the catalog).
 *
 * A non-English-locale speaker talking to an English-speaking assistant is
 * exactly the code-switching case, so the suggestion is `multi`, not the
 * locale's monolingual code.
 */
export function suggestedLanguageForLocale(
  navigatorLanguage: string | undefined,
): string | null {
  if (!navigatorLanguage) {
    return null;
  }
  const primarySubtag = navigatorLanguage.toLowerCase().split("-")[0];
  if (primarySubtag === "en") {
    return null;
  }
  const inCatalog = STT_LANGUAGES.some(
    (option) => option.code === primarySubtag,
  );
  return inCatalog ? STT_MULTI_CODE : null;
}
