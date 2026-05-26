import { getConfig } from "../../config/loader.js";
import type {
  WebSearchMetadata,
  WebSearchResultItem,
} from "../../daemon/message-types/web-activity.js";
import { RiskLevel } from "../../permissions/types.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { faviconUrlForDomain } from "../../util/favicon.js";
import { getLogger } from "../../util/logger.js";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  getHttpRetryDelay,
  sleep,
} from "../../util/retry.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import { extractDomain } from "./domain-normalize.js";

const log = getLogger("web-search");

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const TAVILY_API_URL = "https://api.tavily.com/search";

type WebSearchProvider = "perplexity" | "brave" | "tavily";

/**
 * Arguments passed to every {@link WebSearchAdapter}. The full superset is
 * always supplied; individual adapters ignore the fields they don't use
 * (e.g. Perplexity ignores `count`, `offset`, and `freshness`).
 */
interface WebSearchAdapterArgs {
  query: string;
  count: number;
  offset: number;
  freshness: string | undefined;
  apiKey: string;
  signal?: AbortSignal;
}

/**
 * One built-in web-search provider. Each adapter owns its HTTP shape,
 * freshness mapping, retry behaviour, and result formatter. Registering a
 * new provider becomes a single entry in {@link WEB_SEARCH_ADAPTERS}.
 */
interface WebSearchAdapter {
  /** Stable provider identifier (matches config + secret-catalog values). */
  readonly id: WebSearchProvider;
  /** Secret-catalog key used to look up the API key via `getProviderKeyAsync`. */
  readonly secretKey: string;
  /**
   * Position in the fallback chain (lower = earlier). Used when the
   * configured provider has no key and we try other BYOK providers.
   */
  readonly fallbackOrder: number;
  /** Execute one search against the provider's API. */
  execute(args: WebSearchAdapterArgs): Promise<ToolExecutionResult>;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  query?: { original: string; more_results_available?: boolean };
  web?: { results?: BraveSearchResult[] };
}

interface PerplexityChoice {
  message?: { content?: string };
}

interface PerplexityResponse {
  choices?: PerplexityChoice[];
  citations?: string[];
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
  favicon?: string;
}

interface TavilySearchResponse {
  query?: string;
  results?: TavilySearchResult[];
}

function getWebSearchProvider(): WebSearchProvider {
  const config = getConfig();
  const configured = config.services["web-search"].provider ?? "perplexity";
  // 'inference-provider-native' is handled by the inference provider client
  // directly; fall back to perplexity for other providers.
  if (configured === "inference-provider-native") return "perplexity";
  return configured as WebSearchProvider;
}

async function getApiKey(
  provider: WebSearchProvider,
): Promise<string | undefined> {
  const adapter = WEB_SEARCH_ADAPTERS[provider];
  return (await getProviderKeyAsync(adapter.secretKey)) ?? undefined;
}

function fallbackProvidersFor(
  provider: WebSearchProvider,
): readonly WebSearchProvider[] {
  return WEB_SEARCH_FALLBACK_ORDER.filter(
    (candidate) => candidate !== provider,
  );
}

const CITATION_INSTRUCTION =
  "\n\nWhen presenting these results, cite sources as inline markdown hyperlinks next to the claims they support (e.g., 'according to [Source Title](url)'). Do not list references separately at the end.";

function formatBraveResults(
  results: BraveSearchResult[],
  query: string,
): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines: string[] = [`Web search results for "${query}":\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.description) {
      lines.push(`   ${r.description}`);
    }
    if (r.age) {
      lines.push(`   Age: ${r.age}`);
    }
    if (r.extra_snippets && r.extra_snippets.length > 0) {
      for (const snippet of r.extra_snippets) {
        lines.push(`   > ${snippet}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatPerplexityResults(
  data: PerplexityResponse,
  query: string,
): string {
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return `No results found for "${query}".`;
  }

  const lines: string[] = [`Web search results for "${query}":\n`];
  lines.push(content);

  if (data.citations && data.citations.length > 0) {
    lines.push("\nSources:");
    for (let i = 0; i < data.citations.length; i++) {
      lines.push(`  [${i + 1}] ${data.citations[i]}`);
    }
  }

  return lines.join("\n");
}

function formatTavilyResults(
  data: TavilySearchResponse,
  query: string,
): string {
  const results = data.results ?? [];

  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines: string[] = [`Web search results for "${query}":\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title?.trim() || r.url?.trim() || "Untitled result";
    lines.push(`${i + 1}. ${title}`);
    if (r.url) {
      lines.push(`   URL: ${r.url}`);
    }
    if (r.content) {
      lines.push(`   ${r.content}`);
    }
    if (typeof r.score === "number") {
      lines.push(`   Score: ${r.score.toFixed(3)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildBraveMetadata(
  results: BraveSearchResult[],
  query: string,
  durationMs: number,
): WebSearchMetadata {
  const items: WebSearchResultItem[] = results.map((r, i) => {
    const domain = extractDomain(r.url);
    return {
      rank: i + 1,
      title: r.title,
      url: r.url,
      domain,
      faviconUrl: faviconUrlForDomain(domain),
      snippet: r.description,
      age: r.age,
    };
  });
  return {
    query,
    provider: "brave",
    resultCount: items.length,
    durationMs,
    results: items,
  };
}

function buildPerplexityMetadata(
  data: PerplexityResponse,
  query: string,
  durationMs: number,
): WebSearchMetadata {
  const citations = data.citations ?? [];
  const items: WebSearchResultItem[] = citations.map((url, i) => {
    const domain = extractDomain(url);
    return {
      rank: i + 1,
      title: "",
      url,
      domain,
      faviconUrl: faviconUrlForDomain(domain),
    };
  });
  return {
    query,
    provider: "perplexity",
    resultCount: items.length,
    durationMs,
    results: items,
  };
}

function buildTavilyMetadata(
  data: TavilySearchResponse,
  query: string,
  durationMs: number,
): WebSearchMetadata {
  const results = data.results ?? [];
  const items: WebSearchResultItem[] = results.map((r, i) => {
    const url = r.url ?? "";
    const domain = extractDomain(url);
    return {
      rank: i + 1,
      title: r.title?.trim() || url.trim() || "Untitled result",
      url,
      domain,
      faviconUrl: r.favicon ?? faviconUrlForDomain(domain),
      snippet: r.content,
      score: r.score,
    };
  });
  return {
    query,
    provider: "tavily",
    resultCount: items.length,
    durationMs,
    results: items,
  };
}

function tavilyTimeRangeForFreshness(
  freshness: string | undefined,
): "day" | "week" | "month" | "year" | undefined {
  switch (freshness) {
    case "pd":
      return "day";
    case "pw":
      return "week";
    case "pm":
      return "month";
    case "py":
      return "year";
    default:
      return undefined;
  }
}

function errorResult(
  query: string,
  provider: WebSearchProvider,
  startedAt: number,
  errorMessage: string,
): ToolExecutionResult {
  return {
    content: `Error: ${errorMessage}`,
    isError: true,
    activityMetadata: {
      webSearch: {
        query,
        provider,
        resultCount: 0,
        durationMs: Date.now() - startedAt,
        results: [],
        errorMessage,
      },
    },
  };
}

async function executeBraveSearch(
  query: string,
  count: number,
  offset: number,
  freshness: string | undefined,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    offset: String(offset),
  });

  const validFreshness = ["pd", "pw", "pm", "py"];
  if (freshness && validFreshness.includes(freshness)) {
    params.set("freshness", freshness);
  }

  const url = `${BRAVE_API_URL}?${params.toString()}`;
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal,
    });

    if (response.ok) {
      const data = (await response.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];
      const durationMs = Date.now() - startedAt;
      return {
        content:
          wrapUntrustedContent(formatBraveResults(results, query), {
            source: "search",
            sourceDetail: "brave",
          }) + CITATION_INSTRUCTION,
        isError: false,
        activityMetadata: {
          webSearch: buildBraveMetadata(results, query, durationMs),
        },
      };
    }

    await response.text();

    if (response.status === 401 || response.status === 403) {
      return errorResult(
        query,
        "brave",
        startedAt,
        "Invalid or expired Brave Search API key",
      );
    }

    if (response.status === 429 && attempt < DEFAULT_MAX_RETRIES) {
      const delayMs = getHttpRetryDelay(
        response,
        attempt,
        DEFAULT_BASE_DELAY_MS,
      );
      log.warn(
        { attempt: attempt + 1, delayMs },
        "Brave Search rate limited, retrying",
      );
      await sleep(delayMs);
      continue;
    }

    log.warn({ status: response.status }, "Brave Search API error");
    return errorResult(
      query,
      "brave",
      startedAt,
      response.status === 429
        ? "Brave Search rate limit exceeded after retries. Try again shortly."
        : `Brave Search API returned status ${response.status}`,
    );
  }

  return errorResult(
    query,
    "brave",
    startedAt,
    "Brave Search rate limit exceeded after retries. Try again shortly.",
  );
}

async function executePerplexitySearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: query }],
      }),
      signal,
    });

    if (response.ok) {
      const data = (await response.json()) as PerplexityResponse;
      const durationMs = Date.now() - startedAt;
      return {
        content:
          wrapUntrustedContent(formatPerplexityResults(data, query), {
            source: "search",
            sourceDetail: "perplexity",
          }) + CITATION_INSTRUCTION,
        isError: false,
        activityMetadata: {
          webSearch: buildPerplexityMetadata(data, query, durationMs),
        },
      };
    }

    await response.text();

    if (response.status === 401 || response.status === 403) {
      return errorResult(
        query,
        "perplexity",
        startedAt,
        "Invalid or expired Perplexity API key",
      );
    }

    if (response.status === 429 && attempt < DEFAULT_MAX_RETRIES) {
      const delayMs = getHttpRetryDelay(
        response,
        attempt,
        DEFAULT_BASE_DELAY_MS,
      );
      log.warn(
        { attempt: attempt + 1, delayMs },
        "Perplexity rate limited, retrying",
      );
      await sleep(delayMs);
      continue;
    }

    log.warn({ status: response.status }, "Perplexity API error");
    return errorResult(
      query,
      "perplexity",
      startedAt,
      response.status === 429
        ? "Perplexity rate limit exceeded after retries. Try again shortly."
        : `Perplexity API returned status ${response.status}`,
    );
  }

  return errorResult(
    query,
    "perplexity",
    startedAt,
    "Perplexity rate limit exceeded after retries. Try again shortly.",
  );
}

async function executeTavilySearch(
  query: string,
  count: number,
  freshness: string | undefined,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const timeRange = tavilyTimeRangeForFreshness(freshness);
  const body: Record<string, unknown> = {
    query,
    search_depth: "advanced",
    max_results: count,
  };
  if (timeRange) {
    body.time_range = timeRange;
  }

  const startedAt = Date.now();

  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Client-Source": "vellum-assistant",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (response.ok) {
      const data = (await response.json()) as TavilySearchResponse;
      const durationMs = Date.now() - startedAt;
      return {
        content:
          wrapUntrustedContent(formatTavilyResults(data, query), {
            source: "search",
            sourceDetail: "tavily",
          }) + CITATION_INSTRUCTION,
        isError: false,
        activityMetadata: {
          webSearch: buildTavilyMetadata(data, query, durationMs),
        },
      };
    }

    await response.text();

    if (response.status === 401 || response.status === 403) {
      return errorResult(
        query,
        "tavily",
        startedAt,
        "Invalid or expired Tavily API key",
      );
    }

    if (response.status === 429 && attempt < DEFAULT_MAX_RETRIES) {
      const delayMs = getHttpRetryDelay(
        response,
        attempt,
        DEFAULT_BASE_DELAY_MS,
      );
      log.warn(
        { attempt: attempt + 1, delayMs },
        "Tavily Search rate limited, retrying",
      );
      await sleep(delayMs);
      continue;
    }

    log.warn({ status: response.status }, "Tavily Search API error");
    return errorResult(
      query,
      "tavily",
      startedAt,
      response.status === 429
        ? "Tavily Search rate limit exceeded after retries. Try again shortly."
        : `Tavily Search API returned status ${response.status}`,
    );
  }

  return errorResult(
    query,
    "tavily",
    startedAt,
    "Tavily Search rate limit exceeded after retries. Try again shortly.",
  );
}

// ----------------------------------------------------------------------------
// Adapter registry
//
// Each built-in provider exposes a {@link WebSearchAdapter} wrapping its
// existing execute function. Adding a new provider means adding one adapter
// const and one entry to `WEB_SEARCH_ADAPTERS` — the dispatcher, fallback
// chain, and api-key lookup all derive from this table.
// ----------------------------------------------------------------------------

const perplexitySearchAdapter: WebSearchAdapter = {
  id: "perplexity",
  secretKey: "perplexity",
  fallbackOrder: 1,
  execute: ({ query, apiKey, signal }) =>
    executePerplexitySearch(query, apiKey, signal),
};

const braveSearchAdapter: WebSearchAdapter = {
  id: "brave",
  secretKey: "brave",
  fallbackOrder: 2,
  execute: ({ query, count, offset, freshness, apiKey, signal }) =>
    executeBraveSearch(query, count, offset, freshness, apiKey, signal),
};

const tavilySearchAdapter: WebSearchAdapter = {
  id: "tavily",
  secretKey: "tavily",
  fallbackOrder: 3,
  execute: ({ query, count, freshness, apiKey, signal }) =>
    executeTavilySearch(query, count, freshness, apiKey, signal),
};

/**
 * All built-in web-search adapters keyed by provider id. The
 * `Record<WebSearchProvider, ...>` shape forces TypeScript to flag any
 * provider added to the union without a corresponding adapter.
 */
const WEB_SEARCH_ADAPTERS: Record<WebSearchProvider, WebSearchAdapter> = {
  perplexity: perplexitySearchAdapter,
  brave: braveSearchAdapter,
  tavily: tavilySearchAdapter,
};

/**
 * Fallback chain derived from {@link WEB_SEARCH_ADAPTERS}. Sorted by each
 * adapter's `fallbackOrder` (lower first). Used when the configured provider
 * has no API key and we try other BYOK providers before giving up.
 */
const WEB_SEARCH_FALLBACK_ORDER: readonly WebSearchProvider[] = Object.values(
  WEB_SEARCH_ADAPTERS,
)
  .slice()
  .sort((a, b) => a.fallbackOrder - b.fallbackOrder)
  .map((adapter) => adapter.id);

class WebSearchTool implements Tool {
  name = "web_search";
  description =
    "Search the web and return results. Useful for looking up current information, documentation, or anything the assistant doesn't know.";
  category = "network";
  executionTarget = "sandbox" as const;
  defaultRiskLevel = RiskLevel.Low;
  input_schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string",
      },
      count: {
        type: "number",
        description:
          "Number of results to return (1-20, default 10). Used with Brave and Tavily providers.",
      },
      offset: {
        type: "number",
        description:
          "Pagination offset (0-9, default 0). Only used with Brave provider.",
      },
      freshness: {
        type: "string",
        description:
          'Filter by recency: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year). Used with Brave and Tavily providers.',
      },
    },
    required: ["query"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = input.query;
    if (!query || typeof query !== "string") {
      return {
        content: "Error: query is required and must be a string",
        isError: true,
      };
    }

    const startedAt = Date.now();
    let provider = getWebSearchProvider();
    let apiKey = await getApiKey(provider);

    // Fallback: if the configured provider has no key, try other BYOK search
    // providers in a stable order. This preserves existing installs that only
    // configured one search-provider key while still allowing new providers to
    // be selected explicitly.
    if (!apiKey) {
      for (const fallback of fallbackProvidersFor(provider)) {
        const fallbackKey = await getApiKey(fallback);
        if (!fallbackKey) continue;
        log.info(
          { from: provider, to: fallback },
          "Configured web search provider has no API key, falling back",
        );
        provider = fallback;
        apiKey = fallbackKey;
        break;
      }

      if (!apiKey) {
        return errorResult(
          query,
          provider,
          startedAt,
          "No web search API key configured. Set it via `keys set perplexity <key>`, `keys set brave <key>`, or `keys set tavily <key>`, or configure it from the Settings page under API Keys.",
        );
      }
    }

    try {
      log.debug({ query, provider }, "Executing web search");

      const count =
        typeof input.count === "number"
          ? Math.min(20, Math.max(1, Math.round(input.count)))
          : 10;
      const offset =
        typeof input.offset === "number"
          ? Math.min(9, Math.max(0, Math.round(input.offset)))
          : 0;
      const freshness =
        typeof input.freshness === "string" ? input.freshness : undefined;

      return await WEB_SEARCH_ADAPTERS[provider].execute({
        query,
        count,
        offset,
        freshness,
        apiKey,
        signal: context.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Web search failed");
      return errorResult(query, provider, startedAt, `Web search failed: ${msg}`);
    }
  }
}

export const webSearchTool = new WebSearchTool();
registerTool(webSearchTool);
