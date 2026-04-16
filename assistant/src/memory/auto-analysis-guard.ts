import { getConversationSource } from "./conversation-crud.js";

/**
 * The `source` value used for conversations created by the auto-analysis
 * loop. Single source of truth — downstream code (enqueue helper,
 * service auto-branch) imports this constant rather than hardcoding the
 * string.
 */
export const AUTO_ANALYSIS_SOURCE = "auto-analysis";

/**
 * Dedicated `group_id` value for auto-analysis rolling conversations.
 * Placed in the `system:background` group alongside heartbeat and filing
 * conversations, rendered as a "Reflections" sub-group in the sidebar.
 */
export const AUTO_ANALYSIS_GROUP_ID = "system:background";

/**
 * Returns true if the conversation's `source` column is `"auto-analysis"`,
 * meaning it was produced by the auto-analysis loop. Callers use this to
 * skip both `graph_extract` and `conversation_analyze` enqueues so we
 * never (a) analyze our own analysis output or (b) extract memory from
 * reflective musings (the analysis agent writes memory directly via tools).
 */
export function isAutoAnalysisConversation(conversationId: string): boolean {
  return getConversationSource(conversationId) === AUTO_ANALYSIS_SOURCE;
}
