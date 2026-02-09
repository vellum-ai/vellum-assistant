import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getConfig } from '../../config/loader.js';
import { getSecureKey } from '../../security/secure-keys.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('web-search');

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

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

function getApiKey(): string | undefined {
  // Environment variable takes priority
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;

  // Try secure storage
  const secureKey = getSecureKey('brave');
  if (secureKey) return secureKey;

  // Fall back to config apiKeys
  const config = getConfig();
  return config.apiKeys.brave;
}

function formatResults(results: BraveSearchResult[], query: string): string {
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
    lines.push('');
  }

  return lines.join('\n');
}

class WebSearchTool implements Tool {
  name = 'web_search';
  description = 'Search the web using Brave Search and return results. Useful for looking up current information, documentation, or anything the assistant doesn\'t know.';
  category = 'network';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query string',
          },
          count: {
            type: 'number',
            description: 'Number of results to return (1-20, default 10)',
          },
          offset: {
            type: 'number',
            description: 'Pagination offset (0-9, default 0)',
          },
          freshness: {
            type: 'string',
            description: 'Filter by recency: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year)',
          },
        },
        required: ['query'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const query = input.query;
    if (!query || typeof query !== 'string') {
      return { content: 'Error: query is required and must be a string', isError: true };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return {
        content: 'Error: Brave Search API key not configured. Set BRAVE_API_KEY environment variable or run: vellum config set apiKeys.brave <your-key>',
        isError: true,
      };
    }

    const count = typeof input.count === 'number' ? Math.min(20, Math.max(1, Math.round(input.count))) : 10;
    const offset = typeof input.offset === 'number' ? Math.min(9, Math.max(0, Math.round(input.offset))) : 0;

    const params = new URLSearchParams({
      q: query,
      count: String(count),
      offset: String(offset),
    });

    const validFreshness = ['pd', 'pw', 'pm', 'py'];
    if (typeof input.freshness === 'string' && validFreshness.includes(input.freshness)) {
      params.set('freshness', input.freshness);
    }

    const url = `${BRAVE_API_URL}?${params.toString()}`;

    try {
      log.debug({ query, count, offset }, 'Executing web search');

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        log.warn({ status: response.status, body }, 'Brave Search API error');

        if (response.status === 401 || response.status === 403) {
          return { content: 'Error: Invalid or expired Brave Search API key', isError: true };
        }
        if (response.status === 429) {
          return { content: 'Error: Brave Search rate limit exceeded. Try again shortly.', isError: true };
        }
        return { content: `Error: Brave Search API returned status ${response.status}`, isError: true };
      }

      const data = await response.json() as BraveSearchResponse;
      const results = data.web?.results ?? [];

      return {
        content: formatResults(results, query),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Web search failed');
      return { content: `Error: Web search failed: ${msg}`, isError: true };
    }
  }
}

registerTool(new WebSearchTool());
