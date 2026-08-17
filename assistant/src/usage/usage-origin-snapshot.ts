import {
  countRealUserTurns,
  resolveSpawnAttribution,
} from "../persistence/llm-usage-store.js";
import {
  buildUsageOriginSnapshot,
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
 *   the spawn cutoff (child creation for a subagent spawn, the fork boundary
 *   message for a background fork), and is null when this conversation was not
 *   spawned by another. Counting to the cutoff rather than to date is what keeps
 *   a retrospective fork, whose source conversation can gain turns between the
 *   boundary and the fork's wake, pointing at the turn it branched from.
 *
 * The spawn parent and that cutoff both come from
 * {@link resolveSpawnAttribution}, the one expression the telemetry read path
 * also reads, so the two surfaces name the same parent and the same parent turn.
 * The lineage is read from the conversation row rather than from the live
 * object: the row is written at creation (`bootstrapConversation`), before any
 * turn of the conversation runs, so it holds the same lineage a live turn knows.
 *
 * `cronRunId` is the schedule firing driving this turn, or null. A wake or defer
 * schedule can fire inside a conversation whose type and source stay
 * `standard`/`user`, where it is the only signal the spend is schedule-driven.
 *
 * Everything here is best-effort. Attribution must never fail or block a
 * provider call, so a failed turn count degrades to 0 and an unresolvable
 * lineage field degrades to null.
 */
export function buildTurnUsageOriginSnapshot(
  conversation: ConversationUsageOriginContext,
  callSite: string | null,
  cronRunId: string | null,
): UsageOriginSnapshot {
  const { spawnParentConversationId, cutoffCreatedAt } =
    resolveSpawnAttribution(conversation.conversationId);
  return buildUsageOriginSnapshot({
    conversationType: conversation.conversationType ?? null,
    conversationSource: conversation.source ?? null,
    callSite,
    conversationId: conversation.conversationId,
    turnIndex: countRealUserTurns(conversation.conversationId),
    parentConversationId: spawnParentConversationId,
    parentTurnIndex:
      spawnParentConversationId !== null
        ? countRealUserTurns(spawnParentConversationId, cutoffCreatedAt)
        : null,
    cronRunId,
  });
}
