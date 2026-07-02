/**
 * Default `memoryRetrieval` post-compaction hook.
 *
 * After the agent loop compacts a conversation mid-turn it must re-apply the
 * runtime injections — the NOW.md scratchpad, PKB context, memory-v2 static
 * block, workspace top-level context, Slack chronological snapshot, and the
 * per-turn context blocks — onto the continuation history before the turn
 * continues. This hook is the memory system's home for that transform: it
 * clears any per-turn injection blocks the base already carries on its tail
 * ({@link stripTailInjectionsForReinjection}) so re-injection is idempotent,
 * re-applies the injections via {@link applyRuntimeInjections}, writes the
 * edited history back onto the context, and re-tracks the memory graph's cached
 * nodes against the re-injected history. The injection blocks the transform
 * captures are not needed by the re-injection caller, so only the messages
 * propagate.
 *
 * The base the loop hands in is the full injected history (the loop does not
 * pre-strip it), so the tail strip is what keeps injection idempotency a
 * property of the injection machinery rather than of the agent loop.
 *
 * Every per-turn input the live conversation can supply is self-resolved from
 * it (looked up by id) rather than threaded in by the loop:
 * - The trust snapshot comes from the conversation's turn-start trust snapshot
 *   ({@link Conversation.currentTurnTrustContext}), and the inbound actor
 *   context from the turn-start actor snapshot
 *   ({@link Conversation.currentTurnInboundActorContext}) — both frozen at turn
 *   start, not read live. Post-compaction runs mid-turn in a later tool
 *   iteration, where the live trust can be overwritten by a concurrent
 *   request's actor and the contact/member registry the actor context derives
 *   from can be mutated by contact tools; reading the frozen snapshots re-emits
 *   the values the turn's initial assembly resolved.
 * - The memory graph handle comes from the plugin's own conversation-keyed
 *   registry ({@link getLiveGraphMemory}).
 * - The call site and transcript inputs self-resolve inside
 *   {@link applyRuntimeInjections}.
 *
 * The loop supplies only the irreducible turn-identity fields on the public
 * {@link PostCompactContext}.
 */

import type { HookFunction, PostCompactContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { findConversationOrSubagent } from "../../../../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  resolveTurnModelProfileLabel,
} from "../../../../daemon/conversation-runtime-assembly.js";
import {
  FALLBACK_TURN_TRUST,
  resolveTrustClass,
} from "../../../../daemon/trust-context.js";
import { getLiveGraphMemory } from "../graph/conversation-graph-memory.js";
import { stripTailInjectionsForReinjection } from "../tail-reinjection-strip.js";

const postCompact: HookFunction<PostCompactContext> = async (ctx) => {
  const {
    history,
    requestId,
    conversationId,
    isNonInteractive,
    injectionMode,
  } = ctx;
  const mode = injectionMode ?? "full";
  const config = getConfig();
  const conversation = findConversationOrSubagent(conversationId);
  // Trust and the inbound actor context are read from the conversation's
  // turn-start snapshots rather than live state: post-compaction runs mid-turn
  // in a later tool iteration, where the live trust can be overwritten by a
  // concurrent request's actor and the contact/member registry the actor
  // context derives from can be mutated by contact tools. The snapshots are the
  // values the turn's initial assembly resolved.
  const trust =
    conversation?.currentTurnTrustContext ??
    conversation?.trustContext ??
    FALLBACK_TURN_TRUST;
  const actorContext = conversation?.currentTurnInboundActorContext ?? null;
  // Render the `model_profile:` label from the turn-start notice key, using
  // the call site self-resolved from the live conversation — the same
  // derivation the first-call user-prompt-submit assembly uses.
  const modelProfile = resolveTurnModelProfileLabel(
    conversation?.currentTurnModelProfileNoticeKey ?? null,
    conversation?.currentCallSite ?? "mainAgent",
    config.llm,
    conversationId,
  );
  // Clear any per-turn injection blocks the base already carries on its tail
  // before re-injecting, so the continuation history holds a single copy of
  // each block rather than double-stacking on the injected base the loop hands
  // in.
  const strippedHistory = stripTailInjectionsForReinjection(history);
  const result = await applyRuntimeInjections(strippedHistory, {
    isNonInteractive,
    modelProfile,
    actorContext,
    mode,
    requestId,
    conversationId,
    trust,
  });
  // Write the re-injected history back onto the threaded context; the loop
  // reads it from there once the hook settles.
  ctx.history = result.messages;
  // Re-track the nodes the memory graph last injected so they survive against
  // the re-injected history. Untrusted actors never received a memory-graph
  // injection, so there is nothing to re-track. The live graph handle is looked
  // up from the plugin's own registry by the turn's conversation id — the same
  // instance the turn's retrieval mutated.
  const isTrustedActor = resolveTrustClass(trust) === "guardian";
  if (isTrustedActor) {
    getLiveGraphMemory(conversationId)?.retrackCachedNodes();
  }
};

export default postCompact;
