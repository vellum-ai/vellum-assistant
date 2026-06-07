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
 * something the generic loop should carry.
 */

import {
  applyRuntimeInjections,
  type InboundActorContext,
  type InjectionMode,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import {
  resolveTrustClass,
  type TrustContext,
} from "../../../../daemon/trust-context.js";
import { stripHistoricalWebSearchResults } from "../../../../daemon/web-search-history.js";
import { getLiveGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { Message } from "../../../../providers/types.js";
import { getLogger } from "../../../../util/logger.js";

const log = getLogger("post-compact-reinject");

/**
 * Everything the post-compaction hook needs, supplied by the agent loop from
 * its own working state. Re-injection inputs migrate loop-ward by growing this
 * type; the loop hands the hook an object of this shape when it calls
 * {@link postCompactReinject} directly.
 *
 * The turn-identity fields are flat here: `conversationId` is the key the
 * re-injection resolves the live conversation through (and the only one that,
 * together with `requestId` and `trust`, cannot be recovered from that live
 * conversation), while `turnIndex` and `callSite` are intentionally omitted so
 * {@link applyRuntimeInjections} self-resolves them from the live conversation.
 * The memory graph handle is likewise sourced internally via
 * {@link getLiveGraphMemory} rather than threaded in.
 */
export interface PostCompactionHookInput {
  /** Compacted message history to re-inject onto. */
  history: Message[];
  /**
   * Stable ID for the current request, forwarded onto the injector turn
   * context. The one turn-identity field that cannot be recovered from the
   * live conversation, so the loop supplies it.
   */
  requestId: string | undefined;
  /**
   * Conversation the turn is scoped to. The key the re-injection resolves the
   * live conversation (and its channel/trust/transcript state) through, so the
   * loop always supplies it.
   */
  conversationId: string;
  /**
   * Trust classification and channel identity for the inbound actor, forwarded
   * onto the injector turn context and used to gate the memory-graph re-track.
   * Supplied by the loop as the turn-start snapshot rather than re-resolved
   * mid-turn.
   */
  trust: TrustContext;
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
  /**
   * The `model_profile:` turn-context label, or `null` when the active
   * inference profile is unchanged since the last notified one. The agent loop
   * resolves it once at turn start from config and the turn's profile override,
   * and notifies the model only on change — a decision that flips mid-turn once
   * the notification is persisted, so it cannot be re-derived. Handed to the
   * hook here so re-injection re-emits the loop's turn-start value.
   */
  modelProfile: string | null;
  /**
   * Inbound actor identity and trust fields for the unified `<turn_context>`
   * block, or `null` on guardian turns (which suppress the actor section). The
   * agent loop resolves it once at turn start via the actor-trust resolver,
   * whose contact/member registry inputs can be mutated mid-turn by contact
   * tools, so it cannot be re-derived. Handed to the hook here so re-injection
   * re-emits the loop's turn-start value.
   */
  actorContext: InboundActorContext | null;
}

export default async function postCompactReinject(
  ctx: PostCompactionHookInput,
): Promise<RuntimeInjectionResult> {
  const { history, requestId, conversationId, trust, ...options } = ctx;
  // The remaining `options` carry the non-identity injection inputs
  // (`isNonInteractive`, `mode`, `modelProfile`, `actorContext`). Forward the
  // turn-identity fields the live conversation can't supply (`requestId`,
  // `conversationId`, `trust`); `turnIndex` and `callSite` self-resolve from
  // the live conversation so the re-injection matches the turn's initial
  // assembly.
  const result = await applyRuntimeInjections(history, {
    ...options,
    requestId,
    conversationId,
    trust,
  });
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors and minimal-mode turns never
  // received a memory-graph injection, so there is nothing to re-track. The
  // actor's trust class is derived from the turn's own trust context (the same
  // value the injector chain resolves). The live graph handle is looked up
  // from the plugin's own registry by the turn's conversation id — the same
  // instance the turn's retrieval mutated, so re-tracking sees the real
  // cached-node state.
  const isTrustedActor = resolveTrustClass(trust) === "guardian";
  if (isTrustedActor && options.mode !== "minimal") {
    getLiveGraphMemory(conversationId)?.retrackCachedNodes();
  }
  const strip = stripHistoricalWebSearchResults(result.messages);
  if (strip.stats.blocksStripped > 0) {
    log.info(
      {
        phase: "mid-loop-compact",
        conversationId,
        ...strip.stats,
      },
      "Converted historical web_search_tool_result blocks to text summaries",
    );
  }
  return { ...result, messages: strip.messages };
}
