import type { Message, Provider, ToolDefinition } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("accurate-input-tokens");

/**
 * Ground-truth prompt-token count from the provider's own tokenizer
 * ({@link Provider.countInputTokens}), for the given system + tools + messages
 * composition. Falls back to `estimate()` (the local chars/4 heuristic) when
 * the provider has no token-counting endpoint or the count request fails, so
 * callers always get a number.
 *
 * Provider-coupled daemon logic — deliberately not part of the compaction
 * plugin's overridable surface. The count is a network round-trip with its own
 * rate limit, so callers reserve it for user-initiated, occasional actions
 * (forced `/compact`, `/clean`), never the per-turn auto-compaction gate.
 */
export async function accurateInputTokens(
  provider: Provider,
  messages: Message[],
  systemPrompt: string,
  tools: ToolDefinition[] | undefined,
  estimate: () => number,
): Promise<number> {
  const countInputTokens = provider.countInputTokens;
  if (!countInputTokens) return estimate();
  try {
    return await countInputTokens.call(provider, messages, systemPrompt, tools);
  } catch (err) {
    log.warn(
      { err },
      "Provider token count failed — falling back to local estimate",
    );
    return estimate();
  }
}
