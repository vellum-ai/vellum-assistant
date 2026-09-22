/**
 * The slug grammar of the synthetic capability rows (skills and `assistant`
 * CLI commands) in the unified concept-page collection: the prefixes their
 * slugs carry, the builders, and the predicates. Concept-page slugs must
 * match `[a-z0-9][a-z0-9-]*(/...)*`, and `skills` / `cli-commands` match that
 * pattern, so the prefixes coexist with hand-authored concept pages without
 * escape work.
 *
 * A dependency-free leaf, so a read path that only needs to name a capability
 * row (the truncated-fork seed of the injected-section record) can import it
 * without loading the skill and CLI-command stores.
 */

/** Slug prefix under which skill embeddings are indexed. */
export const SKILL_SLUG_PREFIX = "skills/";

/** Slug prefix under which CLI-command embeddings are indexed. */
export const CLI_COMMAND_SLUG_PREFIX = "cli-commands/";

/** Compose the unified-collection slug for a skill id. */
export function skillSlugFor(id: string): string {
  return `${SKILL_SLUG_PREFIX}${id}`;
}

/** Compose the unified-collection slug for a CLI command name. */
export function cliCommandSlugFor(name: string): string {
  return `${CLI_COMMAND_SLUG_PREFIX}${name}`;
}

/** True iff the slug refers to a skill entry in the unified collection. */
export function isSkillSlug(slug: string): boolean {
  return slug.startsWith(SKILL_SLUG_PREFIX);
}

/** True iff the slug refers to a CLI-command entry in the unified collection. */
export function isCliCommandSlug(slug: string): boolean {
  return slug.startsWith(CLI_COMMAND_SLUG_PREFIX);
}

/**
 * The synthetic row slug a persisted capability chunk names: the id under
 * its `# Skill: ` / `# CLI command: ` header (as the injected-block parser
 * reads it), mapped back through the slug builders. The inverse of the
 * header the capability render forms write.
 */
export function capabilitySlugOf(chunk: {
  capability: "skill" | "cli-command";
  id: string;
}): string {
  return chunk.capability === "skill"
    ? skillSlugFor(chunk.id)
    : cliCommandSlugFor(chunk.id);
}
