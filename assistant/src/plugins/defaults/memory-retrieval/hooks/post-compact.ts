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
  type InjectionMode,
  type RuntimeInjectionOptions,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import { resolveTrustClass } from "../../../../daemon/trust-context.js";
import { stripHistoricalWebSearchResults } from "../../../../daemon/web-search-history.js";
import { getLiveGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { Message } from "../../../../providers/types.js";
import { getLogger } from "../../../../util/logger.js";
import type { TurnContext } from "../../../types.js";

const log = getLogger("post-compact-reinject");

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
  /**
   * Whether the in-flight turn has no human present to answer clarification
   * questions. Resolved once by the agent loop at turn start (from its
   * `isInteractive` option, which can fall back to mutable client/headless
   * state that flips mid-turn on SSE reconnect) and handed to the hook here, so
   * re-injection uses the loop's turn-start snapshot rather than re-reading
   * live conversation state.
   */
  isNonInteractive: boolean;
  /**
   * Injection volume for the re-applied blocks. Owned by the agent loop, which
   * drops to `"minimal"` when overflow reduction trims the prompt; handed to
   * the hook here so re-injection matches the loop's committed decision instead
   * of re-deriving it.
   */
  mode: InjectionMode;
}

/**
 * Everything the hook needs in a single context: the loop-supplied
 * {@link PostCompactionHookInput}, the resolved {@link RuntimeInjectionOptions}
 * (spread top-level so each field stays individually addressable). The memory
 * graph handle is not part of this context — the hook sources it internally via
 * {@link getLiveGraphMemory} — and the actor's trust class is derived from
 * {@link PostCompactionHookInput.turnContext} rather than threaded in.
 */
export interface PostCompactContext
  extends RuntimeInjectionOptions, PostCompactionHookInput {
  /**
   * Re-declared to reconcile the optional {@link RuntimeInjectionOptions} field
   * with the required {@link PostCompactionHookInput} one: the hook always
   * receives this from the loop, and it flows into {@link applyRuntimeInjections}
   * via the spread options.
   */
  isNonInteractive: boolean;
  /**
   * Re-declared for the same reason as {@link isNonInteractive}: required on
   * {@link PostCompactionHookInput} but optional on {@link RuntimeInjectionOptions}.
   */
  mode: InjectionMode;
}

export default async function postCompactReinject(
  ctx: PostCompactContext,
): Promise<RuntimeInjectionResult> {
  const { history, ...options } = ctx;
  const result = await applyRuntimeInjections(history, options);
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors and minimal-mode turns never
  // received a memory-graph injection, so there is nothing to re-track. The
  // actor's trust class is derived from the turn's own trust context (the same
  // value the injector chain resolves), not threaded in from the loop. The
  // live graph handle is looked up from the plugin's own registry by the
  // turn's conversation id — the same instance the turn's retrieval mutated,
  // so re-tracking sees the real cached-node state.
  const isTrustedActor =
    resolveTrustClass(options.turnContext?.trust) === "guardian";
  if (isTrustedActor && options.mode !== "minimal") {
    getLiveGraphMemory(
      options.turnContext?.conversationId,
    )?.retrackCachedNodes();
  }
  const strip = stripHistoricalWebSearchResults(result.messages);
  if (strip.stats.blocksStripped > 0) {
    log.info(
      {
        phase: "mid-loop-compact",
        conversationId: options.turnContext?.conversationId,
        ...strip.stats,
      },
      "Converted historical web_search_tool_result blocks to text summaries",
    );
  }
  return { ...result, messages: strip.messages };
}
