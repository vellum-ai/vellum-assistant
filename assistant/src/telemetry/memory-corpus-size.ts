import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Coarse on-disk size of the assistant's memory corpus, in the snake_case
 * shape the `memory_tier` watchdog `detail` bag carries to the platform.
 *
 * Both corpora are measured on every tier rather than branching on the tier
 * itself: an assistant part-way through a v1 -> v2 -> v3 migration has content
 * in both trees, and a `memory.enabled: false` assistant still has whatever it
 * accumulated before being switched off. Reporting both unconditionally keeps
 * the numbers legible across a migration instead of blinking to zero the
 * moment a tier flips.
 *
 * KNOWN GAP: this measures on-disk Markdown only. It does NOT count
 * `memory_graph_nodes`, which is a real part of a v1 assistant's learned state
 * — `v2/migration.ts` gathers graph nodes alongside PKB Markdown when it
 * migrates v1 — so a v1 assistant rich in graph nodes but holding only the
 * seeded PKB files reads as near-empty here. Counting them means opening the
 * memory SQLite DB from the resource-monitor process, which this probe
 * deliberately does not do. Treat `pkb_files` as a lower bound on v1 corpus
 * size and confirm v1 assistants directly before sizing a migration off it.
 */
export interface MemoryCorpusSize {
  /** `.md` files under `memory/concepts/` — the v2/v3 concept-page count. */
  concept_pages: number;
  /** Total bytes of those concept pages. */
  concept_bytes: number;
  /** `.md` files under `pkb/` — the v1 personal-knowledge-base corpus. */
  pkb_files: number;
  /** Total bytes of those PKB files. */
  pkb_bytes: number;
  /**
   * Non-empty lines in `memory/buffer.md` — remembered facts still waiting on
   * consolidation. Matches `countBufferLines` in the substrate's
   * consolidation job: for a well-formed buffer, one non-empty line is one
   * entry.
   */
  buffer_lines: number;
}

/**
 * Ceiling on directory entries examined per tree. The largest corpus observed
 * in the fleet is in the low hundreds of pages, so this never binds in
 * practice; it exists so a pathological workspace cannot turn a telemetry
 * probe into a long walk.
 *
 * It counts every dirent seen — directories and non-Markdown files included —
 * not just the Markdown matches. A cap on matches alone would not bound the
 * walk at all: a tree of a million empty directories contains zero Markdown
 * files and would still be traversed in full by this synchronous probe.
 *
 * A tree that hits the cap returns what it counted so far, making the result
 * a floor rather than an error.
 */
const MAX_ENTRIES_PER_TREE = 20_000;

interface TreeSize {
  files: number;
  bytes: number;
}

const EMPTY_TREE: TreeSize = { files: 0, bytes: 0 };

/**
 * Recursively total the `.md` files under `dir`.
 *
 * Deliberately synchronous, and deliberately not routed through the memory
 * plugin's `listPages` / `getPageIndex`. This runs in the resource-monitor
 * process, where the plugin's page-index cache is cold — going through it
 * would read and parse every concept page on each six-hour cycle, and would
 * add an import out of `telemetry/` into the plugin tree that the plugin
 * import-boundary guard exists to prevent. A bare readdir + stat is the whole
 * job here.
 *
 * `withFileTypes` dirents carry lstat semantics, so a symlinked directory
 * reports as a symlink rather than a directory and is skipped — the walk
 * cannot follow a link into a cycle, and needs no visited-inode bookkeeping.
 *
 * `maxEntries` is a parameter only so the ceiling is testable without
 * materializing twenty thousand files; production callers take the default.
 */
export function measureMarkdownTree(
  dir: string,
  maxEntries: number = MAX_ENTRIES_PER_TREE,
): TreeSize {
  let files = 0;
  let bytes = 0;
  let visited = 0;
  const pending: string[] = [dir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A missing or unreadable subtree contributes nothing. The common case
      // is ENOENT: the tier that owns this tree was never active here.
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        return { files, bytes };
      }
      if (entry.isDirectory()) {
        pending.push(join(current, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      files += 1;
      try {
        bytes += statSync(join(current, entry.name)).size;
      } catch {
        // Counted in `files` but contributes no bytes — a file that vanished
        // between the readdir and the stat is a race, not a failure.
      }
    }
  }

  return { files, bytes };
}

/** Non-empty-line count of the file at `path`; 0 when it is absent or empty. */
function countNonEmptyLines(path: string): number {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  if (content.length === 0) {
    return 0;
  }
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Measure the on-disk memory corpus for this assistant.
 *
 * Never throws: every probe degrades to zero independently, so a corpus that
 * is partly unreadable still reports the part that is.
 */
export function measureMemoryCorpusSize(): MemoryCorpusSize {
  const workspaceDir = getWorkspaceDir();

  let concepts: TreeSize = EMPTY_TREE;
  let pkb: TreeSize = EMPTY_TREE;
  let bufferLines = 0;

  try {
    concepts = measureMarkdownTree(join(workspaceDir, "memory", "concepts"));
  } catch {
    concepts = EMPTY_TREE;
  }
  try {
    pkb = measureMarkdownTree(join(workspaceDir, "pkb"));
  } catch {
    pkb = EMPTY_TREE;
  }
  try {
    bufferLines = countNonEmptyLines(join(workspaceDir, "memory", "buffer.md"));
  } catch {
    bufferLines = 0;
  }

  return {
    concept_pages: concepts.files,
    concept_bytes: concepts.bytes,
    pkb_files: pkb.files,
    pkb_bytes: pkb.bytes,
    buffer_lines: bufferLines,
  };
}
