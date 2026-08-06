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
 * Sentinel meaning "unset / provider default". What that default resolves to
 * is the provider's business: code-switching under
 * `MULTI_DEFAULT_DAEMON_PROVIDERS`, native detection under
 * `AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS`, and English otherwise. The row
 * rendered for this code is reframed to say which (see
 * `sttLanguageOptionsFor`), so the picker never labels a default it is not
 * actually getting.
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

/**
 * Explicit English, offered as its own row wherever the default row means
 * something other than English (native detection, or code-switching).
 */
export const STT_PINNED_ENGLISH_CODE = "en";

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
  { code: "ur", label: "Urdu", nativeLabel: "اردو", extended: true },
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
 * unset state means auto-detection. For these providers the picker's
 * default-sentinel row reads "Auto-detect (default)", an explicit English
 * entry lets the user pin English deliberately, and a persisted `"en"`
 * renders as that pin rather than collapsing to the default row (see
 * `use-stt-language-selection.ts`).
 */
export const AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS: ReadonlySet<string> =
  new Set(["xai"]);

/**
 * Daemon provider ids whose unset state resolves to code-switching. Deepgram
 * and the managed relay decode language-less audio as English rather than
 * detecting it, so the daemon fills an unset `services.stt.language` with
 * `"multi"` before it reaches them (`effectiveSttLanguage` in
 * `assistant/src/providers/speech-to-text/resolve.ts`).
 *
 * The picker mirrors that: the default-sentinel row reads "Multilingual
 * (default)", the standalone Multilingual entry drops out (it would be a
 * same-value dead pick), an explicit English entry appears so English can
 * still be pinned deliberately, and a persisted `"multi"` collapses into the
 * default row rather than reading as a separate choice.
 */
export const MULTI_DEFAULT_DAEMON_PROVIDERS: ReadonlySet<string> = new Set([
  "deepgram",
  "vellum",
]);

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
 * Explicit English for providers whose default row does not mean English:
 * the auto-detecting ones and the code-switching ones alike. Pinning English
 * has to stay a deliberate pick on both. Absent from `STT_LANGUAGES` because
 * a provider whose default row already is English would render it twice.
 */
const STT_PINNED_ENGLISH_OPTION: SttLanguageOption = {
  code: STT_PINNED_ENGLISH_CODE,
  label: "English",
};

/**
 * Picker options whose current selection is `currentCode`, steering the
 * daemon provider `daemonProviderId`: the catalog, minus the extended
 * entries for providers outside the verified nova-3 roster (see
 * `NOVA3_ROSTER_DAEMON_PROVIDERS`), minus the Multilingual entry for
 * providers whose adapter drops `"multi"` (see
 * `MULTI_CAPABLE_DAEMON_PROVIDERS`), with the default row reframed for
 * providers whose unset state is not English (Auto-detect for native
 * detection (see `AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS`), Multilingual
 * for code-switching, see `MULTI_DEFAULT_DAEMON_PROVIDERS`), each with an
 * explicit English entry alongside it, plus
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
  const autoDetectScoped = AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS.has(
    daemonProviderId,
  )
    ? base.flatMap((option) =>
        option.code === STT_LANGUAGE_DEFAULT_CODE
          ? [STT_AUTO_DETECT_OPTION, STT_PINNED_ENGLISH_OPTION]
          : [option],
      )
    : base;
  // Providers whose unset state is code-switching drop the sentinel row
  // entirely. Multilingual and English are concrete, separately selectable
  // things here, not a "default" standing in for one of them: config always
  // carries a real language (the schema defaults it to "multi"), so a
  // sentinel would describe a state that no longer exists, and folding
  // Multilingual into it would leave the row unreachable for anyone already
  // shown as being on it.
  const catalog = MULTI_DEFAULT_DAEMON_PROVIDERS.has(daemonProviderId)
    ? autoDetectScoped.flatMap((option) => {
        if (option.code === STT_LANGUAGE_DEFAULT_CODE) {
          return [STT_PINNED_ENGLISH_OPTION];
        }
        return [option];
      })
    : autoDetectScoped;
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
  // Only present where the default row is not itself English, and `feature`
  // skips codes the provider does not offer, so this pins the deliberate
  // English row for those providers and is inert everywhere else.
  feature(STT_PINNED_ENGLISH_CODE);
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
 * A speaker of a code-switching-roster language is already served by the
 * default wherever code-switching is the default, so those locales suggest
 * nothing at all; under a provider that detects natively (xai) the
 * suggestion is the monolingual pin. Languages on the extended roster only
 * (e.g. Tamil) are outside what `multi` can follow, so the suggestion is the
 * monolingual pin itself, and only where nova-3 runs; elsewhere there is
 * nothing valid to suggest.
 *
 * The narrowing is the point: a suggestion should mark the cases the default
 * leaves broken, which after the multilingual default is exactly the
 * languages code-switching cannot follow.
 */
export function suggestedLanguageForLocale(
  navigatorLanguage: string | undefined,
  daemonProviderId: string,
  currentCode: string = STT_LANGUAGE_DEFAULT_CODE,
): string | null {
  const entry = sttCatalogEntryForLocale(navigatorLanguage);
  if (!entry) {
    return null;
  }
  // Already on exactly this language: nothing left to propose.
  if (currentCode === entry.code) {
    return null;
  }
  // Outside what code-switching can follow (Tamil, Chinese, Korean), so the
  // monolingual pin is the only thing that helps, and only where nova-3 runs.
  if (entry.extended) {
    return NOVA3_ROSTER_DAEMON_PROVIDERS.has(daemonProviderId)
      ? entry.code
      : null;
  }
  // On the code-switching roster. Whether this speaker is covered depends on
  // the current selection, not on any provider default: someone pinned to
  // English is transcribed as English regardless.
  if (currentCode === STT_MULTI_CODE) {
    return null;
  }
  // Native detection already covers them, and it is what an unset language
  // means under those providers.
  if (
    currentCode === STT_LANGUAGE_DEFAULT_CODE &&
    AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS.has(daemonProviderId)
  ) {
    return null;
  }
  // Point at code-switching where it exists as a row, and at the monolingual
  // pin under a provider whose adapter drops it.
  return MULTI_CAPABLE_DAEMON_PROVIDERS.has(daemonProviderId)
    ? STT_MULTI_CODE
    : entry.code;
}
