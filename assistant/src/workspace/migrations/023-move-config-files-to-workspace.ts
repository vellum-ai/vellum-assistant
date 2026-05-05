/**
 * Workspace migration 023: Move config/state JSON files from root to workspace.
 *
 * Previously, dictation-profiles.json, email-guardrails.json, and
 * active-call-leases.json lived directly under the Vellum root (~/.vellum/).
 * This migration moves them into the workspace directory so they follow
 * the workspace convention for organizational consistency.
 */

import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";
import { getVellumRoot } from "./utils.js";
/** Files to move from root → workspace. */
const CONFIG_FILES = [
  "dictation-profiles.json",
  "email-guardrails.json",
  "active-call-leases.json",
] as const;

export const moveConfigFilesToWorkspaceMigration: WorkspaceMigration = {
  id: "023-move-config-files-to-workspace",
  description:
    "Move dictation-profiles, email-guardrails, and active-call-leases from root to workspace",

  run(workspaceDir: string): void {
    const rootDir = getVellumRoot();

    for (const file of CONFIG_FILES) {
      const oldPath = join(rootDir, file);
      const newPath = join(workspaceDir, file);

      if (!existsSync(oldPath)) continue;
      // Don't overwrite if the destination already exists (e.g. partial
      // previous run or user-created file).
      if (existsSync(newPath)) {
        // Clean up the old file since workspace already has one.
        try {
          unlinkSync(oldPath);
        } catch {
          // Best-effort cleanup
        }
        continue;
      }

      try {
        renameSync(oldPath, newPath);
      } catch {
        // Best-effort: cross-device rename or permission issue
      }
    }
  },

  down(workspaceDir: string): void {
    const rootDir = getVellumRoot();

    for (const file of CONFIG_FILES) {
      const newPath = join(workspaceDir, file);
      const oldPath = join(rootDir, file);

      if (!existsSync(newPath)) continue;
      if (existsSync(oldPath)) {
        try {
          unlinkSync(newPath);
        } catch {
          // Best-effort cleanup
        }
        continue;
      }

      try {
        renameSync(newPath, oldPath);
      } catch {
        // Best-effort
      }
    }
  },
};
