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
 * Parse a canonical conversation directory name (`<ISO-with-dashes>_<id>`)
 * back into its components. Returns null for names that don't match the
 * canonical format — callers should treat null as "skip this entry"
 * rather than as an error.
 *
 * Inverse of {@link getConversationDirName}. Does NOT parse the legacy
 * `<id>_<ISO-with-dashes>` format.
 */
export function parseConversationDirName(
  name: string,
): { conversationId: string; createdAtMs: number } | null {
  // Canonical format: YYYY-MM-DDTHH-MM-SS.sssZ_<uuid>
  // The timestamp portion has 4 hyphens (date + time-component separators)
  // and ends in `Z`. Anchor the regex to enforce that.
  const match = name.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{1,9}Z)_(.+)$/,
  );
  if (!match) return null;
  const [, datePart, hh, mm, ssAndMs, conversationId] = match;
  const iso = `${datePart}T${hh}:${mm}:${ssAndMs}`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  if (!conversationId) return null;
  // Reject conversation IDs that are path-traversal-shaped or contain
  // path separators. These are never valid conversation IDs and would
  // be a defense-in-depth concern if parsed.conversationId is later used
  // to construct filesystem paths.
  if (
    conversationId === "." ||
    conversationId === ".." ||
    conversationId.includes("/") ||
    conversationId.includes("\\")
  ) {
    return null;
  }
  return { conversationId, createdAtMs: ms };
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

export interface ResolvedConversationDirectoryPaths {
  canonicalDirPath: string;
  canonicalDirName: string;
  legacyDirPath: string;
  legacyDirName: string;
  resolvedDirPath: string;
  resolvedDirName: string;
  hasCanonicalDir: boolean;
  hasLegacyDir: boolean;
}

export function resolveConversationDirectoryPaths(
  id: string,
  createdAtMs: number,
  conversationsDir: string = getConversationsDir(),
): ResolvedConversationDirectoryPaths {
  const canonicalDirName = getConversationDirName(id, createdAtMs);
  const canonicalDirPath = join(conversationsDir, canonicalDirName);
  const hasCanonicalDir = existsSync(canonicalDirPath);

  const legacyDirName = getLegacyConversationDirName(id, createdAtMs);
  const legacyDirPath = join(conversationsDir, legacyDirName);
  const hasLegacyDir = existsSync(legacyDirPath);

  const resolvedDirPath = hasCanonicalDir
    ? canonicalDirPath
    : hasLegacyDir
      ? legacyDirPath
      : canonicalDirPath;
  const resolvedDirName = hasCanonicalDir
    ? canonicalDirName
    : hasLegacyDir
      ? legacyDirName
      : canonicalDirName;

  return {
    canonicalDirPath,
    canonicalDirName,
    legacyDirPath,
    legacyDirName,
    resolvedDirPath,
    resolvedDirName,
    hasCanonicalDir,
    hasLegacyDir,
  };
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
  return resolveConversationDirectoryPaths(id, createdAtMs).resolvedDirPath;
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
