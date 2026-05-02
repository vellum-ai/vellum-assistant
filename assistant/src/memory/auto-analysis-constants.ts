/**
 * Constants extracted from auto-analysis-guard.ts to break the
 * conversation-crud ↔ auto-analysis-guard cycle.
 */

/**
 * Sentinel value for the `source` column of auto-analysis conversations.
 * Used both when creating them and when querying "all except auto-analysis."
 */
export const AUTO_ANALYSIS_SOURCE = "auto-analysis";

/**
 * Dedicated `group_id` value for auto-analysis rolling conversations.
 * Placed in the `system:background` group alongside heartbeat and filing
 * conversations, rendered as a "Reflections" sub-group in the sidebar.
 */
export const AUTO_ANALYSIS_GROUP_ID = "system:background";
