import {
  countRealUserTurns,
  resolveParentTurnCutoff,
} from "../persistence/llm-usage-store.js";
import {
  buildUsageOriginSnapshot,
  resolveSpawnParentConversationId,
  type UsageOriginSnapshot,
} from "./work-origin.js";

/**
 * The conversation-level fields a per-turn {@link UsageOriginSnapshot} is
 * assembled from. A structural subset of `Conversation`, so both the normal
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
 * conversation turn. This is the single assembly point shared by every path
 * that drives the agent loop: `runAgentLoopImpl` for user and subagent turns,
 * `wakeAgentForOpportunity` for scheduled, retrospective, and background wakes.
 *
 * Both turn indexes count the same real-user-turn population the `llm_usage`
 * telemetry read path counts, via {@link countRealUserTurns}, so the managed
 * billing-origin headers and usage telemetry agree:
 *
 * - `turnIndex` counts this conversation's own real user turns, evaluated once
 *   the turn's user message or messages are persisted.
 * - `parentTurnIndex` counts the spawning conversation's real user turns up to
 *   the spawn cutoff ({@link resolveParentTurnCutoff}: child creation for a
 *   subagent spawn, the fork boundary message for a background fork), and is
 *   null when this conversation was not spawned by another. Counting to the
 *   cutoff rather than to date is what keeps a retrospective fork, whose source
 *   conversation can gain turns between the boundary and the fork's wake,
 *   pointing at the turn it branched from. The spawn parent comes from
 *   {@link resolveSpawnParentConversationId}, which mirrors the telemetry read
 *   path's `parentIdSql` precedence.
 *
 * Everything here is best-effort. Attribution must never fail or block a
 * provider call, so a failed turn count degrades to 0 and an unresolvable
 * lineage field degrades to null.
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
        ? countRealUserTurns(
            spawnParentConversationId,
            resolveParentTurnCutoff(conversation.conversationId),
          )
        : null,
  });
}
