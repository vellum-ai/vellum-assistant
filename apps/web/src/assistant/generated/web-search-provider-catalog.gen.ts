// Static catalog of web search providers available in the AI settings page.
// Originally generated in the platform repo; maintained as a static file here.

/** Ordered list of provider ids — drives the picker option order. */
export const WEB_SEARCH_PROVIDER_IDS: readonly string[] = [
  "inference-provider-native",
  "perplexity",
  "brave",
  "tavily",
];

/** Short display name used in picker UI. */
export const WEB_SEARCH_PROVIDER_DISPLAY_NAMES: Readonly<
  Record<string, string>
> = {
  "inference-provider-native": "Provider Native",
  perplexity: "Perplexity",
  brave: "Brave",
  tavily: "Tavily",
};

/** Placeholder hint shown in the API-key input. BYOK providers only. */
export const WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS: Readonly<
  Record<string, string>
> = {
  perplexity: "pplx-...",
  brave: "BSA...",
  tavily: "tvly-...",
};

/** localStorage key used to persist each BYOK provider's user-supplied key. */
export const WEB_SEARCH_PROVIDER_KEY_STORAGE: Readonly<
  Record<string, string>
> = {
  perplexity: "vellum:ai:perplexityKey",
  brave: "vellum:ai:braveKey",
  tavily: "vellum:ai:tavilyKey",
};

/** Provider ids that require a user-supplied API key. */
export const WEB_SEARCH_BYOK_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "perplexity",
  "brave",
  "tavily",
]);
