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
import { stripHistoricalWebSearchResults } from "../../../../daemon/web-search-history.js";
import type { ConversationGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { PluginLogger } from "../../../../plugin-api/types.js";
import type { Message } from "../../../../providers/types.js";

/**
 * The slice of the hook's context the agent loop supplies from its own working
 * state. Today that is just the post-compaction `history` to re-inject onto; as
 * further re-injection inputs migrate loop-ward they are added here, and the
 * loop hands the hook an object of this shape via
 * {@link MidLoopCompaction.postCompactionHook}.
 */
export interface PostCompactionHookInput {
  /** Compacted message history to re-inject onto. */
  history: Message[];
}

/**
 * Everything the hook needs in a single context: the loop-supplied
 * {@link PostCompactionHookInput}, the resolved {@link RuntimeInjectionOptions}
 * (spread top-level so each field stays individually addressable), and the
 * conversation-scoped state the options bag cannot carry (graph handle,
 * actor trust, and a turn-scoped logger).
 */
export interface PostCompactContext
  extends RuntimeInjectionOptions, PostCompactionHookInput {
  /** Per-conversation memory graph handle. */
  graphMemory: ConversationGraphMemory;
  /** True when the actor for this turn is trusted (guardian-class). */
  isTrustedActor: boolean;
  /** Turn-scoped logger for diagnostics emitted while re-injecting. */
  logger: PluginLogger;
}

export default async function postCompactReinject(
  ctx: PostCompactContext,
): Promise<RuntimeInjectionResult> {
  const { history, graphMemory, isTrustedActor, logger, ...options } = ctx;
  const result = await applyRuntimeInjections(history, options);
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors and minimal-mode turns never
  // received a memory-graph injection, so there is nothing to re-track.
  if (isTrustedActor && options.mode !== "minimal") {
    graphMemory.retrackCachedNodes();
  }
  const strip = stripHistoricalWebSearchResults(result.messages);
  if (strip.stats.blocksStripped > 0) {
    logger.info(
      { phase: "mid-loop-compact", ...strip.stats },
      "Converted historical web_search_tool_result blocks to text summaries",
    );
  }
  return { ...result, messages: strip.messages };
}
