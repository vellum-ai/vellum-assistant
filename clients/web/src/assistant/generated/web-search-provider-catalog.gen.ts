// Static catalog of web search providers available in the AI settings page.
// Originally generated in the platform repo; maintained as a static file here.

/** Ordered list of provider ids — drives the picker option order. */
export const WEB_SEARCH_PROVIDER_IDS: readonly string[] = [
  "vellum",
  "inference-provider-native",
  "perplexity",
  "brave",
  "tavily",
  "firecrawl",
  "keenable",
  "fastcrw",
];

/** Short display name used in picker UI. */
export const WEB_SEARCH_PROVIDER_DISPLAY_NAMES: Readonly<
  Record<string, string>
> = {
  vellum: "Vellum",
  "inference-provider-native": "Provider Native",
  perplexity: "Perplexity",
  brave: "Brave",
  tavily: "Tavily",
  firecrawl: "Firecrawl",
  keenable: "Keenable",
  fastcrw: "fastCRW",
};

/** Placeholder hint shown in the API-key input. BYOK providers only. */
export const WEB_SEARCH_PROVIDER_KEY_PLACEHOLDERS: Readonly<
  Record<string, string>
> = {
  perplexity: "pplx-...",
  brave: "BSA...",
  tavily: "tvly-...",
  firecrawl: "fc-...",
  keenable: "keen_... (optional)",
  fastcrw: "crw_live_...",
};

/** localStorage key used to persist each BYOK provider's user-supplied key. */
export const WEB_SEARCH_PROVIDER_KEY_STORAGE: Readonly<Record<string, string>> =
  {
    perplexity: "vellum:ai:perplexityKey",
    brave: "vellum:ai:braveKey",
    tavily: "vellum:ai:tavilyKey",
    firecrawl: "vellum:ai:firecrawlKey",
    keenable: "vellum:ai:keenableKey",
    fastcrw: "vellum:ai:fastcrwKey",
  };

/** Provider ids that require a user-supplied API key. */
export const WEB_SEARCH_BYOK_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "perplexity",
  "brave",
  "tavily",
  "firecrawl",
  "keenable",
  "fastcrw",
]);

/**
 * BYOK providers that also work without a stored key (key is optional).
 * Save is not gated on a credential for these.
 */
export const WEB_SEARCH_KEYLESS_BYOK_PROVIDER_IDS: ReadonlySet<string> =
  new Set(["keenable"]);

/** Provider ids that show an optional API Base field in settings. */
export const WEB_SEARCH_API_BASE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "fastcrw",
]);

/** Cloud default API origin when API Base is left empty. */
export const WEB_SEARCH_PROVIDER_DEFAULT_API_BASE: Readonly<
  Record<string, string>
> = {
  fastcrw: "https://api.fastcrw.com",
};
