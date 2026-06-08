/**
 * Memory v3 — synthetic capability rows (skills + `assistant` CLI commands).
 *
 * The assistant's invokable capabilities — installed/catalog skills and
 * top-level CLI subcommands — are seeded as synthetic concept-collection rows
 * (`skills/<id>`, `cli-commands/<name>`). The section-lane retrieval pipeline
 * surfaces the relevant ones per turn, same as concept pages.
 *
 * Page summaries for synthetic slugs already resolve through the existing
 * `pageSummary` lane (the v2 page index appends skill/CLI rows with a summary),
 * so only full-content rendering for the live `<memory>` block needs a synthetic
 * fallback — see {@link renderCapabilityContent}.
 */

import {
  getCliCommandCapability,
  isCliCommandSlug,
} from "../../../memory/v2/cli-command-store.js";
import {
  getSkillCapability,
  isSkillSlug,
} from "../../../memory/v2/skill-store.js";
import type { Slug } from "./types.js";

/** True iff the slug is a synthetic skill or CLI-command capability row. */
export function isCapabilitySlug(slug: Slug): boolean {
  return isSkillSlug(slug) || isCliCommandSlug(slug);
}

interface CapabilityEntry {
  id: string;
  content: string;
}

export interface CapabilityResolvers {
  skill: (idOrSlug: string) => CapabilityEntry | null;
  cli: (idOrSlug: string) => CapabilityEntry | null;
}

const defaultResolvers: CapabilityResolvers = {
  skill: getSkillCapability,
  cli: getCliCommandCapability,
};

/**
 * Render a synthetic skill/CLI slug's full capability content for the live
 * `<memory>` block, mirroring {@link renderV3PageContent}'s `# header\n<content>`
 * shape. Returns:
 *  - the rendered block when the slug is a capability slug and resolves;
 *  - `""` when it is a capability slug but the cache has no entry (degrade to a
 *    blank section rather than throwing or falling through to an on-disk read
 *    that would also miss);
 *  - `null` when the slug is NOT a capability slug, so the caller falls through
 *    to its normal on-disk page rendering.
 *
 * `resolvers` is injectable for tests; production uses the v2 store caches.
 */
export function renderCapabilityContent(
  slug: Slug,
  resolvers: CapabilityResolvers = defaultResolvers,
): string | null {
  if (isSkillSlug(slug)) {
    const entry = resolvers.skill(slug);
    return entry ? `# Skill: ${entry.id}\n${entry.content}` : "";
  }
  if (isCliCommandSlug(slug)) {
    const entry = resolvers.cli(slug);
    return entry ? `# CLI command: ${entry.id}\n${entry.content}` : "";
  }
  return null;
}
