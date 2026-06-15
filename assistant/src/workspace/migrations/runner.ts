import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, readTextFileSync } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import type {
  MigrationRunContext,
  WorkspaceMigration,
  WorkspaceMigrationStatus,
} from "./types.js";

const log = getLogger("workspace-migrations");

export function getLastWorkspaceMigrationId(
  migrations: WorkspaceMigration[],
): string | null {
  return migrations.length > 0 ? migrations[migrations.length - 1].id : null;
}

export type CheckpointFile = {
  applied: Record<
    string,
    { appliedAt: string; status?: WorkspaceMigrationStatus }
  >;
  /** Persisted "fresh workspace" flag. Set to `true` by the runner when the
   *  checkpoint file is being created for the first time; cleared after the
   *  initial migration sweep finishes. Survives crashes mid-first-boot so
   *  seeding migrations that fall later in the sequence still observe the
   *  brand-new state. Absent on workspaces that pre-date this field — those
   *  are treated as not-new. */
  isNewWorkspace?: boolean;
};

function getCheckpointPath(workspaceDir: string): string {
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

function saveCheckpoints(
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
  const migrationsById = new Map<string, WorkspaceMigration>();
  for (const m of migrations) {
    if (migrationsById.has(m.id)) {
      throw new Error(`Duplicate workspace migration id: "${m.id}"`);
    }
    migrationsById.set(m.id, m);
  }

  // The checkpoint file is written *before* each migration's run() (to record
  // the "started" status), so file-absence alone cannot be used to detect a
  // brand-new workspace — a crash mid-first-boot would flip the next boot's
  // verdict to "upgrade" before later seeding migrations have run. Persist
  // the flag inside the file instead so it survives across reboots.
  const checkpointExisted =
    readTextFileSync(getCheckpointPath(workspaceDir)) != null;
  const checkpoints = loadCheckpoints(workspaceDir);
  if (!checkpointExisted) {
    checkpoints.isNewWorkspace = true;
  }
  const ctx: MigrationRunContext = {
    isNewWorkspace: checkpoints.isNewWorkspace === true,
  };

  for (const [id, entry] of Object.entries(checkpoints.applied)) {
    if (entry.status === "started" || entry.status === "rolling_back") {
      log.warn(
        `Workspace migration "${id}" was interrupted during a previous run; will re-run`,
      );
      delete checkpoints.applied[id];
    } else if (
      entry.status === "failed" &&
      migrationsById.get(id)?.retryFailedCheckpoint === true
    ) {
      log.warn(
        `Workspace migration "${id}" failed during a previous run; will retry`,
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
      await migration.run(workspaceDir, ctx);
    } catch (error) {
      log.error(
        { migrationId: migration.id, error },
        `Workspace migration failed: ${migration.id} — marking as failed and continuing`,
      );
      checkpoints.applied[migration.id] = {
        appliedAt: new Date().toISOString(),
        status: "failed",
      };
      saveCheckpoints(workspaceDir, checkpoints);
      continue;
    }

    // Mark as completed
    checkpoints.applied[migration.id] = {
      appliedAt: new Date().toISOString(),
      status: "completed",
    };
    saveCheckpoints(workspaceDir, checkpoints);
  }

  // First-boot sweep finished cleanly — clear the flag so future runs (and
  // future seeding migrations added later) treat the workspace as an upgrade.
  // A crash above this point leaves the flag set, so the retry on the next
  // boot still observes a fresh workspace.
  if (checkpoints.isNewWorkspace === true) {
    checkpoints.isNewWorkspace = false;
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
 * **Warning — data loss**: Every workspace migration must define a `down()`
 * method (enforced at the type level), but some rollbacks are lossy (e.g.,
 * file deletions or format conversions that discard the original cannot fully
 * restore prior state). Review each migration's `down()` implementation
 * before calling this function.
 *
 * **Important**: Stop the assistant before running rollbacks. Rolling back
 * workspace migrations while the assistant is running may cause file conflicts,
 * stale caches, or data corruption.
 *
 * @param workspaceDir  The workspace directory path (e.g., `$VELLUM_WORKSPACE_DIR`).
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
    // Only roll back migrations that have been fully applied.
    // Legacy checkpoints may not have a status field (just appliedAt) — treat
    // missing/undefined status as completed, matching runWorkspaceMigrations behavior.
    const entry = checkpoints.applied[migration.id];
    if (
      !entry ||
      entry.status === "started" ||
      entry.status === "rolling_back"
    ) {
      continue;
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
        `Workspace migration rollback failed: ${migration.id} — marking as failed and continuing`,
      );
      checkpoints.applied[migration.id] = {
        appliedAt: checkpoints.applied[migration.id]!.appliedAt,
        status: "failed",
      };
      saveCheckpoints(workspaceDir, checkpoints);
      continue;
    }

    // Remove the migration entry from checkpoints
    delete checkpoints.applied[migration.id];
    saveCheckpoints(workspaceDir, checkpoints);

    log.info(`Rolled back workspace migration: ${migration.id}`);
  }
}
