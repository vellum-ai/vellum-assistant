import { AUTO_ANALYSIS_SOURCE } from "../../persistence/auto-analysis-constants.js";
import { getConversationSource } from "../../persistence/conversation-crud.js";

/**
 * Returns true if the conversation's `source` column is `"auto-analysis"`.
 * The retired auto-analysis feature produced such conversations; rows
 * persist on existing installs. Callers skip memory/graph extraction for
 * them — the analysis agent wrote memory directly via tools, so extracting
 * from its reflective musings would double-count.
 */
export function isAutoAnalysisConversation(conversationId: string): boolean {
  return getConversationSource(conversationId) === AUTO_ANALYSIS_SOURCE;
}
