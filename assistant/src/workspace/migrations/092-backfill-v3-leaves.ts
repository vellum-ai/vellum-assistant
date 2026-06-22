import * as fs from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * v3 leaf assignments and concept pages, addressed relative to the workspace.
 */
const ASSIGNMENTS_REL = join("memory", "v3", "data", "assignments.json");
const CONCEPTS_REL = join("memory", "concepts");

const FRONTMATTER_DELIMITER = "---";

/**
 * Read the v3 slug -> leaf-path assignment map from the workspace data dir.
 *
 * Returns an empty map when `assignments.json` is absent (the v3 data dir was
 * never materialized for this workspace) so the migration is a clean no-op.
 */
function readAssignments(workspaceDir: string): Record<string, string[]> {
  const assignmentsPath = join(workspaceDir, ASSIGNMENTS_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(assignmentsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, string[]>)
    : {};
}

interface SplitPage {
  /** Raw YAML frontmatter block (between the `---` fences), without fences. */
  frontmatter: string;
  /** Everything after the closing frontmatter fence, verbatim. */
  body: string;
}

/**
 * Split a concept page into its YAML frontmatter block and body. Returns `null`
 * when the file does not open with a `---` frontmatter fence (a page with no
 * frontmatter, which we leave untouched).
 *
 * Inlined here rather than importing `../v2/page-store` — workspace migrations
 * must stay self-contained (see AGENTS.md) so an append-only migration never
 * shifts semantics when the runtime page parser evolves.
 */
function splitFrontmatter(content: string): SplitPage | null {
  if (!content.startsWith(FRONTMATTER_DELIMITER)) return null;
  const afterOpen = content.slice(FRONTMATTER_DELIMITER.length);
  const closeMatch = afterOpen.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return null;
  const frontmatter = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { frontmatter, body };
}

/**
 * Locate a top-level `leaves:` field in the frontmatter lines: the index of its
 * key line plus the (exclusive) index after any indented block-sequence items
 * that belong to it. Returns `null` when no `leaves:` key is present.
 *
 * A line-shaped scan (rather than a YAML parse) keeps the migration free of an
 * npm dependency, as AGENTS.md requires; leaf frontmatter is flat key/value so
 * the only nesting is a `leaves:` block sequence (`  - path`).
 */
function findLeavesField(
  lines: string[],
): { start: number; end: number; nonEmpty: boolean } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = /^leaves:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.length > 0) {
      // Inline form: `leaves: [a, b]` (non-empty) or `leaves: []` (empty).
      return { start: i, end: i + 1, nonEmpty: inline !== "[]" };
    }
    // Block form: consume following indented lines (`  - item`) as the value.
    let end = i + 1;
    let nonEmpty = false;
    while (end < lines.length && /^[ \t]+\S/.test(lines[end])) {
      if (/^[ \t]+-[ \t]+\S/.test(lines[end])) nonEmpty = true;
      end++;
    }
    return { start: i, end, nonEmpty };
  }
  return null;
}

/**
 * Splice a non-empty `leaves:` block sequence into the frontmatter, replacing
 * any existing (empty) `leaves:` field in place so we never leave a duplicate
 * key. Leaf paths are simple slugs (`domain/topic`) that need no quoting; we
 * still defensively quote any value containing YAML-significant characters.
 */
function withLeaves(frontmatter: string, leaves: string[]): string {
  const quote = (v: string): string =>
    /[:#[\]{}",&*!|>%@`]/.test(v) ? JSON.stringify(v) : v;
  const block = ["leaves:", ...leaves.map((l) => `  - ${quote(l)}`)];

  const lines = frontmatter.replace(/\s+$/, "").split(/\r?\n/);
  // Drop a leading empty line so a previously blank frontmatter doesn't yield
  // a stray newline at the top.
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();

  const existing = findLeavesField(lines);
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, ...block);
  } else {
    lines.push(...block);
  }
  return lines.join("\n");
}

/**
 * Backfill `leaves:` into concept-page frontmatter from the v3 assignment map.
 *
 * v3 routing persists a slug -> leaf-path map at
 * `<workspace>/memory/v3/data/assignments.json`. Concept pages gained an
 * optional `leaves` frontmatter field, but existing pages predate it. This
 * one-time migration copies each slug's assignment into the matching page's
 * frontmatter.
 *
 * Idempotent: pages that already carry a non-empty `leaves` are left untouched
 * (never clobbered). A missing `assignments.json` or a slug with no matching
 * page is a no-op — neither throws. All read/write logic is inlined (built-ins
 * only) so the migration stays self-contained per AGENTS.md.
 */
export const backfillV3LeavesMigration: WorkspaceMigration = {
  id: "092-backfill-v3-leaves",
  description: "Backfill v3 leaf assignments into concept-page frontmatter",

  run(workspaceDir: string): void {
    const assignments = readAssignments(workspaceDir);
    const conceptsDir = join(workspaceDir, CONCEPTS_REL);

    for (const [slug, leaves] of Object.entries(assignments)) {
      if (!Array.isArray(leaves) || leaves.length === 0) continue;

      const file = join(conceptsDir, `${slug}.md`);
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      const split = splitFrontmatter(content);
      if (!split) continue; // No frontmatter fence — leave the page untouched.
      // Never clobber a page that already declares non-empty leaves.
      const existing = findLeavesField(split.frontmatter.split(/\r?\n/));
      if (existing?.nonEmpty) continue;

      const rebuilt = `${FRONTMATTER_DELIMITER}\n${withLeaves(
        split.frontmatter,
        leaves,
      )}\n${FRONTMATTER_DELIMITER}\n${split.body}`;
      fs.writeFileSync(file, rebuilt, "utf8");
    }
  },

  down(): void {
    // no-op: `leaves` is an additive field; removing it would lose data.
  },
};
