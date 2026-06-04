/**
 * Default `memoryRetrieval` post-compaction hook.
 *
 * After the agent loop compacts a conversation mid-turn it must re-apply the
 * runtime injections compaction stripped — the NOW.md scratchpad, PKB context,
 * memory-v2 static block, workspace top-level context, and Slack chronological
 * snapshot — onto the compacted history before the turn continues. This hook
 * is the memory system's home for that transform: it receives the message
 * history plus the resolved runtime-injection options and returns the edited
 * history (and the blocks it captured), with no dependency on the agent loop's
 * closure state.
 *
 * It re-applies the runtime injections via {@link applyRuntimeInjections},
 * re-tracks the memory graph's cached nodes against the re-injected history,
 * and converts now-historical `web_search_tool_result` blocks to text so their
 * expired `encrypted_content` tokens are not replayed. The remaining
 * orchestrator-side step (the post-injection bookkeeping the loop records) is
 * expected to migrate here as the hook subsumes the loop's re-injection
 * ceremony.
 */

import {
  applyRuntimeInjections,
  type RuntimeInjectionOptions,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import {
  stripHistoricalWebSearchResults,
  type StripStats,
} from "../../../../daemon/web-search-history.js";
import type { ConversationGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { Message } from "../../../../providers/types.js";

/**
 * Everything the hook needs in a single context: the resolved
 * {@link RuntimeInjectionOptions} (spread top-level so each field stays
 * individually addressable), the history to re-inject onto, and the
 * conversation-scoped state the options bag cannot carry (graph handle and
 * actor trust).
 */
export interface PostCompactContext extends RuntimeInjectionOptions {
  /** Compacted message history to re-inject onto. */
  history: Message[];
  /** Per-conversation memory graph handle. */
  graphMemory: ConversationGraphMemory;
  /** True when the actor for this turn is trusted (guardian-class). */
  isTrustedActor: boolean;
}

export interface PostCompactResult extends RuntimeInjectionResult {
  /** Stats from converting historical web-search results to text summaries. */
  webSearchStripStats: StripStats;
}

export default async function postCompactReinject(
  ctx: PostCompactContext,
): Promise<PostCompactResult> {
  const { history, graphMemory, isTrustedActor, ...options } = ctx;
  const result = await applyRuntimeInjections(history, options);
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors and minimal-mode turns never
  // received a memory-graph injection, so there is nothing to re-track.
  if (isTrustedActor && options.mode !== "minimal") {
    graphMemory.retrackCachedNodes();
  }
  const strip = stripHistoricalWebSearchResults(result.messages);
  return {
    ...result,
    messages: strip.messages,
    webSearchStripStats: strip.stats,
  };
}
