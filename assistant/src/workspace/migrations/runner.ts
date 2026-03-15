import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, readTextFileSync } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

export type CheckpointFile = {
  applied: Record<string, { appliedAt: string }>;
};

export function getCheckpointPath(workspaceDir: string): string {
  return join(workspaceDir, "data", ".workspace-migrations.json");
}

export function loadCheckpoints(workspaceDir: string): CheckpointFile {
  const path = getCheckpointPath(workspaceDir);
  const raw = readTextFileSync(path);
  if (raw == null) {
    return { applied: {} };
  }
  try {
    const data = JSON.parse(raw);
    if (
      typeof data === "object" &&
      data != null &&
      typeof data.applied === "object" &&
      data.applied != null
    ) {
      return data as CheckpointFile;
    }
    log.warn(
      "Workspace migration checkpoint file has unexpected structure; treating as fresh state",
    );
    return { applied: {} };
  } catch {
    log.warn(
      "Workspace migration checkpoint file is malformed; treating as fresh state",
    );
    return { applied: {} };
  }
}

export function saveCheckpoints(
  workspaceDir: string,
  checkpoints: CheckpointFile,
): void {
  const path = getCheckpointPath(workspaceDir);
  const dir = dirname(path);
  ensureDir(dir);
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(checkpoints, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function runWorkspaceMigrations(
  workspaceDir: string,
  migrations: WorkspaceMigration[],
): void {
  const checkpoints = loadCheckpoints(workspaceDir);

  for (const migration of migrations) {
    if (checkpoints.applied[migration.id]) {
      continue;
    }

    log.info(
      `Running workspace migration: ${migration.id} — ${migration.description}`,
    );

    try {
      migration.run(workspaceDir);
    } catch (error) {
      log.error(
        { migrationId: migration.id, error },
        `Workspace migration failed: ${migration.id}`,
      );
      throw error;
    }

    checkpoints.applied[migration.id] = {
      appliedAt: new Date().toISOString(),
    };
    saveCheckpoints(workspaceDir, checkpoints);
  }
}
