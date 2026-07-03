/**
 * Enqueue-time gates for the PKB filing/compaction jobs, as a leaf module.
 *
 * The jobs-worker's maintenance scheduler consults these when deciding whether
 * to enqueue a `pkb_filing` / `pkb_compaction` job, and the filing handler
 * re-checks the buffer at run time. Kept dependency-light (fs + workspace path
 * only) so the worker's scheduler can import it without pulling the memory
 * plugin's execution machinery into its module graph.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../../../util/platform.js";
import { stripCommentLines } from "../../../util/strip-comment-lines.js";

/**
 * Whether `pkb/buffer.md` has any filable content (comment lines and
 * whitespace don't count). Filing is skipped when the buffer is empty — no
 * work to do, so no LLM run.
 */
export function hasPkbBufferContent(): boolean {
  const bufferPath = join(getWorkspaceDir(), "pkb", "buffer.md");
  if (!existsSync(bufferPath)) return false;
  try {
    const content = stripCommentLines(readFileSync(bufferPath, "utf-8")).trim();
    return content.length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether `hour` falls inside the configured active window. A `null` bound on
 * either side means no restriction. Windows may wrap midnight (start > end,
 * e.g. 22–6).
 */
export function isWithinPkbActiveHours(
  hour: number,
  start: number | null,
  end: number | null,
): boolean {
  if (start == null || end == null) return true;
  if (start <= end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}
