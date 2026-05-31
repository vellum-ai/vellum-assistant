import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, relative } from "node:path";

import { parse, stringify } from "yaml";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-092-backfill-leaf-ids");

/** v3 leaf files live under this path relative to the workspace dir. */
const LEAVES_REL = join("memory", "v3", "data", "leaves");

const FRONTMATTER_DELIMITER = "---";

interface SplitLeaf {
  /** Raw YAML frontmatter block (between the `---` fences), without fences. */
  frontmatter: string;
  /** Everything after the closing frontmatter fence, verbatim. */
  body: string;
}

/**
 * Split a leaf `.md` file into its YAML frontmatter block and body. Returns
 * `null` when the file does not open with a `---` frontmatter fence, so callers
 * can skip files that are not well-formed leaves (we never rewrite those).
 */
function splitFrontmatter(content: string): SplitLeaf | null {
  if (!content.startsWith(FRONTMATTER_DELIMITER)) return null;
  // Skip the opening fence and find the closing one at the start of a line.
  const afterOpen = content.slice(FRONTMATTER_DELIMITER.length);
  const closeMatch = afterOpen.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return null;
  const frontmatter = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { frontmatter, body };
}

/**
 * Deterministic, stable id derived from the leaf's relative path at backfill
 * time. The same path always yields the same id, so re-runs and re-installs
 * converge. 12 hex chars (48 bits) is ample to avoid collisions across the
 * handful-to-thousands of leaves a workspace holds.
 */
function stableIdForPath(relPath: string): string {
  return createHash("sha256").update(relPath).digest("hex").slice(0, 12);
}

/** Recursively collect every `.md` file under `dir`. */
function collectLeafFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectLeafFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Backfill a stable `id` into the frontmatter of `file` if it lacks one.
 * Returns `true` when the file was rewritten. Idempotent: a leaf that already
 * has an `id` is left untouched. The id is keyed off the leaf's path relative
 * to the leaves root so it is stable across machines and re-runs.
 */
function backfillLeaf(leavesDir: string, file: string): boolean {
  const content = fs.readFileSync(file, "utf8");
  const split = splitFrontmatter(content);
  if (!split) {
    log.warn({ file }, "Leaf file missing YAML frontmatter; skipping");
    return false;
  }

  let data: Record<string, unknown>;
  try {
    const parsed = parse(split.frontmatter) as unknown;
    data =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
  } catch (err) {
    log.warn({ err, file }, "Failed to parse leaf frontmatter; skipping");
    return false;
  }

  if (typeof data.id === "string" && data.id.length > 0) {
    return false; // Already has a stable id — idempotent skip.
  }

  const relPath = relative(leavesDir, file);
  data.id = stableIdForPath(relPath);

  const newFrontmatter = stringify(data).replace(/\n$/, "");
  const rebuilt = `${FRONTMATTER_DELIMITER}\n${newFrontmatter}\n${FRONTMATTER_DELIMITER}\n${split.body}`;
  fs.writeFileSync(file, rebuilt, "utf8");
  return true;
}

/**
 * Backfill a stable `id` into every v3 leaf's frontmatter.
 *
 * v3 leaves are addressed by their on-disk `path`, which moves as the tree is
 * reorganized. A stable `id` gives downstream self-maintenance machinery a
 * durable handle that survives path churn. The id is a short hash of the leaf's
 * relative path at backfill time — deterministic, so re-runs and fresh installs
 * converge — and existing ids are preserved.
 */
export const backfillLeafIdsMigration: WorkspaceMigration = {
  id: "092-backfill-leaf-ids",
  description: "Backfill a stable id into every v3 leaf's frontmatter",
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    const leavesDir = join(workspaceDir, LEAVES_REL);
    if (!fs.existsSync(leavesDir)) return; // No v3 leaves yet — no-op.

    let rewritten = 0;
    for (const file of collectLeafFiles(leavesDir)) {
      if (backfillLeaf(leavesDir, file)) rewritten += 1;
    }
    if (rewritten > 0) {
      log.info(
        { rewritten, leavesDir },
        "Backfilled stable ids into v3 leaves",
      );
    }
  },

  // No-op: stripping ids would discard the durable handles other code now
  // relies on. A backfilled id is harmless to leave in place on rollback.
  down(): void {},
};
