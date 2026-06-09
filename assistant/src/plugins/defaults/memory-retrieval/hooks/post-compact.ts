/**
 * Default `memoryRetrieval` post-compaction hook.
 *
 * After the agent loop compacts a conversation mid-turn it must re-apply the
 * runtime injections compaction stripped — the NOW.md scratchpad, PKB context,
 * memory-v2 static block, workspace top-level context, and Slack chronological
 * snapshot — onto the compacted history before the turn continues. This hook
 * is the memory system's home for that transform: it receives the message
 * history plus the resolved runtime-injection options on a single context,
 * writes the edited history back onto that context, and has no dependency on
 * the agent loop's closure state. The injection blocks the transform captures
 * are not needed by the re-injection caller, so only the messages propagate.
 *
 * It re-applies the runtime injections via {@link applyRuntimeInjections} and
 * re-tracks the memory graph's cached nodes against the re-injected history.
 * The remaining orchestrator-side step (the post-injection bookkeeping the
 * loop records) is expected to migrate here as the hook subsumes the loop's
 * re-injection ceremony.
 *
 * The memory graph handle is sourced internally from the plugin's own
 * conversation-keyed registry ({@link getLiveGraphMemory}) rather than being
 * threaded in by the loop — it is memory-retrieval-specific state, not
 * something the generic loop should carry.
 */

import type { PluginHookFn } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { findConversationOrSubagent } from "../../../../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  type InboundActorContext,
  resolveTurnModelProfileLabel,
} from "../../../../daemon/conversation-runtime-assembly.js";
import {
  resolveTrustClass,
  type TrustContext,
} from "../../../../daemon/trust-context.js";
import { getLiveGraphMemory } from "../../../../memory/graph/conversation-graph-memory.js";
import type { Message } from "../../../../providers/types.js";

/**
 * Everything the post-compaction hook needs, supplied by the agent loop from
 * its own working state. The loop seeds a context of this shape and threads it
 * through the `post-compact` hook chain, reading the re-injected history back
 * off it once the chain settles.
 *
 * The turn-identity fields are flat here: `conversationId` is the key the
 * re-injection resolves the live conversation through (and the only one that,
 * together with `requestId` and `trust`, cannot be recovered from that live
 * conversation), while `turnIndex` and `callSite` are intentionally omitted so
 * {@link applyRuntimeInjections} self-resolves them from the live conversation.
 * The memory graph handle is likewise sourced internally via
 * {@link getLiveGraphMemory} rather than threaded in.
 */
export interface PostCompactContext {
  /**
   * Compacted message history to re-inject onto. The hook writes the
   * re-injected result back onto this field once the transform settles, and
   * the loop reads it from there.
   */
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
   * The turn's resolved inference-profile key, or `null` when the active
   * profile is unchanged since the last notified one. The agent loop resolves
   * it once at turn start (notifying the model only on change — a decision that
   * flips mid-turn once the notification is persisted, so it cannot be
   * re-derived) and hands it here; the hook renders the `model_profile:` label
   * from it via {@link resolveTurnModelProfileLabel}, using the call site
   * self-resolved from the live conversation.
   */
  modelProfileKey: string | null;
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

const postCompact: PluginHookFn<PostCompactContext> = async (ctx) => {
  const {
    history,
    requestId,
    conversationId,
    trust,
    isNonInteractive,
    modelProfileKey,
    actorContext,
  } = ctx;
  // Render the `model_profile:` label from the turn's resolved profile key,
  // using the call site self-resolved from the live conversation — the same
  // derivation the first-call user-prompt-submit assembly uses. Mid-loop
  // re-injection always runs at `"full"` volume; only the orchestrator's
  // post-rejection convergence re-injection ever downgrades the mode. The
  // turn-identity fields the live conversation can't supply (`requestId`,
  // `conversationId`, `trust`) are forwarded; `turnIndex` and `callSite`
  // self-resolve from the live conversation so the re-injection matches the
  // turn's initial assembly.
  const config = getConfig();
  const conversation = findConversationOrSubagent(conversationId);
  const modelProfile = resolveTurnModelProfileLabel(
    modelProfileKey,
    conversation?.currentCallSite ?? "mainAgent",
    config.llm,
    conversationId,
  );
  const result = await applyRuntimeInjections(history, {
    isNonInteractive,
    modelProfile,
    actorContext,
    mode: "full",
    requestId,
    conversationId,
    trust,
  });
  // Write the re-injected history back onto the threaded context; the loop
  // reads it from there once the hook settles.
  ctx.history = result.messages;
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors never received a memory-graph
  // injection, so there is nothing to re-track. The actor's trust class is
  // derived from the turn's own trust context (the same value the injector
  // chain resolves). The live graph handle is looked up from the plugin's own
  // registry by the turn's conversation id — the same instance the turn's
  // retrieval mutated, so re-tracking sees the real cached-node state.
  const isTrustedActor = resolveTrustClass(trust) === "guardian";
  if (isTrustedActor) {
    getLiveGraphMemory(conversationId)?.retrackCachedNodes();
  }
};

export default postCompact;
