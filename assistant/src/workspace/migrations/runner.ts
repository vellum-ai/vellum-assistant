import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, readTextFileSync } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

export type CheckpointFile = {
  applied: Record<
    string,
    { appliedAt: string; status?: "started" | "completed" | "rolling_back" }
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
    if (entry.status === "started" || entry.status === "rolling_back") {
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

/**
 * Roll back workspace (filesystem) migrations in reverse order, stopping before
 * the target migration.
 *
 * Migrations after `targetMigrationId` in the registry array are reversed in
 * reverse order; the target migration itself is kept applied.
 *
 * **Usage**: Pass the full migrations array (typically `WORKSPACE_MIGRATIONS`
 * from `registry.ts`) and the ID of the migration you want to roll back *to*.
 * For example, `rollbackWorkspaceMigrations(dir, migrations, "010-app-dir-rename")`
 * rolls back all applied migrations that appear after `010-app-dir-rename` in
 * the registry.
 *
 * **Checkpoint state**: Each rolled-back migration's entry is deleted from the
 * `.workspace-migrations.json` checkpoint file. If the process crashes
 * mid-rollback, the `"rolling_back"` marker is detected and cleared by
 * `runWorkspaceMigrations` on the next startup (it re-runs interrupted
 * migrations).
 *
 * **Warning — data loss**: Some workspace migrations are irreversible (e.g.,
 * file deletions, format conversions that discard the original). These
 * migrations do not define a `down()` method and will throw an error if
 * rollback is attempted. Always verify that all target migrations have `down()`
 * support before calling this function.
 *
 * **Important**: Stop the assistant before running rollbacks. Rolling back
 * workspace migrations while the assistant is running may cause file conflicts,
 * stale caches, or data corruption.
 *
 * @param workspaceDir  The workspace directory path (e.g., `~/.vellum/workspace`).
 * @param migrations  The full ordered array of workspace migrations (from `WORKSPACE_MIGRATIONS`).
 * @param targetMigrationId  The migration ID to roll back to (exclusive — all
 *   migrations after this one are reversed).
 */
export async function rollbackWorkspaceMigrations(
  workspaceDir: string,
  migrations: WorkspaceMigration[],
  targetMigrationId: string,
): Promise<void> {
  // Find the index of the target migration
  const targetIndex = migrations.findIndex((m) => m.id === targetMigrationId);
  if (targetIndex === -1) {
    throw new Error(
      `Target migration "${targetMigrationId}" not found in the migrations array`,
    );
  }

  // Collect migrations that come after the target, in reverse order
  const migrationsToRollback = migrations.slice(targetIndex + 1).reverse();
  if (migrationsToRollback.length === 0) {
    log.info("No migrations to roll back");
    return;
  }

  const checkpoints = loadCheckpoints(workspaceDir);

  for (const migration of migrationsToRollback) {
    // Only roll back migrations that have been applied
    if (!checkpoints.applied[migration.id]) {
      continue;
    }

    if (!migration.down) {
      throw new Error(
        `Migration "${migration.id}" does not support rollback (no down() method)`,
      );
    }

    log.info(
      `Rolling back workspace migration: ${migration.id} — ${migration.description}`,
    );

    // Mark as rolling_back before execution (for crash recovery)
    checkpoints.applied[migration.id] = {
      appliedAt: checkpoints.applied[migration.id]!.appliedAt,
      status: "rolling_back",
    };
    saveCheckpoints(workspaceDir, checkpoints);

    try {
      await migration.down(workspaceDir);
    } catch (error) {
      log.error(
        { migrationId: migration.id, error },
        `Workspace migration rollback failed: ${migration.id}`,
      );
      throw error;
    }

    // Remove the migration entry from checkpoints
    delete checkpoints.applied[migration.id];
    saveCheckpoints(workspaceDir, checkpoints);

    log.info(`Rolled back workspace migration: ${migration.id}`);
  }
}
