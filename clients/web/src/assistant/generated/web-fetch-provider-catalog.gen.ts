// Static catalog of web fetch providers available in the AI settings page.
// Mirrors assistant/src/providers/fetch-provider-catalog.ts — keep in sync.

/** Ordered list of provider ids — drives the picker option order. */
export const WEB_FETCH_PROVIDER_IDS: readonly string[] = ["default", "firecrawl"];

/** Short display name used in picker UI. */
export const WEB_FETCH_PROVIDER_DISPLAY_NAMES: Readonly<
  Record<string, string>
> = {
  default: "Vellum",
  firecrawl: "Firecrawl",
};

/** Placeholder hint shown in the API-key input. BYOK providers only. */
export const WEB_FETCH_PROVIDER_KEY_PLACEHOLDERS: Readonly<
  Record<string, string>
> = {
  firecrawl: "fc-...",
};

/**
 * localStorage key used to persist each BYOK provider's user-supplied key.
 * Firecrawl intentionally shares the same key slot as web search — one stored
 * `firecrawl` credential powers both `web_search` and `web_fetch`.
 */
export const WEB_FETCH_PROVIDER_KEY_STORAGE: Readonly<Record<string, string>> = {
  firecrawl: "vellum:ai:firecrawlKey",
};

/** Provider ids that require a user-supplied API key. */
export const WEB_FETCH_BYOK_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "firecrawl",
]);
