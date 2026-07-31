/**
 * Canonical `conversations.source` string for background memory v2
 * consolidation runs. Owned by the persistence layer (it is a persisted
 * column value) and re-exported here for the plugin's own call sites.
 */
export { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../../persistence/conversation-types.js";
