import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, readTextFileSync } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

export type CheckpointFile = {
  applied: Record<
    string,
    { appliedAt: string; status?: "started" | "completed" }
  >;
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

export async function runWorkspaceMigrations(
  workspaceDir: string,
  migrations: WorkspaceMigration[],
): Promise<void> {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) {
      throw new Error(`Duplicate workspace migration id: "${m.id}"`);
    }
    seen.add(m.id);
  }

  const checkpoints = loadCheckpoints(workspaceDir);

  for (const [id, entry] of Object.entries(checkpoints.applied)) {
    if (entry.status === "started") {
      log.warn(
        `Workspace migration "${id}" was interrupted during a previous run; will re-run`,
      );
      delete checkpoints.applied[id];
    }
  }

  for (const migration of migrations) {
    if (checkpoints.applied[migration.id]) {
      continue;
    }

    log.info(
      `Running workspace migration: ${migration.id} — ${migration.description}`,
    );

    // Mark as started before execution (for crash recovery observability)
    checkpoints.applied[migration.id] = {
      appliedAt: new Date().toISOString(),
      status: "started",
    };
    saveCheckpoints(workspaceDir, checkpoints);

    try {
      await migration.run(workspaceDir);
    } catch (error) {
      log.error(
        { migrationId: migration.id, error },
        `Workspace migration failed: ${migration.id}`,
      );
      throw error;
    }

    // Mark as completed
    checkpoints.applied[migration.id] = {
      appliedAt: new Date().toISOString(),
      status: "completed",
    };
    saveCheckpoints(workspaceDir, checkpoints);
  }
}
