import { existsSync } from "node:fs";
import { join } from "node:path";

import { getConversationsDir } from "../util/platform.js";

function getConversationDirTimestamp(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString().replace(/:/g, "-");
}

export function getLegacyConversationDirName(
  id: string,
  createdAtMs: number,
): string {
  return `${id}_${getConversationDirTimestamp(createdAtMs)}`;
}

/**
 * Build a filesystem-safe directory name for a conversation.
 * Format: `{isoDate}_{id}` where colons in the ISO date are replaced with
 * hyphens so the name is valid on all platforms (Windows forbids colons).
 */
export function getConversationDirName(
  id: string,
  createdAtMs: number,
): string {
  return `${getConversationDirTimestamp(createdAtMs)}_${id}`;
}

/**
 * Return the absolute path to a conversation's timestamp-first disk-view
 * directory.
 */
export function getConversationDirPath(
  id: string,
  createdAtMs: number,
): string {
  return join(getConversationsDir(), getConversationDirName(id, createdAtMs));
}

export function getLegacyConversationDirPath(
  id: string,
  createdAtMs: number,
): string {
  return join(
    getConversationsDir(),
    getLegacyConversationDirName(id, createdAtMs),
  );
}

/**
 * Resolve the active conversation directory path:
 * 1) prefer timestamp-first when it exists;
 * 2) otherwise reuse legacy sibling when present;
 * 3) otherwise fall back to timestamp-first as the creation target.
 */
export function getResolvedConversationDirPath(
  id: string,
  createdAtMs: number,
): string {
  const dirPath = getConversationDirPath(id, createdAtMs);
  if (existsSync(dirPath)) return dirPath;

  const legacyDirPath = getLegacyConversationDirPath(id, createdAtMs);
  if (existsSync(legacyDirPath)) return legacyDirPath;

  return dirPath;
}

export function getConversationAttachmentsDirPath(
  conversationId: string,
  createdAtMs: number,
): string {
  return join(
    getResolvedConversationDirPath(conversationId, createdAtMs),
    "attachments",
  );
}
