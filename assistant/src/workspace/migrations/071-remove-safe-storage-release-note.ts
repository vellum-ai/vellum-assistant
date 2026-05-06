import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "071-remove-safe-storage-release-note";
const SAFE_STORAGE_RELEASE_NOTE_ID = "067-release-notes-safe-storage-limits";
const SAFE_STORAGE_MARKER = `<!-- release-note-id:${SAFE_STORAGE_RELEASE_NOTE_ID} -->`;
const RELEASE_NOTE_MARKER_PREFIX = "<!-- release-note-id:";

const SAFE_STORAGE_RELEASE_NOTE = `${SAFE_STORAGE_MARKER}
## Safe storage limits

A new storage protection mode is available behind the safe-storage-limits
rollout flag. When enabled, the assistant watches workspace disk usage and
enters cleanup mode if the volume reaches the critical 95% threshold.

In cleanup mode, background processes pause and remote messages, including
trusted-contact messages, are blocked until the guardian frees enough space or
explicitly overrides the lock. The macOS app now shows a storage cleanup banner
that must be acknowledged before cleanup chat continues, then keeps a status
banner visible while cleanup mode is active.
`;

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stitchAroundRemovedBlock(before: string, after: string): string {
  if (before.trim() === "") {
    return after.replace(/^\n+/, "");
  }

  if (after.trim() === "") {
    return before.replace(/\n+$/, "\n");
  }

  return `${before.replace(/\n+$/, "\n\n")}${after.replace(/^\n+/, "")}`;
}

function removeRange(content: string, start: number, end: number): string {
  return stitchAroundRemovedBlock(content.slice(0, start), content.slice(end));
}

function removeSafeStorageReleaseNote(content: string): string {
  const normalized = normalizeNewlines(content);
  const exactStart = normalized.indexOf(SAFE_STORAGE_RELEASE_NOTE);
  if (exactStart >= 0) {
    return removeRange(
      normalized,
      exactStart,
      exactStart + SAFE_STORAGE_RELEASE_NOTE.length,
    );
  }

  const markerStart = normalized.indexOf(SAFE_STORAGE_MARKER);
  if (markerStart < 0) {
    return content;
  }

  const nextMarkerStart = normalized.indexOf(
    RELEASE_NOTE_MARKER_PREFIX,
    markerStart + SAFE_STORAGE_MARKER.length,
  );

  return removeRange(
    normalized,
    markerStart,
    nextMarkerStart >= 0 ? nextMarkerStart : normalized.length,
  );
}

export const removeSafeStorageReleaseNoteMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Remove safe storage release note from UPDATES.md",

  run(workspaceDir: string): void {
    const updatesPath = join(workspaceDir, "UPDATES.md");
    if (!existsSync(updatesPath)) {
      return;
    }

    const existing = readFileSync(updatesPath, "utf-8");
    if (!existing.includes(SAFE_STORAGE_MARKER)) {
      return;
    }

    const cleaned = removeSafeStorageReleaseNote(existing);
    if (cleaned.trim() === "") {
      rmSync(updatesPath, { force: true });
      return;
    }

    writeFileSync(updatesPath, cleaned, "utf-8");
  },

  down(_workspaceDir: string): void {
    // Forward-only: this removes a pending bulletin that should no longer be
    // shown to users.
  },
};
