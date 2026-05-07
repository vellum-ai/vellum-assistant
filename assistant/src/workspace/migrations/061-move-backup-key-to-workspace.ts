/**
 * Workspace migration 061: NEUTRALIZED (was: move backup.key to workspace).
 *
 * This migration historically moved `~/.vellum/protected/backup.key` into
 * the workspace at `~/.vellum/workspace/.backup.key`. That direction is
 * wrong: the workspace is the assistant's sandbox surface — `bash` and
 * other tools read files from it without `path-policy.ts` mediation, so a
 * workspace `.backup.key` is exposed to prompt-injection-driven exfiltration.
 *
 * 061 is preserved in the registry (entries are append-only and never
 * removed) but is now a no-op for fresh installs. Existing installs that
 * already executed 061 have a workspace `.backup.key`; migration 072
 * (`072-cleanup-workspace-backup-key`) relocates it back to
 * `~/.vellum/protected/backup.key` and removes the workspace copy.
 *
 * See ATL-444 for the full vulnerability writeup. Do not restore the
 * original behavior — it would re-introduce the exposure.
 */

import type { WorkspaceMigration } from "./types.js";

export const moveBackupKeyToWorkspaceMigration: WorkspaceMigration = {
  id: "061-move-backup-key-to-workspace",
  description:
    "(deprecated) Previously moved backup.key into the workspace; now a no-op (see migration 072 for cleanup)",

  run(_workspaceDir: string): void {
    // No-op. See migration 072 for cleanup of any workspace backup.key
    // left over from earlier runs of this migration.
  },

  down(_workspaceDir: string): void {
    // No-op.
  },
};
