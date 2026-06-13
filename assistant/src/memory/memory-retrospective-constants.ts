/**
 * Sentinel value for the `source` column of memory-retrospective background
 * conversations. Used both when creating them and when filtering them out of
 * recursion / orphan-cleanup queries.
 */
export const MEMORY_RETROSPECTIVE_SOURCE = "memory-retrospective";

/**
 * Sentinel value for the `source` column of fork-based memory-retrospective
 * conversations (the new `memory-retrospective-fork` flag path). Distinct
 * from MEMORY_RETROSPECTIVE_SOURCE so dedup can scope its message scan to the
 * post-fork tail — fork-kind rows carry the full source prefix and would
 * otherwise pollute prior-remember dedup with source-inline `remember` calls.
 */
export const MEMORY_RETROSPECTIVE_FORK_SOURCE = "memory-retrospective-fork";

/**
 * Union of both retrospective source sentinels. Use when looking up the most
 * recent retrospective for a source conversation (either kind is valid) or
 * when filtering retrospective bg conversations out of recursion queries.
 */
export const MEMORY_RETROSPECTIVE_SOURCES: readonly string[] = [
  MEMORY_RETROSPECTIVE_SOURCE,
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
];

/**
 * Whether a conversation `source` value marks a memory-retrospective
 * background conversation (either kind). Shared predicate for the recursion
 * and auto-analysis guards.
 */
export function isMemoryRetrospectiveSource(source: string): boolean {
  return MEMORY_RETROSPECTIVE_SOURCES.includes(source);
}

/**
 * Dedicated `group_id` value for memory-retrospective background
 * conversations. Placed under `system:background` alongside auto-analysis,
 * heartbeat, and filing conversations.
 */
export const MEMORY_RETROSPECTIVE_GROUP_ID = "system:background";

/**
 * `metadata.kind` value stamped on the user-role instruction message that
 * fork-based retrospectives append to the forked conversation. Used purely
 * for observability — operators inspecting a retrospective fork's history
 * can tell the user-role message apart from a real user turn.
 */
export const MEMORY_RETROSPECTIVE_INSTRUCTION_KIND =
  "memory_retrospective_instruction";
