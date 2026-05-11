/**
 * Sentinel value for the `source` column of memory-retrospective background
 * conversations. Used both when creating them and when filtering them out of
 * recursion / orphan-cleanup queries.
 */
export const MEMORY_RETROSPECTIVE_SOURCE = "memory-retrospective";

/**
 * Dedicated `group_id` value for memory-retrospective background
 * conversations. Placed under `system:background` alongside auto-analysis,
 * heartbeat, and filing conversations.
 */
export const MEMORY_RETROSPECTIVE_GROUP_ID = "system:background";
