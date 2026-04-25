// ---------------------------------------------------------------------------
// Memory Tool handlers
//
// remember: save facts to the PKB (buffer.md + daily archive)
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { enqueuePkbIndexJob } from "../jobs/embed-pkb-file.js";
import { PKB_WORKSPACE_SCOPE } from "../pkb/types.js";

const log = getLogger("graph-tool-handlers");

// ---------------------------------------------------------------------------
// remember handler — writes to PKB buffer + daily archive
// ---------------------------------------------------------------------------

export interface RememberInput {
  content: string;
  finish_turn?: boolean;
}

export interface RememberResult {
  success: boolean;
  message: string;
}

export function handleRemember(
  input: RememberInput,
  _conversationId: string,
  _scopeId: string,
): RememberResult {
  if (!input.content || input.content.trim().length === 0) {
    return { success: false, message: "content is required" };
  }

  const workspaceDir = getWorkspaceDir();
  const pkbDir = join(workspaceDir, "pkb");
  const archiveDir = join(pkbDir, "archive");

  // Ensure directories exist
  mkdirSync(pkbDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  // Build timestamped entry
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short" });
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  const entry = `- [${month} ${day}, ${displayHour}:${minutes} ${ampm}] ${input.content.trim()}\n`;

  // Append to buffer.md
  const bufferPath = join(pkbDir, "buffer.md");
  appendFileSync(bufferPath, entry, "utf-8");
  enqueuePkbReindex(pkbDir, bufferPath);

  // Append to daily archive
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const archivePath = join(archiveDir, `${yyyy}-${mm}-${dd}.md`);
  if (!existsSync(archivePath)) {
    appendFileSync(archivePath, `# ${month} ${day}, ${yyyy}\n\n`, "utf-8");
  }
  appendFileSync(archivePath, entry, "utf-8");
  enqueuePkbReindex(pkbDir, archivePath);

  return { success: true, message: "Saved to knowledge base." };
}

/**
 * Fire-and-forget enqueue of a PKB re-index job for a file we just wrote.
 *
 * Always indexes under {@link PKB_WORKSPACE_SCOPE}. See the comment on that
 * constant for why PKB points are not per-conversation-scoped.
 *
 * Wrapped in try/catch so an enqueue failure (e.g. DB hiccup) cannot break
 * the remember call — the write has already succeeded and the user's fact
 * is safe on disk.
 */
function enqueuePkbReindex(pkbRoot: string, absPath: string): void {
  try {
    enqueuePkbIndexJob({
      pkbRoot,
      absPath,
      memoryScopeId: PKB_WORKSPACE_SCOPE,
    });
  } catch (err) {
    log.warn({ err, absPath }, "Failed to enqueue PKB re-index job");
  }
}
