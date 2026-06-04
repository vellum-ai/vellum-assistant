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
 *
 * The memory graph handle is sourced internally from the plugin's own
 * conversation-keyed registry ({@link getLiveGraphMemory}) rather than being
 * threaded in by the loop — it is memory-retrieval-specific state, not
 * something the generic loop or the shared {@link TurnContext} should carry.
 */

import {
  applyRuntimeInjections,
  type RuntimeInjectionOptions,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import { stripHistoricalWebSearchResults } from "../../../../daemon/web-search-history.js";
import { getLiveGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { PluginLogger } from "../../../../plugin-api/types.js";
import type { Message } from "../../../../providers/types.js";
import type { TurnContext } from "../../../types.js";

/**
 * The slice of the hook's context the agent loop supplies from its own working
 * state. Re-injection inputs migrate loop-ward by growing this type; the loop
 * hands the hook an object of this shape via
 * {@link MidLoopCompaction.postCompactionHook}.
 */
export interface PostCompactionHookInput {
  /** Compacted message history to re-inject onto. */
  history: Message[];
  /** Per-turn conversation context forwarded to the injector chain. */
  turnContext?: TurnContext;
}

/**
 * Everything the hook needs in a single context: the loop-supplied
 * {@link PostCompactionHookInput}, the resolved {@link RuntimeInjectionOptions}
 * (spread top-level so each field stays individually addressable), and the
 * conversation-scoped state the options bag cannot carry (actor trust and a
 * turn-scoped logger). The memory graph handle is not part of this context —
 * the hook sources it internally via {@link getLiveGraphMemory}.
 */
export interface PostCompactContext
  extends RuntimeInjectionOptions, PostCompactionHookInput {
  /** True when the actor for this turn is trusted (guardian-class). */
  isTrustedActor: boolean;
  /** Turn-scoped logger for diagnostics emitted while re-injecting. */
  logger: PluginLogger;
}

export default async function postCompactReinject(
  ctx: PostCompactContext,
): Promise<RuntimeInjectionResult> {
  const { history, isTrustedActor, logger, ...options } = ctx;
  const result = await applyRuntimeInjections(history, options);
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors and minimal-mode turns never
  // received a memory-graph injection, so there is nothing to re-track. The
  // live graph handle is looked up from the plugin's own registry by the
  // turn's conversation id — the same instance the turn's retrieval mutated,
  // so re-tracking sees the real cached-node state.
  if (isTrustedActor && options.mode !== "minimal") {
    getLiveGraphMemory(
      options.turnContext?.conversationId,
    )?.retrackCachedNodes();
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
