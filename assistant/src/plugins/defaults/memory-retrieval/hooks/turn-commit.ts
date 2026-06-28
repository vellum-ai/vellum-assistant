/**
 * Default `memoryRetrieval` turn-commit hook.
 *
 * Fires once per turn after the turn's user + assistant messages are persisted,
 * and drives the active memory system's post-turn work through
 * {@link MemoryProvider.onTurnCommit}: the graph/v2 providers enqueue a
 * `lifecycle`-trigger retrospective for the conversation that just committed,
 * while v3 is a no-op (its writes ride the injector's commit callback).
 *
 * Two gates guard the delegation, preserving the semantics of the conversation
 * disposal safety-net this replaces:
 *
 * - **Trust** — only conversations whose turn-start actor can access memory
 *   ({@link resolveCapabilities}.canAccessMemory) drive consolidation, so an
 *   untrusted actor's turn never seeds a guardian-trust background loop. Trust
 *   is read from the conversation's turn-start snapshot rather than live state,
 *   mirroring the post-compaction hook.
 * - **Auto-analysis recursion** — auto-analysis conversations write memory
 *   directly via tools, so a retrospective over their reflective musings would
 *   double-write; they are skipped here, mirroring the indexer-time gate.
 *
 * The hook is observational and fire-and-forget — the turn is already
 * committed, so mutating the context has no effect and a throw is contained by
 * the loop.
 */

import type { HookFunction, TurnCommitContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { findConversationOrSubagent } from "../../../../daemon/conversation-registry.js";
import { FALLBACK_TURN_TRUST } from "../../../../daemon/trust-context.js";
import { isAutoAnalysisConversation } from "../../../../memory/auto-analysis-guard.js";
import { resolveMemoryProvider } from "../../../../memory/provider/resolve.js";
import type { MemoryProviderContext } from "../../../../memory/provider/types.js";
import { resolveCapabilities } from "../../../../runtime/capabilities.js";

const turnCommitMemoryConsolidation: HookFunction<TurnCommitContext> = async (
  ctx,
) => {
  const { conversationId } = ctx;
  const config = getConfig();
  const conversation = findConversationOrSubagent(conversationId);

  // Trust gate: only conversations whose actor can access memory drive
  // consolidation. Read the turn-start snapshot rather than live state, since
  // a concurrent request can overwrite the live trust context.
  const trust =
    conversation?.currentTurnTrustContext ??
    conversation?.trustContext ??
    FALLBACK_TURN_TRUST;
  if (!resolveCapabilities(trust.trustClass).canAccessMemory) {
    return;
  }

  // Recursion guard: auto-analysis conversations write memory directly via
  // tools, so a retrospective over their writes would double-write. Fail open
  // (don't skip) when the lookup throws so consolidation still runs.
  let isAutoAnalysis = false;
  try {
    isAutoAnalysis = isAutoAnalysisConversation(conversationId);
  } catch {
    // Best-effort — fall through to enqueue.
  }
  if (isAutoAnalysis) {
    return;
  }

  const providerCtx: MemoryProviderContext = {
    conversationId,
    requestId: ctx.userMessageId,
    messages: [...ctx.messages],
    config: config.memory,
    turnIndex: ctx.turnCount,
    trust,
  };
  await resolveMemoryProvider(config).onTurnCommit(providerCtx);
};

export default turnCommitMemoryConsolidation;
