import * as fs from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-068-remove-legacy-skills-index");

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

export const removeLegacySkillsIndexMigration: WorkspaceMigration = {
  id: "068-remove-legacy-skills-index",
  description: "Remove legacy workspace skills/SKILLS.md index file",
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    const indexPath = join(workspaceDir, "skills", "SKILLS.md");

    try {
      const stat = fs.lstatSync(indexPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        log.warn(
          { path: indexPath },
          "Legacy SKILLS.md path is not a file; leaving it in place",
        );
        return;
      }

      fs.unlinkSync(indexPath);
      log.info({ path: indexPath }, "Removed legacy skills index file");
    } catch (err) {
      if (isNotFoundError(err)) return;
      log.warn(
        { err, path: indexPath },
        "Failed to remove legacy skills index file",
      );
      throw err;
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: SKILLS.md is no longer a supported skill catalog format.
  },
};
