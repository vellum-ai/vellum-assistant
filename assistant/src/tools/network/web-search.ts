import { getConfig } from "../../config/loader.js";
import type {
  WebSearchMetadata,
  WebSearchResultItem,
} from "../../daemon/message-types/web-activity.js";
import { RiskLevel } from "../../permissions/types.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { isAbortReason } from "../../util/abort-reasons.js";
import { faviconUrlForDomain } from "../../util/favicon.js";
import { getLogger } from "../../util/logger.js";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  getHttpRetryDelay,
  sleep,
} from "../../util/retry.js";
import { registerTool } from "../registry.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";
import { extractDomain } from "./domain-normalize.js";
import type { ManagedSearchProxyResult } from "./managed-search-proxy.js";
import {
  classifyWebSearchFailure,
  logWebSearchBackendFailure,
  WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
} from "./web-search-error.js";

const log = getLogger("web-search");

const BRAVE_SEARCH_PATH = "/res/v1/web/search";
const BRAVE_API_URL = `https://api.search.brave.com${BRAVE_SEARCH_PATH}`;
const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const TAVILY_API_URL = "https://api.tavily.com/search";

type WebSearchProvider = "perplexity" | "brave" | "tavily";
type WebSearchMode = "managed" | "your-own";

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
  readonly providerKeyName: string;
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
  // In Your Own mode, `inference-provider-native` is only executable when the
  // inference provider swaps this tool for a native hosted-search definition.
  // If this app-executed tool is still invoked, fall back to the existing BYOK
  // provider chain. Managed mode short-circuits before this function and uses
  // the platform search proxy instead.
  if (configured === "inference-provider-native") return "perplexity";
  return configured as WebSearchProvider;
}

function getWebSearchMode(): WebSearchMode {
  const config = getConfig();
  return config.services["web-search"].mode === "managed"
    ? "managed"
    : "your-own";
}

async function getApiKey(
  provider: WebSearchProvider,
): Promise<string | undefined> {
  const adapter = WEB_SEARCH_ADAPTERS[provider];
  return (await getProviderKeyAsync(adapter.providerKeyName)) ?? undefined;
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

function braveQueryParams(
  query: string,
  count: number,
  offset: number,
  freshness: string | undefined,
): Record<string, string> {
  const params: Record<string, string> = {
    q: query,
    count: String(count),
    offset: String(offset),
  };

  const validFreshness = ["pd", "pw", "pm", "py"];
  if (freshness && validFreshness.includes(freshness)) {
    params.freshness = freshness;
  }

  return params;
}

function successfulBraveResult(
  data: BraveSearchResponse,
  query: string,
  startedAt: number,
): ToolExecutionResult {
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

/**
 * Wrap an already-read provider response body so {@link backendFailureResult}
 * forwards it into the classifier's internal-only `rawDetail` (telemetry). The
 * classifier reads `error.message`; `buildRawDetail` truncates to ≤500 chars.
 * Returns `undefined` for an empty body so we don't pad `rawDetail` with noise.
 * The body must NEVER reach user-facing `content`/`errorMessage`.
 */
function rawBodyDetail(body: unknown): { message: string } | undefined {
  if (body == null) return undefined;
  const text =
    typeof body === "string" ? body : safeStringifyBody(body);
  const trimmed = text.trim();
  return trimmed ? { message: trimmed } : undefined;
}

function safeStringifyBody(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Build a {@link ToolExecutionResult} for a genuine backend/transport failure
 * (5xx, post-retry rate-limit, thrown network/timeout error). Routes the raw
 * detail through {@link classifyWebSearchFailure}: when it is a backend failure
 * we surface the friendly recoverable copy (the bare sentence so the model
 * reads it as guidance — retry / continue-without-search / paste-details —
 * rather than fabricating) in both the model-facing `content` and the client
 * `errorMessage`, and log the raw detail via telemetry. Non-backend categories
 * (e.g. an unexpected 4xx) fall back to {@link errorResult} with `fallback`.
 *
 * Raw provider JSON / status text must never reach `content` or `errorMessage`;
 * only `rawDetail` (internal-only) captures it for the log.
 */
function backendFailureResult(
  query: string,
  provider: WebSearchProvider,
  startedAt: number,
  raw: { error?: unknown; statusCode?: number; errorCode?: string },
  fallback: string,
): ToolExecutionResult {
  const classification = classifyWebSearchFailure({
    isError: true,
    error: raw.error,
    statusCode: raw.statusCode,
    errorCode: raw.errorCode,
  });

  if (!classification.isBackendFailure) {
    return errorResult(query, provider, startedAt, fallback);
  }

  logWebSearchBackendFailure(log, {
    provider,
    errorCategory: classification.category,
    rawDetail: classification.rawDetail,
    fallbackShown: true,
    queryLength: query.length,
  });

  return {
    content: WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    isError: true,
    activityMetadata: {
      webSearch: {
        query,
        provider,
        resultCount: 0,
        durationMs: Date.now() - startedAt,
        results: [],
        errorMessage: WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
      },
    },
  };
}

/**
 * Route a thrown fetch error (network/timeout) through {@link backendFailureResult}
 * as a `backend_unavailable` candidate, falling back to a `Web search failed: …`
 * error for non-backend throws (e.g. a JSON parse error).
 *
 * If the caller aborted the request (`signal.aborted` — the user hit Stop/Esc,
 * or an external caller cancelled), the thrown error is re-thrown so the
 * executor's existing cancellation handling takes over. A user-cancel must NOT
 * surface the friendly backend copy or emit `web_search_backend_failure`
 * telemetry. Internal fetch timeouts (where the caller's signal is not aborted)
 * still route to the friendly backend result.
 */
function networkFailureResult(
  query: string,
  provider: WebSearchProvider,
  startedAt: number,
  err: unknown,
  signal?: AbortSignal,
): ToolExecutionResult {
  if (signal?.aborted || isAbortReason((err as { reason?: unknown })?.reason)) {
    throw err;
  }
  return backendFailureResult(
    query,
    provider,
    startedAt,
    { error: err },
    `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

async function executeBraveSearch(
  query: string,
  count: number,
  offset: number,
  freshness: string | undefined,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const params = new URLSearchParams(
    braveQueryParams(query, count, offset, freshness),
  );
  const url = `${BRAVE_API_URL}?${params.toString()}`;
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });
    } catch (err) {
      return networkFailureResult(query, "brave", startedAt, err, signal);
    }

    if (response.ok) {
      const data = (await response.json()) as BraveSearchResponse;
      return successfulBraveResult(data, query, startedAt);
    }

    const bodyText = await response.text();

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
    return backendFailureResult(
      query,
      "brave",
      startedAt,
      { statusCode: response.status, error: rawBodyDetail(bodyText) },
      response.status === 429
        ? "Brave Search rate limit exceeded after retries. Try again shortly."
        : `Brave Search API returned status ${response.status}`,
    );
  }

  return backendFailureResult(
    query,
    "brave",
    startedAt,
    { statusCode: 429 },
    "Brave Search rate limit exceeded after retries. Try again shortly.",
  );
}

async function executeManagedBraveSearch(
  query: string,
  count: number,
  offset: number,
  freshness: string | undefined,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const { callManagedSearchProxy } = await import("./managed-search-proxy.js");
  const startedAt = Date.now();
  const proxyResult = await callManagedSearchProxy(
    "brave",
    {
      method: "GET",
      path: BRAVE_SEARCH_PATH,
      query: braveQueryParams(query, count, offset, freshness),
      headers: {
        Accept: "application/json",
      },
      body: null,
    },
    signal,
  );

  if (!proxyResult.ok) {
    // Keep billing/auth/unavailable mapping as specific copy; route genuine
    // platform 5xx (transport-level failures) to the friendly backend helper.
    if (
      proxyResult.kind === "platform-error" &&
      proxyResult.status >= 500
    ) {
      return backendFailureResult(
        query,
        "brave",
        startedAt,
        {
          statusCode: proxyResult.status,
          error: rawBodyDetail(proxyResult.body),
        },
        managedSearchProxyErrorMessage(proxyResult),
      );
    }
    return errorResult(
      query,
      "brave",
      startedAt,
      managedSearchProxyErrorMessage(proxyResult),
    );
  }

  if (proxyResult.status >= 200 && proxyResult.status < 300) {
    return successfulBraveResult(
      proxyResult.body as BraveSearchResponse,
      query,
      startedAt,
    );
  }

  if (proxyResult.status === 401 || proxyResult.status === 403) {
    return errorResult(
      query,
      "brave",
      startedAt,
      "Managed Brave Search is not authenticated correctly. This is a Vellum platform configuration issue.",
    );
  }

  if (proxyResult.status === 429 || proxyResult.status >= 500) {
    return backendFailureResult(
      query,
      "brave",
      startedAt,
      {
        statusCode: proxyResult.status,
        error: rawBodyDetail(proxyResult.body),
      },
      proxyResult.status === 429
        ? "Managed Brave Search rate limit exceeded. Try again shortly."
        : `Managed Brave Search provider returned status ${proxyResult.status}`,
    );
  }

  return errorResult(
    query,
    "brave",
    startedAt,
    `Managed Brave Search provider returned status ${proxyResult.status}`,
  );
}

function managedSearchProxyErrorMessage(
  result: Exclude<ManagedSearchProxyResult, { ok: true }>,
): string {
  if (result.kind === "unavailable") {
    return `${result.message} Log in to Vellum or switch web search to Your Own mode.`;
  }

  if (result.kind === "platform-error" && result.status === 402) {
    return "Managed web search is unavailable because your Vellum account balance is too low. Add funds or switch web search to Your Own mode.";
  }

  if (result.kind === "platform-error") {
    return `Managed web search platform request failed: ${result.message}`;
  }

  return result.message;
}

async function executePerplexitySearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(PERPLEXITY_API_URL, {
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
    } catch (err) {
      return networkFailureResult(query, "perplexity", startedAt, err, signal);
    }

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

    const bodyText = await response.text();

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
    return backendFailureResult(
      query,
      "perplexity",
      startedAt,
      { statusCode: response.status, error: rawBodyDetail(bodyText) },
      response.status === 429
        ? "Perplexity rate limit exceeded after retries. Try again shortly."
        : `Perplexity API returned status ${response.status}`,
    );
  }

  return backendFailureResult(
    query,
    "perplexity",
    startedAt,
    { statusCode: 429 },
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
    let response: Response;
    try {
      response = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Client-Source": "vellum-assistant",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      return networkFailureResult(query, "tavily", startedAt, err, signal);
    }

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

    const bodyText = await response.text();

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
    return backendFailureResult(
      query,
      "tavily",
      startedAt,
      { statusCode: response.status, error: rawBodyDetail(bodyText) },
      response.status === 429
        ? "Tavily Search rate limit exceeded after retries. Try again shortly."
        : `Tavily Search API returned status ${response.status}`,
    );
  }

  return backendFailureResult(
    query,
    "tavily",
    startedAt,
    { statusCode: 429 },
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
  providerKeyName: "perplexity",
  fallbackOrder: 1,
  execute: ({ query, apiKey, signal }) =>
    executePerplexitySearch(query, apiKey, signal),
};

const braveSearchAdapter: WebSearchAdapter = {
  id: "brave",
  providerKeyName: "brave",
  fallbackOrder: 2,
  execute: ({ query, count, offset, freshness, apiKey, signal }) =>
    executeBraveSearch(query, count, offset, freshness, apiKey, signal),
};

const managedBraveSearchAdapter: WebSearchAdapter = {
  id: "brave",
  providerKeyName: "brave",
  fallbackOrder: 2,
  execute: ({ query, count, offset, freshness, signal }) =>
    executeManagedBraveSearch(query, count, offset, freshness, signal),
};

const tavilySearchAdapter: WebSearchAdapter = {
  id: "tavily",
  providerKeyName: "tavily",
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

export const webSearchTool = {
  name: "web_search",
  description:
    "Search the web and return results. Useful for looking up current information, documentation, or anything the assistant doesn't know.",
  category: "network",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
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
  },

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
    const mode = getWebSearchMode();

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

    if (mode === "managed") {
      try {
        log.debug({ query, provider: "brave" }, "Executing managed web search");
        return await managedBraveSearchAdapter.execute({
          query,
          count,
          offset,
          freshness,
          apiKey: "",
          signal: context.signal,
        });
      } catch (err) {
        log.error({ err }, "Managed web search failed");
        return networkFailureResult(
          query,
          "brave",
          startedAt,
          err,
          context.signal,
        );
      }
    }

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

      return await WEB_SEARCH_ADAPTERS[provider].execute({
        query,
        count,
        offset,
        freshness,
        apiKey,
        signal: context.signal,
      });
    } catch (err) {
      log.error({ err }, "Web search failed");
      return networkFailureResult(
        query,
        provider,
        startedAt,
        err,
        context.signal,
      );
    }
  },
} satisfies ToolDefinition;

registerTool(webSearchTool);
