import { getConversationSource } from "./conversation-crud.js";

/**
 * The `source` value used for conversations created by the auto-analysis
 * loop. Single source of truth — downstream code (enqueue helper,
 * service auto-branch) imports this constant rather than hardcoding the
 * string.
 */
export const AUTO_ANALYSIS_SOURCE = "auto-analysis";

/**
 * Dedicated `group_id` value for auto-analysis rolling conversations. They
 * are an internal continuity surface and must not appear in the default
 * `system:all` group that non-macOS clients (CLI, gateway, web) render
 * without filtering on `source`.
 */
export const AUTO_ANALYSIS_GROUP_ID = "system:reflections";

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
