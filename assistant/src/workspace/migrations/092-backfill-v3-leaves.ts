import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readPage, writePage } from "../../memory/v2/page-store.js";
import type { LeafPath, Slug } from "../../memory/v3/types.js";
import type { WorkspaceMigration } from "./types.js";

/**
 * Read the v3 slug -> leaf-path assignment map from the workspace data dir.
 *
 * Returns an empty map when `assignments.json` is absent (the v3 data dir was
 * never materialized for this workspace) so the migration is a clean no-op.
 */
async function readAssignments(
  workspaceDir: string,
): Promise<Record<Slug, LeafPath[]>> {
  const assignmentsPath = join(
    workspaceDir,
    "memory",
    "v3",
    "data",
    "assignments.json",
  );
  let raw: string;
  try {
    raw = await readFile(assignmentsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw) as Record<Slug, LeafPath[]>;
}

/**
 * Backfill `leaves:` into concept-page frontmatter from the v3 assignment map.
 *
 * v3 routing persists a slug -> leaf-path map at
 * `<workspace>/memory/v3/data/assignments.json`. Concept pages gained an
 * optional `leaves` frontmatter field (`ConceptPageFrontmatterSchema`), but
 * existing pages predate it. This one-time migration copies each slug's
 * assignment into the matching page's frontmatter.
 *
 * Idempotent: pages that already carry a non-empty `leaves` are left untouched
 * (never clobbered). A missing `assignments.json` or a slug with no matching
 * page is a no-op — neither throws.
 */
export const backfillV3LeavesMigration: WorkspaceMigration = {
  id: "092-backfill-v3-leaves",
  description: "Backfill v3 leaf assignments into concept-page frontmatter",

  async run(workspaceDir: string): Promise<void> {
    const assignments = await readAssignments(workspaceDir);

    for (const [slug, leaves] of Object.entries(assignments)) {
      if (!leaves || leaves.length === 0) continue;

      const page = await readPage(workspaceDir, slug);
      if (!page) continue;

      const existing = page.frontmatter.leaves;
      if (existing && existing.length > 0) continue;

      await writePage(workspaceDir, {
        slug: page.slug,
        frontmatter: { ...page.frontmatter, leaves: [...leaves] },
        body: page.body,
      });
    }
  },

  down(): void {
    // no-op: `leaves` is an additive field; removing it would lose data.
  },
};
