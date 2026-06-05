/**
 * Memory v3 — synthetic "capabilities" leaf (skills + `assistant` CLI commands).
 *
 * v2 surfaces the assistant's invokable capabilities — installed/catalog skills
 * and top-level CLI subcommands — by seeding them as synthetic concept-collection
 * rows (`skills/<id>`, `cli-commands/<name>`) into the unified router pool, then
 * rendering the router-selected ones under `### Skills You Can Use` / `### CLI
 * Commands You Can Use`. They are NOT always-injected — they are router-selected
 * per turn, same as concept pages.
 *
 * v3 reproduces that behavior with one always-on leaf:
 *  - The leaf is synthesized in code (not a `leaves/*.md` data file) and injected
 *    ONLY into the live lane tree (see `shadow-plugin.ts`). Because the classifier
 *    builds its own tree without this injection, concept pages are never routed
 *    INTO the capabilities leaf.
 *  - Its members are the synthetic skill/CLI slugs, so the BM25 needle indexes
 *    them for free (the needle corpus is `tree.byPage`).
 *  - It is added to the always-on core set, so L1 always opens it and the per-leaf
 *    L2 selects the relevant subset each turn — the semantic equivalent of v2's
 *    "always in the pool, selected per turn".
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
import { getSkillCapability, isSkillSlug } from "../../../memory/v2/skill-store.js";
import type { LeafNode, LeafPath, LeafTree, Slug } from "./types.js";

/** Path of the always-on synthetic leaf that owns skill + CLI capability rows. */
export const CAPABILITIES_LEAF_PATH: LeafPath = "capabilities";

/** L1/needle label for the capabilities leaf. */
export const CAPABILITIES_LEAF_DESCRIPTION =
  "Tools the assistant can invoke: installed and available skills, and the " +
  "top-level `assistant` CLI subcommands — what the assistant can DO and how " +
  "to reach for each capability.";

/** True iff the slug is a synthetic skill or CLI-command capability row. */
export function isCapabilitySlug(slug: Slug): boolean {
  return isSkillSlug(slug) || isCliCommandSlug(slug);
}

/**
 * Inject the synthetic capabilities leaf into a live lane tree: register the leaf
 * node with `syntheticSlugs` as members, add the leaf to each member's `byPage`
 * entry (UNION — never drops existing leaves), and mark the leaf always-on by
 * adding its path to `core`. Mutates `tree` and `core` in place. Idempotent.
 *
 * Must run BEFORE the needle is built so the synthetic members land in the needle
 * corpus (`tree.byPage`).
 */
export function injectCapabilitiesLeaf(
  tree: LeafTree,
  core: Set<LeafPath>,
  syntheticSlugs: Slug[],
): void {
  const node: LeafNode = {
    path: CAPABILITIES_LEAF_PATH,
    frontmatter: { path: CAPABILITIES_LEAF_PATH, in_core: true },
    description: CAPABILITIES_LEAF_DESCRIPTION,
    members: [...syntheticSlugs],
    domain: CAPABILITIES_LEAF_PATH,
  };
  tree.leaves.set(CAPABILITIES_LEAF_PATH, node);

  for (const slug of syntheticSlugs) {
    const existing = tree.byPage.get(slug) ?? [];
    if (!existing.includes(CAPABILITIES_LEAF_PATH)) {
      tree.byPage.set(slug, [...existing, CAPABILITIES_LEAF_PATH]);
    }
  }

  // Always-on: L1 always opens it, L2 selects the relevant subset per turn.
  core.add(CAPABILITIES_LEAF_PATH);
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
