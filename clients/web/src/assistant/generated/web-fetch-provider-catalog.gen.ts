// Static catalog of web fetch providers available in the AI settings page.
// Mirrors assistant/src/providers/fetch-provider-catalog.ts — keep in sync.

/** Ordered list of provider ids — drives the picker option order. */
export const WEB_FETCH_PROVIDER_IDS: readonly string[] = [
  "default",
  "firecrawl",
  "fastcrw",
];

/** Short display name used in picker UI. */
export const WEB_FETCH_PROVIDER_DISPLAY_NAMES: Readonly<
  Record<string, string>
> = {
  default: "Vellum",
  firecrawl: "Firecrawl",
  fastcrw: "fastCRW",
};

/** Placeholder hint shown in the API-key input. BYOK providers only. */
export const WEB_FETCH_PROVIDER_KEY_PLACEHOLDERS: Readonly<
  Record<string, string>
> = {
  firecrawl: "fc-...",
  fastcrw: "crw_live_...",
};

/**
 * localStorage key used to persist each BYOK provider's user-supplied key.
 * Firecrawl and fastCRW intentionally share the same key slot as web search —
 * one stored credential powers both `web_search` and `web_fetch`.
 */
export const WEB_FETCH_PROVIDER_KEY_STORAGE: Readonly<Record<string, string>> =
  {
    firecrawl: "vellum:ai:firecrawlKey",
    fastcrw: "vellum:ai:fastcrwKey",
  };

/** Provider ids that require a user-supplied API key. */
export const WEB_FETCH_BYOK_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "firecrawl",
  "fastcrw",
]);

/** Provider ids that show an optional API Base field in settings. */
export const WEB_FETCH_API_BASE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "fastcrw",
]);

/** Cloud default API origin when API Base is left empty. */
export const WEB_FETCH_PROVIDER_DEFAULT_API_BASE: Readonly<
  Record<string, string>
> = {
  fastcrw: "https://api.fastcrw.com",
};
