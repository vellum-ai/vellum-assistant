// ---------------------------------------------------------------------------
// Memory v2 — Shared "NOW" context loader
// ---------------------------------------------------------------------------
//
// The activation formula's `c_now` term needs a snapshot of the prose meta
// files (`essentials.md`, `threads.md`, `recent.md`) that the system prompt
// also autoloads (see `prompts/system-prompt.ts buildMemoryV2Section`).
// Missing or unreadable files are treated as empty so a fresh workspace
// (no consolidation has run yet) still reaches the v2 injector with a
// well-defined `nowText`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const NOW_FILES = ["essentials.md", "threads.md", "recent.md"] as const;

/**
 * Read `memory/{essentials,threads,recent}.md` and concatenate the trimmed
 * non-empty contents (in the same order the system prompt autoloads them).
 *
 * Returns an empty string when none of the files exist or all are empty.
 */
export async function loadNowText(workspaceDir: string): Promise<string> {
  const reads = await Promise.all(
    NOW_FILES.map(async (filename) => {
      try {
        const text = await readFile(
          join(workspaceDir, "memory", filename),
          "utf-8",
        );
        return text.trim();
      } catch {
        return "";
      }
    }),
  );
  return reads.filter((part) => part.length > 0).join("\n\n");
}
