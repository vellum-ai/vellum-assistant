/**
 * Workspace migration 072: Clean up any stale backup.key from the workspace.
 *
 * The backup encryption key must NEVER live inside the workspace directory.
 * The workspace is the assistant's sandbox surface — `bash` and other tools
 * read files from it without `path-policy.ts` mediation, so a prompt-injected
 * `cat .backup.key` would disclose the key and enable decryption of any
 * encrypted offsite backup.
 *
 * Migration 061 (`061-move-backup-key-to-workspace`) historically moved the
 * key INTO the workspace; that direction was wrong. 061 is now a no-op for
 * fresh installs, but installs that already executed it have a workspace
 * `.backup.key` sitting in the sandbox. This migration relocates any such
 * key back to `~/.vellum/protected/backup.key` (the legacy location that
 * gateway data-migration `m0003-recover-backup-key` knows how to recover
 * from) and removes the workspace copy.
 *
 * Idempotent: silent no-op when no workspace key is present. If a protected
 * key already exists, the workspace copy is treated as a duplicate and
 * deleted without overwriting the canonical key.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";
import { getVellumRoot } from "./utils.js";

export const cleanupWorkspaceBackupKeyMigration: WorkspaceMigration = {
  id: "072-cleanup-workspace-backup-key",
  description:
    "Remove backup.key from the workspace; relocate to ~/.vellum/protected/ if needed",

  run(workspaceDir: string): void {
    const workspaceKey = join(workspaceDir, ".backup.key");
    if (!existsSync(workspaceKey)) return;

    const protectedDir = join(getVellumRoot(), "protected");
    const protectedKey = join(protectedDir, "backup.key");

    if (!existsSync(protectedKey)) {
      try {
        mkdirSync(protectedDir, { recursive: true, mode: 0o700 });
        copyFileSync(workspaceKey, protectedKey);
        try {
          chmodSync(protectedKey, 0o600);
        } catch {
          // best-effort permission tightening
        }
      } catch {
        // If we cannot write the protected copy, leave the workspace key
        // alone — a later migration run or m0003 (gateway) will retry.
        // Removing the only copy of the key would be unsafe.
        return;
      }
    }

    try {
      unlinkSync(workspaceKey);
    } catch {
      // best-effort cleanup
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: never restore a backup.key inside the workspace on
    // rollback; the workspace is the wrong location regardless of version.
  },
};
