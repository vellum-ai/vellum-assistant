/**
 * Curated spoken-language catalog for STT settings.
 *
 * The monolingual set is exactly Deepgram nova-3's verified monolingual
 * roster (per Deepgram's models-languages-overview documentation), because
 * the managed relay pins nova-3; the daemon holds the authoritative code
 * list (`DEEPGRAM_NOVA3_MONOLINGUAL_CODES`) and a parity test pins this
 * catalog to it. Extending it requires verifying nova-3 monolingual support
 * in Deepgram's docs first. Base codes only: regional variants ("en-US")
 * stay expressible as custom values.
 */

export interface SttLanguageOption {
  code: string;
  label: string;
  nativeLabel?: string;
  description?: string;
  /**
   * Member of the extended nova-3 monolingual roster, verified against
   * Deepgram's docs only: offered where nova-3 runs (see
   * `NOVA3_ROSTER_DAEMON_PROVIDERS`) and withheld from other daemon
   * providers, which keep the pre-expansion multi-roster set they were
   * verified with.
   */
  extended?: boolean;
}

/**
 * Sentinel meaning "unset / provider default": recognition defaults to
 * English, except under providers in `AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS`,
 * where unset means native language auto-detection.
 */
export const STT_LANGUAGE_DEFAULT_CODE = "";

/**
 * One display string per option, e.g. "French (Français)", shared by every
 * surface that renders the catalog: the Speech-to-Text form's trigger row and
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
  // Monolinguals A-Z by English label. Entries without `extended` are the
  // nova-3 `multi` (code-switching) roster, offered to every
  // language-selectable provider; `extended` entries are the rest of the
  // nova-3 monolingual roster (see the field's doc).
  { code: "ar", label: "Arabic", nativeLabel: "العربية", extended: true },
  {
    code: "be",
    label: "Belarusian",
    nativeLabel: "Беларуская",
    extended: true,
  },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা", extended: true },
  { code: "bs", label: "Bosnian", nativeLabel: "Bosanski", extended: true },
  { code: "bg", label: "Bulgarian", nativeLabel: "Български", extended: true },
  { code: "ca", label: "Catalan", nativeLabel: "Català", extended: true },
  { code: "zh", label: "Chinese", nativeLabel: "中文", extended: true },
  { code: "hr", label: "Croatian", nativeLabel: "Hrvatski", extended: true },
  { code: "cs", label: "Czech", nativeLabel: "Čeština", extended: true },
  { code: "da", label: "Danish", nativeLabel: "Dansk", extended: true },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
  { code: "et", label: "Estonian", nativeLabel: "Eesti", extended: true },
  { code: "fi", label: "Finnish", nativeLabel: "Suomi", extended: true },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "el", label: "Greek", nativeLabel: "Ελληνικά", extended: true },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી", extended: true },
  { code: "he", label: "Hebrew", nativeLabel: "עברית", extended: true },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "hu", label: "Hungarian", nativeLabel: "Magyar", extended: true },
  {
    code: "id",
    label: "Indonesian",
    nativeLabel: "Bahasa Indonesia",
    extended: true,
  },
  { code: "it", label: "Italian", nativeLabel: "Italiano" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ", extended: true },
  { code: "ko", label: "Korean", nativeLabel: "한국어", extended: true },
  { code: "lv", label: "Latvian", nativeLabel: "Latviešu", extended: true },
  { code: "lt", label: "Lithuanian", nativeLabel: "Lietuvių", extended: true },
  {
    code: "mk",
    label: "Macedonian",
    nativeLabel: "Македонски",
    extended: true,
  },
  { code: "ms", label: "Malay", nativeLabel: "Bahasa Melayu", extended: true },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी", extended: true },
  { code: "no", label: "Norwegian", nativeLabel: "Norsk", extended: true },
  { code: "fa", label: "Persian", nativeLabel: "فارسی", extended: true },
  { code: "pl", label: "Polish", nativeLabel: "Polski", extended: true },
  { code: "pt", label: "Portuguese", nativeLabel: "Português" },
  { code: "ro", label: "Romanian", nativeLabel: "Română", extended: true },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "sr", label: "Serbian", nativeLabel: "Српски", extended: true },
  { code: "sk", label: "Slovak", nativeLabel: "Slovenčina", extended: true },
  {
    code: "sl",
    label: "Slovenian",
    nativeLabel: "Slovenščina",
    extended: true,
  },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "sv", label: "Swedish", nativeLabel: "Svenska", extended: true },
  { code: "tl", label: "Tagalog", extended: true },
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்", extended: true },
  { code: "te", label: "Telugu", nativeLabel: "తెలుగు", extended: true },
  { code: "th", label: "Thai", nativeLabel: "ไทย", extended: true },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe", extended: true },
  { code: "uk", label: "Ukrainian", nativeLabel: "Українська", extended: true },
  {
    code: "vi",
    label: "Vietnamese",
    nativeLabel: "Tiếng Việt",
    extended: true,
  },
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
 * Daemon provider ids that get the extended nova-3 monolingual roster (the
 * `extended` entries). The extended entries are verified against Deepgram's
 * nova-3 documentation only, so they are offered exactly where nova-3 runs:
 * `deepgram` directly and `vellum` via the managed relay (model pinned to
 * nova-3 server-side). Other language-selectable providers (xai) keep the
 * pre-expansion multi-roster set they were verified with; an unverified code
 * there could silently degrade recognition rather than error.
 */
const NOVA3_ROSTER_DAEMON_PROVIDERS: ReadonlySet<string> = new Set([
  "deepgram",
  "vellum",
]);

/**
 * Daemon provider ids that detect the spoken language natively when
 * `services.stt.language` is unset: the resolver sends no language, so the
 * unset state means auto-detection, not English. Deepgram and the managed
 * relay decode unset audio as English, so their default row stays
 * English-framed. For these providers the picker's default-sentinel row
 * reads "Auto-detect (default)", an explicit English entry lets the user
 * pin English deliberately, and a persisted `"en"` renders as that pin
 * rather than collapsing to the default row (see
 * `use-stt-language-selection.ts`).
 */
export const AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS: ReadonlySet<string> =
  new Set(["xai"]);

/**
 * The default-sentinel row for providers in
 * `AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS`, replacing the English-framed
 * one. The description states the one-way door plainly: the picker only
 * writes non-empty codes (`config_patch` cannot delete the key), so once a
 * language is pinned, returning to auto-detect happens outside this picker.
 */
const STT_AUTO_DETECT_OPTION: SttLanguageOption = {
  code: STT_LANGUAGE_DEFAULT_CODE,
  label: "Auto-detect (default)",
  description:
    "xAI identifies the spoken language natively. Picking a specific language pins it; returning to auto-detect requires clearing services.stt.language outside this picker.",
};

/**
 * Explicit English for auto-detecting providers, where the default row no
 * longer means English and pinning it must be a deliberate pick. Absent from
 * `STT_LANGUAGES` because for every other provider the default row already
 * is English, and a second English entry would be a same-value dead pick.
 */
const STT_PINNED_ENGLISH_OPTION: SttLanguageOption = {
  code: "en",
  label: "English",
};

/**
 * Picker options whose current selection is `currentCode`, steering the
 * daemon provider `daemonProviderId`: the catalog, minus the extended
 * entries for providers outside the verified nova-3 roster (see
 * `NOVA3_ROSTER_DAEMON_PROVIDERS`), minus the Multilingual entry for
 * providers whose adapter drops `"multi"` (see
 * `MULTI_CAPABLE_DAEMON_PROVIDERS`), with the default row swapped to
 * Auto-detect plus an explicit English entry for providers whose unset state
 * is native detection (see `AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS`), plus
 * a synthetic "(custom)" entry when the code sits outside the offered set.
 * `services.stt.language` accepts any non-empty string (the CLI and chat
 * config edits write codes like "en-US", and can persist `"multi"` for a
 * provider that ignores it), and a trigger that renders blank for such a
 * value invites an accidental overwrite; the synthetic entry keeps the
 * persisted value visible while picking a catalog option still overwrites it
 * normally.
 */
export function sttLanguageOptionsFor(
  currentCode: string,
  daemonProviderId: string,
): readonly SttLanguageOption[] {
  const scoped = NOVA3_ROSTER_DAEMON_PROVIDERS.has(daemonProviderId)
    ? STT_LANGUAGES
    : STT_LANGUAGES.filter((option) => !option.extended);
  const base = MULTI_CAPABLE_DAEMON_PROVIDERS.has(daemonProviderId)
    ? scoped
    : scoped.filter((option) => option.code !== STT_MULTI_CODE);
  // Providers whose unset state is native auto-detection get the reframed
  // default row and the explicit English entry in its place, ahead of the
  // monolinguals; everyone else gets the base list byte-identical.
  const catalog = AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS.has(daemonProviderId)
    ? base.flatMap((option) =>
        option.code === STT_LANGUAGE_DEFAULT_CODE
          ? [STT_AUTO_DETECT_OPTION, STT_PINNED_ENGLISH_OPTION]
          : [option],
      )
    : base;
  const inCatalog = catalog.some((option) => option.code === currentCode);
  if (inCatalog) {
    return catalog;
  }
  return [...catalog, { code: currentCode, label: `${currentCode} (custom)` }];
}

/** The grouped shape the search-first picker renders. */
export interface SttLanguageGroups {
  /**
   * The pinned rows shown above the A-Z list, in order: the current value,
   * the default-sentinel row, Multilingual (where the provider supports it),
   * and the locale-suggested entry, deduplicated. Any "Suggested" annotation
   * is left to callers.
   */
  featured: SttLanguageOption[];
  /** Every remaining option, sorted A-Z by English label. */
  rest: SttLanguageOption[];
}

/**
 * The provider-scoped options of `sttLanguageOptionsFor`, split into the
 * picker's pinned Featured group and the A-Z remainder. Codes absent from
 * the provider's option set (e.g. a `suggestedCode` the provider doesn't
 * offer) are skipped rather than invented.
 */
export function sttLanguageGroupsFor(
  currentCode: string,
  daemonProviderId: string,
  suggestedCode?: string | null,
): SttLanguageGroups {
  const options = sttLanguageOptionsFor(currentCode, daemonProviderId);
  const featuredCodes: string[] = [];
  const feature = (code: string) => {
    if (
      !featuredCodes.includes(code) &&
      options.some((option) => option.code === code)
    ) {
      featuredCodes.push(code);
    }
  };
  feature(currentCode);
  feature(STT_LANGUAGE_DEFAULT_CODE);
  feature(STT_MULTI_CODE);
  if (suggestedCode != null) {
    feature(suggestedCode);
  }
  const featured = featuredCodes.map(
    (code) => options.find((option) => option.code === code)!,
  );
  const rest = options
    .filter((option) => !featuredCodes.includes(option.code))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { featured, rest };
}

/**
 * Whether `option` matches the picker's search `query` (trimmed,
 * case-insensitive): substring on the English and native labels, prefix on
 * the code. Substring label matching deliberately over-matches ("ta" hits
 * Italian and Catalan alongside Tamil and Tagalog): in a ~50-row list,
 * recall beats precision, and the prefix rule on codes keeps a typed code
 * exact ("ta" never code-matches "th"). An empty query matches everything.
 */
export function sttLanguageMatches(
  option: SttLanguageOption,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return true;
  }
  if (option.label.toLowerCase().includes(q)) {
    return true;
  }
  if (option.nativeLabel && option.nativeLabel.toLowerCase().includes(q)) {
    return true;
  }
  return option.code.toLowerCase().startsWith(q);
}

/**
 * Display label for the code as the provider-scoped option list renders it:
 * the catalog label when the code is in the catalog (Multilingual under a
 * multi-capable provider), else the synthetic "(custom)" label. Falls back
 * to the raw code defensively, though `sttLanguageOptionsFor` always
 * represents the current code.
 */
export function sttLanguageLabelForCode(
  code: string,
  daemonProviderId: string,
): string {
  const option = sttLanguageOptionsFor(code, daemonProviderId).find(
    (candidate) => candidate.code === code,
  );
  return option ? sttLanguageLabel(option) : code;
}

/**
 * The catalog entry a browser locale (`navigator.language`) maps to, or
 * `null` when none does (English, empty, or outside the catalog).
 * Provider-agnostic locale evidence: the first-run card uses it to decide
 * whether the language queries are worth enabling before the configured
 * provider is known, then derives the actual suggestion with
 * `suggestedLanguageForLocale` once it is.
 */
export function sttCatalogEntryForLocale(
  navigatorLanguage: string | undefined,
): SttLanguageOption | null {
  if (!navigatorLanguage) {
    return null;
  }
  const primarySubtag = navigatorLanguage.toLowerCase().split("-")[0];
  if (primarySubtag === "en") {
    return null;
  }
  return STT_LANGUAGES.find((option) => option.code === primarySubtag) ?? null;
}

/**
 * Suggested STT language for a browser locale (`navigator.language`) under
 * the daemon provider `daemonProviderId`, or `null` when no suggestion
 * applies (English, empty, outside the catalog, or a language the provider's
 * option set does not offer). Provider-aware at the source so every caller
 * inherits the same scoping the option lists use: a code
 * `sttLanguageOptionsFor` withholds is never suggested.
 *
 * A speaker of a code-switching-roster language talking to an
 * English-speaking assistant is exactly the code-switching case, so those
 * locales suggest `multi` where the provider supports it; where it does not
 * (xai), the suggestion falls back to the monolingual pin, which every
 * language-selectable provider offers. Languages on the extended roster only
 * (e.g. Tamil) are outside what `multi` can follow, so the suggestion is the
 * monolingual pin itself, and only where nova-3 runs; elsewhere there is
 * nothing valid to suggest.
 */
export function suggestedLanguageForLocale(
  navigatorLanguage: string | undefined,
  daemonProviderId: string,
): string | null {
  const entry = sttCatalogEntryForLocale(navigatorLanguage);
  if (!entry) {
    return null;
  }
  if (entry.extended) {
    return NOVA3_ROSTER_DAEMON_PROVIDERS.has(daemonProviderId)
      ? entry.code
      : null;
  }
  return MULTI_CAPABLE_DAEMON_PROVIDERS.has(daemonProviderId)
    ? STT_MULTI_CODE
    : entry.code;
}
