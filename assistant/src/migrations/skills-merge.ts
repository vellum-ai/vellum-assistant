import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { migrationLog } from "./log.js";

/**
 * When migratePath skips the skills directory because the workspace copy
 * already exists (e.g. pre-created by ensureDataDir), the legacy skills
 * directory may still contain individual skill subdirectories that were
 * never moved. This merges any missing skill subdirectories from the
 * legacy path into the workspace skills path so they are not stranded.
 */
export function mergeLegacySkills(
  legacyDir: string,
  workspaceDir: string,
): void {
  if (!existsSync(legacyDir) || !existsSync(workspaceDir)) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = join(legacyDir, entry.name);
    const dest = join(workspaceDir, entry.name);
    if (existsSync(dest)) continue; // already present in workspace
    try {
      renameSync(src, dest);
      migrationLog("info", "Merged legacy skill into workspace", {
        from: src,
        to: dest,
      });
    } catch (err) {
      migrationLog("warn", "Failed to merge legacy skill", {
        err: String(err),
        from: src,
        to: dest,
      });
    }
  }
}
