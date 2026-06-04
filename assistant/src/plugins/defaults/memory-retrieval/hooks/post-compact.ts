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
 * It delegates to {@link applyRuntimeInjections} and re-tracks the memory
 * graph's cached nodes against the re-injected history. The remaining
 * orchestrator-side re-injection steps (historical web-search stripping and
 * the post-injection bookkeeping the loop records) are expected to migrate
 * here as the hook subsumes the loop's re-injection ceremony.
 */

import {
  applyRuntimeInjections,
  type RuntimeInjectionOptions,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import type { ConversationGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { Message } from "../../../../providers/types.js";

/**
 * External state the hook needs but the injection options cannot carry: the
 * conversation-scoped graph handle and the turn's actor trust. Passed
 * separately from the {@link RuntimeInjectionOptions} bag, mirroring
 * `runDefaultMemoryRetrieval`'s deps convention.
 */
export interface PostCompactReinjectDeps {
  /** Per-conversation memory graph handle. */
  readonly graphMemory: ConversationGraphMemory;
  /** True when the actor for this turn is trusted (guardian-class). */
  readonly isTrustedActor: boolean;
}

export default async function postCompactReinject(
  history: Message[],
  options: RuntimeInjectionOptions,
  deps: PostCompactReinjectDeps,
): Promise<RuntimeInjectionResult> {
  const result = await applyRuntimeInjections(history, options);
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors and minimal-mode turns never
  // received a memory-graph injection, so there is nothing to re-track.
  if (deps.isTrustedActor && options.mode !== "minimal") {
    deps.graphMemory.retrackCachedNodes();
  }
  return result;
}
