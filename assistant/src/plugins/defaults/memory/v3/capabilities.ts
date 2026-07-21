/**
 * Memory v3 — synthetic capability rows (skills + `assistant` CLI commands).
 *
 * The assistant's invokable capabilities — installed/catalog skills and
 * top-level CLI subcommands — are seeded as synthetic concept-collection rows
 * (`skills/<id>`, `cli-commands/<name>`). The section-lane retrieval pipeline
 * surfaces the relevant ones per turn, same as concept pages.
 *
 * Capability slugs have two render forms with different budgets:
 *  - the INJECTION form ({@link renderCapabilityContent}) — what surfaces put
 *    in front of the model. Skills render their capability statement (already
 *    description-sized); CLI commands render a one-line summary with a
 *    `--help` pointer, never their full help.
 *  - the INDEX form ({@link renderCapabilityBody}) — the full `content`
 *    (for CLI commands, the complete help text). It feeds the section index
 *    and dense/needle lanes, where flag descriptions and examples are what
 *    make a command semantically findable.
 */

import { buildCliCommandSummary } from "./substrate/cli-command-content.js";
import {
  getCliCommandCapability,
  isCliCommandSlug,
} from "./substrate/cli-command-store.js";
import { getSkillCapability, isSkillSlug } from "./substrate/skill-store.js";
import type { Slug } from "./types.js";

/** True iff the slug is a synthetic skill or CLI-command capability row. */
export function isCapabilitySlug(slug: Slug): boolean {
  return isSkillSlug(slug) || isCliCommandSlug(slug);
}

interface SkillCapabilityEntry {
  id: string;
  content: string;
}

interface CliCapabilityEntry {
  id: string;
  description: string;
  content: string;
}

export interface CapabilityResolvers {
  skill: (idOrSlug: string) => SkillCapabilityEntry | null;
  cli: (idOrSlug: string) => CliCapabilityEntry | null;
}

const defaultResolvers: CapabilityResolvers = {
  skill: getSkillCapability,
  cli: getCliCommandCapability,
};

/**
 * Shared dispatch for the two render forms. Returns:
 *  - the rendered block when the slug is a capability slug and resolves;
 *  - `""` when it is a capability slug but the cache has no entry (degrade to a
 *    blank section rather than throwing or falling through to an on-disk read
 *    that would also miss);
 *  - `null` when the slug is NOT a capability slug, so the caller falls through
 *    to its normal on-disk page rendering.
 */
function renderCapability(
  slug: Slug,
  resolvers: CapabilityResolvers,
  cliText: (entry: CliCapabilityEntry) => string,
): string | null {
  if (isSkillSlug(slug)) {
    const entry = resolvers.skill(slug);
    return entry ? `# Skill: ${entry.id}\n${entry.content}` : "";
  }
  if (isCliCommandSlug(slug)) {
    const entry = resolvers.cli(slug);
    return entry ? `# CLI command: ${entry.id}\n${cliText(entry)}` : "";
  }
  return null;
}

/**
 * Render a synthetic skill/CLI slug's INJECTION form for the live `<memory>`
 * block (and the graph node detail / inspector renders), mirroring
 * {@link renderV3PageContent}'s `# header\n<content>` shape. CLI commands
 * render {@link buildCliCommandSummary} — description plus a `--help`
 * pointer — NOT their full help: the model fetches full usage itself, and a
 * turn can select dozens of commands, so per-entry cost dominates the block.
 * Return contract (block / `""` / `null`) is {@link renderCapability}'s.
 *
 * `resolvers` is injectable for tests; production uses the substrate caches.
 */
export function renderCapabilityContent(
  slug: Slug,
  resolvers: CapabilityResolvers = defaultResolvers,
): string | null {
  return renderCapability(slug, resolvers, (entry) =>
    buildCliCommandSummary(entry.id, entry.description),
  );
}

/**
 * Render a synthetic skill/CLI slug's INDEX form: the full capability
 * `content` (for CLI commands, the complete help text) under the same header
 * as the injection form. This is the body the section index, needle/dense
 * lanes, and section-embedding backfill see — retrieval keeps the full help
 * for findability even though injection renders only the summary.
 * Return contract (block / `""` / `null`) is {@link renderCapability}'s.
 */
export function renderCapabilityBody(
  slug: Slug,
  resolvers: CapabilityResolvers = defaultResolvers,
): string | null {
  return renderCapability(slug, resolvers, (entry) => entry.content);
}

/**
 * Resolve a slug's frontmatter-stripped body for the section index: synthetic
 * skill/CLI capability slugs have no on-disk page, so they contribute their
 * full INDEX-form capability content ({@link renderCapabilityBody}), while
 * real pages fall through to `readDiskBody`. Shared by `initLanes`'
 * `pageBody` and the full-backfill body reader so the capability-or-disk
 * dispatch lives in one place.
 *
 * `readDiskBody` is injected (rather than imported) so this helper does not
 * pull the page store into `capabilities.ts` — each caller supplies its own
 * cached or direct disk reader.
 */
export async function capabilityOrDiskBody(
  slug: Slug,
  readDiskBody: (slug: Slug) => Promise<string>,
): Promise<string> {
  if (isCapabilitySlug(slug)) return renderCapabilityBody(slug) ?? "";
  return readDiskBody(slug);
}
