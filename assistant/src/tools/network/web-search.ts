import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getSecureKey } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  getHttpRetryDelay,
  sleep,
} from "../../util/retry.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("web-search");

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

type WebSearchProvider = "perplexity" | "brave";

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

function getWebSearchProvider(): WebSearchProvider {
  const config = getConfig();
  const configured = config.webSearchProvider ?? "perplexity";
  // 'anthropic-native' is handled by the Anthropic client directly;
  // fall back to perplexity for other providers.
  if (configured === "anthropic-native") return "perplexity";
  return configured as WebSearchProvider;
}

function getApiKey(provider: WebSearchProvider): string | undefined {
  if (provider === "brave") {
    if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
    const secureKey = getSecureKey("brave");
    if (secureKey) return secureKey;
    const config = getConfig();
    return config.apiKeys.brave;
  }

  // Perplexity
  if (process.env.PERPLEXITY_API_KEY) return process.env.PERPLEXITY_API_KEY;
  const secureKey = getSecureKey("perplexity");
  if (secureKey) return secureKey;
  const config = getConfig();
  return config.apiKeys.perplexity;
}

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
      return { content: formatBraveResults(results, query), isError: false };
    }

    await response.text();

    if (response.status === 401 || response.status === 403) {
      return {
        content: "Error: Invalid or expired Brave Search API key",
        isError: true,
      };
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
    if (response.status === 429) {
      return {
        content:
          "Error: Brave Search rate limit exceeded after retries. Try again shortly.",
        isError: true,
      };
    }
    return {
      content: `Error: Brave Search API returned status ${response.status}`,
      isError: true,
    };
  }

  return {
    content:
      "Error: Brave Search rate limit exceeded after retries. Try again shortly.",
    isError: true,
  };
}

async function executePerplexitySearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
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
      return { content: formatPerplexityResults(data, query), isError: false };
    }

    await response.text();

    if (response.status === 401 || response.status === 403) {
      return {
        content: "Error: Invalid or expired Perplexity API key",
        isError: true,
      };
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
    if (response.status === 429) {
      return {
        content:
          "Error: Perplexity rate limit exceeded after retries. Try again shortly.",
        isError: true,
      };
    }
    return {
      content: `Error: Perplexity API returned status ${response.status}`,
      isError: true,
    };
  }

  return {
    content:
      "Error: Perplexity rate limit exceeded after retries. Try again shortly.",
    isError: true,
  };
}

class WebSearchTool implements Tool {
  name = "web_search";
  description =
    "Search the web and return results. Useful for looking up current information, documentation, or anything the assistant doesn't know.";
  category = "network";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
              "Number of results to return (1-20, default 10). Only used with Brave provider.",
          },
          offset: {
            type: "number",
            description:
              "Pagination offset (0-9, default 0). Only used with Brave provider.",
          },
          freshness: {
            type: "string",
            description:
              'Filter by recency: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year). Only used with Brave provider.',
          },
        },
        required: ["query"],
      },
    };
  }

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

    let provider = getWebSearchProvider();
    let apiKey = getApiKey(provider);

    // Fallback: if the configured provider has no key, try the other provider
    if (!apiKey) {
      const fallback: WebSearchProvider =
        provider === "perplexity" ? "brave" : "perplexity";
      const fallbackKey = getApiKey(fallback);
      if (fallbackKey) {
        log.info(
          { from: provider, to: fallback },
          "Configured web search provider has no API key, falling back",
        );
        provider = fallback;
        apiKey = fallbackKey;
      } else {
        return {
          content:
            "Error: No web search API key configured. Set a PERPLEXITY_API_KEY or BRAVE_API_KEY environment variable, or configure it from the Settings page under API Keys.",
          isError: true,
        };
      }
    }

    try {
      log.debug({ query, provider }, "Executing web search");

      if (provider === "brave") {
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
        return await executeBraveSearch(
          query,
          count,
          offset,
          freshness,
          apiKey,
          context.signal,
        );
      }

      return await executePerplexitySearch(query, apiKey, context.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Web search failed");
      return { content: `Error: Web search failed: ${msg}`, isError: true };
    }
  }
}

export const webSearchTool = new WebSearchTool();
registerTool(webSearchTool);
