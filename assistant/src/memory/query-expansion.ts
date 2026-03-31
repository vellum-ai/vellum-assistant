/**
 * HyDE (Hypothetical Document Embeddings) query expansion for memory retrieval.
 *
 * Generates hypothetical memory documents that bridge the semantic gap between
 * how users query ("moments that changed everything") and how memories are
 * actually stored ("User mentioned their favorite restaurant on March 24"). The expanded
 * queries are embedded alongside the original query to improve recall.
 */

import type { AssistantConfig } from "../config/types.js";
import {
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("memory-query-expansion");

const SYSTEM_PROMPT = `Generate 3 short hypothetical memory entries that would match this search query. Each should describe what a stored memory about this topic would contain — specific details, emotional context, relationship dynamics. Write from the perspective of stored memory items, not the query itself. Keep each under 80 words. Separate entries with ---`;

/**
 * Generate hypothetical memory documents for a query using HyDE.
 *
 * Returns 1-3 hypothetical document strings that can be embedded alongside
 * the original query to improve semantic recall. Returns `[]` on any error
 * (provider unavailable, LLM failure, empty response) — the caller should
 * fall back to the raw query only.
 *
 * The raw query is NOT included in the returned array; the caller handles
 * that separately.
 */
export async function expandQueryWithHyDE(
  query: string,
  _config: AssistantConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const provider = await getConfiguredProvider();
    if (!provider) {
      log.warn("No provider available for HyDE query expansion");
      return [];
    }

    const response = await provider.sendMessage(
      [userMessage(query)],
      undefined,
      SYSTEM_PROMPT,
      {
        config: {
          modelIntent: "latency-optimized" as const,
        },
        signal,
      },
    );

    const text = extractText(response);
    if (!text) {
      log.warn("Empty response from HyDE query expansion");
      return [];
    }

    const entries = text
      .split("---")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 3);

    if (entries.length === 0) {
      log.warn("No entries parsed from HyDE query expansion response");
      return [];
    }

    return entries;
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) throw err;
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "HyDE query expansion failed",
    );
    return [];
  }
}
