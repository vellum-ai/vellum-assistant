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

/**
 * One display string per option, e.g. "French (Français)", shared by every
 * surface that renders the catalog: the Speech-to-Text form's dropdown and
 * the voice-room row and picker.
 */
export function sttLanguageLabel(option: SttLanguageOption): string {
  return option.nativeLabel
    ? `${option.label} (${option.nativeLabel})`
    : option.label;
}

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
 * Daemon provider ids whose language option accepts `"multi"`: Deepgram
 * code-switching is a nova-3 mode, so it only works where nova-3 runs.
 * `deepgram` streams to nova-3 directly and `vellum` relays to Deepgram
 * with the model pinned to nova-3 server-side. Mirrors the resolver's guard
 * in `assistant/src/providers/speech-to-text/resolve.ts`, which drops
 * `"multi"` before it reaches any other adapter (xAI expects BCP-47 codes),
 * so offering it elsewhere would be a silent no-op.
 */
const MULTI_CAPABLE_DAEMON_PROVIDERS: ReadonlySet<string> = new Set([
  "deepgram",
  "vellum",
]);

/**
 * Dropdown options for a picker whose current selection is `currentCode`,
 * steering the daemon provider `daemonProviderId`: the catalog, minus the
 * Multilingual entry for providers whose adapter drops `"multi"` (see
 * `MULTI_CAPABLE_DAEMON_PROVIDERS`), plus a synthetic "(custom)" entry when
 * the code sits outside the offered set. `services.stt.language` accepts any
 * non-empty string (the CLI and chat config edits write codes like "en-US",
 * and can persist `"multi"` for a provider that ignores it), and a trigger
 * that renders blank for such a value invites an accidental overwrite; the
 * synthetic entry keeps the persisted value visible while picking a catalog
 * option still overwrites it normally.
 */
export function sttLanguageOptionsFor(
  currentCode: string,
  daemonProviderId: string,
): readonly SttLanguageOption[] {
  const catalog = MULTI_CAPABLE_DAEMON_PROVIDERS.has(daemonProviderId)
    ? STT_LANGUAGES
    : STT_LANGUAGES.filter((option) => option.code !== STT_MULTI_CODE);
  const inCatalog = catalog.some((option) => option.code === currentCode);
  if (inCatalog) {
    return catalog;
  }
  return [...catalog, { code: currentCode, label: `${currentCode} (custom)` }];
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
