import { existsSync, readFileSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

/**
 * Read the NOW.md scratchpad from the workspace prompt directory.
 *
 * Returns the trimmed content with `_`-prefixed comment lines stripped,
 * or `null` if the file is missing, empty, or unreadable.
 */
export function readNowScratchpad(): string | null {
  const nowPath = getWorkspacePromptPath("NOW.md");
  if (!existsSync(nowPath)) return null;
  try {
    const stripped = stripCommentLines(readFileSync(nowPath, "utf-8")).trim();
    return stripped.length > 0 ? stripped : null;
  } catch {
    return null;
  }
}
