/**
 * Workspace migration 012: Rename legacy conversation disk-view directories
 * from `{conversationId}_{timestamp}` to `{timestamp}_{conversationId}`.
 *
 * Idempotent and conservative:
 * - skips directories that already use the new format
 * - skips non-matching directories
 * - leaves an existing target directory alone rather than clobbering it
 * - continues past per-directory rename failures
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const LEGACY_CONVERSATION_DIR_PATTERN =
  /^(.*)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)$/;

function parseLegacyConversationDirName(
  dirName: string,
): { conversationId: string; timestamp: string } | null {
  const match = dirName.match(LEGACY_CONVERSATION_DIR_PATTERN);
  if (!match) return null;

  return {
    conversationId: match[1],
    timestamp: match[2],
  };
}

export const renameConversationDiskViewDirsMigration: WorkspaceMigration = {
  id: "012-rename-conversation-disk-view-dirs",
  description:
    "Rename legacy conversation disk-view directories to timestamp-first names",

  run(workspaceDir: string): void {
    const conversationsDir = join(workspaceDir, "conversations");
    if (!existsSync(conversationsDir)) return;

    const entries = readdirSync(conversationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const dirName of entries) {
      const parsed = parseLegacyConversationDirName(dirName);
      if (!parsed) continue;

      const sourcePath = join(conversationsDir, dirName);
      const targetName = `${parsed.timestamp}_${parsed.conversationId}`;
      const targetPath = join(conversationsDir, targetName);

      if (sourcePath === targetPath) continue;
      if (existsSync(targetPath)) continue;

      try {
        renameSync(sourcePath, targetPath);
      } catch {
        // Best-effort: leave the old directory in place if a single rename fails.
      }
    }
  },
};
