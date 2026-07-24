import { countRealUserTurns } from "../persistence/llm-usage-store.js";
import {
  buildUsageOriginSnapshot,
  resolveSpawnParentConversationId,
  type UsageOriginSnapshot,
} from "./work-origin.js";

/**
 * The conversation-level fields a per-turn {@link UsageOriginSnapshot} is
 * assembled from. A structural subset of `Conversation` so both the normal
 * agent-loop wrapper (`runAgentLoopImpl`) and the background wake path
 * (`wakeAgentForOpportunity`) can build the snapshot from their live
 * conversation without depending on the class.
 */
export interface ConversationUsageOriginContext {
  conversationId: string;
  conversationType?: string | null;
  source?: string | null;
  parentConversationId?: string | null;
  forkParentConversationId?: string | null;
}

/**
 * Assemble the immutable per-turn {@link UsageOriginSnapshot} for a live
 * conversation turn — the single assembly point shared by every path that
 * records LLM usage (`runAgentLoopImpl` for user/subagent turns,
 * `wakeAgentForOpportunity` for scheduled / retrospective / background wakes).
 *
 * Both turn indexes are derived from the SAME real-user-turn population the
 * `llm_usage` telemetry read path counts (via {@link countRealUserTurns}), so
 * the managed billing-origin headers and usage telemetry agree:
 *
 * - `turnIndex` counts this conversation's own real user turns (evaluated once
 *   the turn's user message(s) are persisted).
 * - `parentTurnIndex` counts the SPAWNING conversation's real user turns — a
 *   best-effort live approximation of the telemetry read path's parent-turn
 *   cutoff — and is null when this conversation was not spawned by another. It
 *   mirrors the telemetry `parentTurnIndex`, which is a count (never null) when
 *   a spawn parent exists and null otherwise.
 *
 * Both `countRealUserTurns` calls are best-effort (a query failure degrades to
 * 0 rather than aborting the turn). The subagent/background-fork lineage
 * precedence lives in {@link resolveSpawnParentConversationId}, shared with
 * {@link buildUsageOriginSnapshot} and the telemetry classifier.
 */
export function buildTurnUsageOriginSnapshot(
  conversation: ConversationUsageOriginContext,
  callSite: string | null,
): UsageOriginSnapshot {
  const parentConversationId = conversation.parentConversationId ?? null;
  const forkParentConversationId =
    conversation.forkParentConversationId ?? null;
  const conversationType = conversation.conversationType ?? null;
  const spawnParentConversationId = resolveSpawnParentConversationId({
    parentConversationId,
    conversationType,
    forkParentConversationId,
  });
  return buildUsageOriginSnapshot({
    conversationType,
    conversationSource: conversation.source ?? null,
    callSite,
    conversationId: conversation.conversationId,
    turnIndex: countRealUserTurns(conversation.conversationId),
    parentConversationId,
    forkParentConversationId,
    parentTurnIndex:
      spawnParentConversationId !== null
        ? countRealUserTurns(spawnParentConversationId)
        : null,
  });
}
