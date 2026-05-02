/**
 * Workspace migration 059: Move vellum.pid from root to workspace.
 *
 * The PID file previously lived at ~/.vellum/vellum.pid (the root dir).
 * This migration moves it into the workspace directory so that the root
 * dir can eventually be eliminated on platform deployments.
 */

import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";
import { getVellumRoot } from "./utils.js";

export const movePidToWorkspaceMigration: WorkspaceMigration = {
  id: "059-move-pid-to-workspace",
  description: "Move vellum.pid from root to workspace",

  run(workspaceDir: string): void {
    const oldPath = join(getVellumRoot(), "vellum.pid");
    const newPath = join(workspaceDir, "vellum.pid");
    if (!existsSync(oldPath)) return;
    if (existsSync(newPath)) {
      try {
        unlinkSync(oldPath);
      } catch {}
      return;
    }
    try {
      renameSync(oldPath, newPath);
    } catch {}
  },

  down(workspaceDir: string): void {
    const oldPath = join(getVellumRoot(), "vellum.pid");
    const newPath = join(workspaceDir, "vellum.pid");
    if (!existsSync(newPath)) return;
    if (existsSync(oldPath)) {
      try {
        unlinkSync(newPath);
      } catch {}
      return;
    }
    try {
      renameSync(newPath, oldPath);
    } catch {}
  },
};
