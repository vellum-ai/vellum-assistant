// Shared structured result types for web-search and web-fetch tool activity.
//
// These types describe live (SSE-time) metadata that producers (search/fetch
// tool executors) emit and consumers (clients) render alongside the existing
// `result: string` payload. Persistence to conversation history is out of
// scope for this plan; the metadata is live-only.

export type WebSearchProviderId =
  | "anthropic-native"
  | "brave"
  | "perplexity"
  | "tavily"
  | "keenable"
  | "firecrawl";

/** Provider that backed a `web_fetch` call. `default` is the built-in fetcher. */
export type WebFetchProviderId = "default" | "firecrawl";

export interface WebSearchResultItem {
  rank: number; // 1-indexed
  title: string;
  url: string;
  domain: string; // lowercased host
  faviconUrl?: string;
  snippet?: string; // not populated for anthropic-native (content encrypted)
  age?: string; // Brave-only freshness hint
  score?: number; // Tavily-only
}

export interface WebSearchMetadata {
  query: string;
  provider: WebSearchProviderId;
  resultCount: number;
  durationMs: number;
  results: WebSearchResultItem[];
  /** Present when search itself failed; results[] will be empty. */
  errorMessage?: string;
}

export interface WebFetchMetadata {
  url: string;
  finalUrl: string;
  /** Provider that served the fetch. Defaults to the built-in fetcher. */
  provider?: WebFetchProviderId;
  status: number;
  contentType?: string;
  byteCount: number;
  charCount: number;
  truncated: boolean;
  title?: string;
  domain: string;
  faviconUrl?: string;
  redirectCount: number;
  durationMs: number;
  errorMessage?: string;
  /** Set when extracted text is dramatically smaller than raw HTML — likely a JS-rendered SPA whose meaningful content the static fetcher missed. */
  mayRequireJavaScript?: boolean;
}

/** Discriminated container so future tools can add their own metadata. */
export interface ToolActivityMetadata {
  webSearch?: WebSearchMetadata;
  webFetch?: WebFetchMetadata;
}
