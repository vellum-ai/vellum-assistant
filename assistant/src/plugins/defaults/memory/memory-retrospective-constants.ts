/**
 * Sentinel value for the `source` column of memory-retrospective background
 * conversations. Used both when creating them and when filtering them out of
 * recursion / orphan-cleanup queries.
 */
export const MEMORY_RETROSPECTIVE_SOURCE = "memory-retrospective";

/**
 * Sentinel value for the `source` column of fork-based memory-retrospective
 * conversations. Distinct from MEMORY_RETROSPECTIVE_SOURCE so dedup can scope
 * its message scan to the post-fork tail — fork-kind rows carry the full
 * source prefix and would otherwise pollute prior-remember dedup with
 * source-inline `remember` calls.
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
 * background conversation (either kind). Shared predicate for recursion
 * guards.
 */
export function isMemoryRetrospectiveSource(source: string): boolean {
  return MEMORY_RETROSPECTIVE_SOURCES.includes(source);
}

/**
 * Dedicated `group_id` value for memory-retrospective background
 * conversations. Placed under `system:background` alongside heartbeat and
 * filing conversations.
 */
export const MEMORY_RETROSPECTIVE_GROUP_ID = "system:background";

/**
 * `metadata.kind` value stamped on the user-role instruction message that
 * fork-based retrospectives append to the forked conversation. Doubles as
 * the empty-prefix discriminator in fork-boundary detection: a stampless
 * fork-kind conversation whose first row carries this kind is run-authored
 * end-to-end (see `memory-retrospective-fork-boundary.ts`). Also lets
 * operators inspecting a fork's history tell the instruction apart from a
 * real user turn.
 */
export const MEMORY_RETROSPECTIVE_INSTRUCTION_KIND =
  "memory_retrospective_instruction";

/**
 * `metadata.kind` value stamped on the assistant-role message carrying the
 * `skill_card` ui_surface that the `skill_card_insert` delivery job appends
 * to a retrospective's SOURCE conversation after the run authors new skills.
 * Lets clients and operators identify the card row; the block itself is
 * provider-stripped so it never reaches the model as renderable content.
 */
export const SKILL_CARD_MESSAGE_KIND = "skill-authored-card";

/**
 * Request-origin tag the fork wake stamps onto `ToolContext.requestOrigin`
 * (via the wake's tool-context pin). The permission checker scopes its
 * non-interactive skill-authoring auto-grant to this origin, so a retrospective
 * pass can call `scaffold_managed_skill` / `find_similar_skills` /
 * `skill_load skill-management` without an interactive approval prompt. Matches
 * the `"memory_retrospective"` member of `TitleOrigin`.
 */
export const MEMORY_RETROSPECTIVE_ORIGIN = "memory_retrospective";

/**
 * Bundled skill that provides the retrospective's authoring tools
 * (`find_similar_skills`, `scaffold_managed_skill`, and the `skill_load`
 * target). Preactivated for the fork wake so those tools join the turn's active
 * set from turn 1, and matched by the permission checker's origin-scoped grant.
 */
export const SKILL_MANAGEMENT_SKILL_ID = "skill-management";
