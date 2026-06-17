// Mirrors assistant/src/daemon/message-types/web-activity.ts in vellum-ai/vellum-assistant — keep in sync.

export type WebSearchProviderId =
  | "anthropic-native"
  | "brave"
  | "perplexity"
  | "tavily";

export interface WebSearchResultItem {
  rank: number;
  title: string;
  url: string;
  domain: string;
  faviconUrl?: string;
  snippet?: string;
  age?: string;
  score?: number;
}

export interface WebSearchMetadata {
  query: string;
  provider: WebSearchProviderId;
  resultCount: number;
  durationMs: number;
  results: WebSearchResultItem[];
  errorMessage?: string;
}

export interface WebFetchMetadata {
  url: string;
  finalUrl: string;
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
  mayRequireJavaScript?: boolean;
}

export interface ToolActivityMetadata {
  webSearch?: WebSearchMetadata;
  webFetch?: WebFetchMetadata;
}
