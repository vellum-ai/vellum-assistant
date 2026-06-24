/**
 * Workspace migration 048: retained no-op.
 *
 * This migration previously deleted `<workspace>/hooks/`, treating it as dead
 * state. `<workspace>/hooks/` is now a supported surface: standalone hook files
 * placed there are loaded by the hook loader (see `src/hooks/hook-loader.ts`).
 * Deleting it would destroy user-authored hooks — including on workspaces that
 * mount a preseeded `<workspace>/hooks/` before this migration first runs — so
 * the deletion has been removed.
 *
 * The migration is kept (rather than removed from the registry) so the applied
 * checkpoint sequence stays stable across already-migrated workspaces. It is a
 * no-op on every workspace, new or old.
 */

import type { WorkspaceMigration } from "./types.js";

export const removeWorkspaceHooksMigration: WorkspaceMigration = {
  id: "048-remove-workspace-hooks",
  description: "Retained no-op (workspace/hooks is now a supported surface)",

  run(_workspaceDir: string): void {
    // No-op: `<workspace>/hooks/` is a supported surface and must be preserved.
  },

  down(_workspaceDir: string): void {
    // No-op: forward-only; nothing to reverse.
  },
};
