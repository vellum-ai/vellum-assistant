import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { stripCommentLines } from "../host-utils.js";
import { getWorkspaceDir } from "../paths.js";
import { getPkbAutoInjectList } from "./autoinject.js";

/** Max buffer.md lines injected into prompts — keeps context bounded even when filing is off. */
const MAX_BUFFER_LINES = 50;

/**
 * Read the always-loaded PKB files and append a nudge encouraging the
 * assistant to proactively read topic files and use `remember` aggressively.
 *
 * Which files are loaded is determined by `pkb/_autoinject.md` (one filename
 * per line). Falls back to the built-in defaults when that file is absent.
 *
 * Returns the concatenated content ready for injection, or `null` if all
 * files are missing or empty.
 */
export function readPkbContext(): string | null {
  const pkbDir = join(getWorkspaceDir(), "pkb");
  if (!existsSync(pkbDir)) return null;

  const filesToInject = getPkbAutoInjectList(pkbDir);

  const parts: string[] = [];
  for (const file of filesToInject) {
    // Path traversal guard: reject entries that escape the pkb directory
    const filePath = resolve(pkbDir, file);
    if (!filePath.startsWith(pkbDir + "/")) continue;

    if (!existsSync(filePath)) continue;
    try {
      let content = stripCommentLines(readFileSync(filePath, "utf-8")).trim();
      if (file === "buffer.md" && content.length > 0) {
        // Cap buffer entries to prevent unbounded growth when filing is disabled
        const lines = content.split("\n");
        if (lines.length > MAX_BUFFER_LINES) {
          content = lines.slice(-MAX_BUFFER_LINES).join("\n");
        }
      }
      if (content.length > 0) parts.push(content);
    } catch {
      // Skip unreadable files
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
