/**
 * The PKB buffer's "is there filable work?" check, as a leaf module (fs +
 * workspace path only).
 *
 * The jobs-worker's maintenance scheduler (`jobs-worker.ts`) consults it when
 * deciding whether to enqueue a `pkb_filing` job, and the filing handler
 * (`filing-jobs.ts`) re-checks it at run time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripCommentLines } from "./host-utils.js";
import { getWorkspaceDir } from "./paths.js";

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
