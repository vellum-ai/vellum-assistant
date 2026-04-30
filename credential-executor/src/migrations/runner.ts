import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { getLogger } from "../logger.js";
import type { CesMigration, CesMigrationStatus } from "./types.js";

const log = getLogger("ces-migrations");

// ---------------------------------------------------------------------------
// Checkpoint file
// ---------------------------------------------------------------------------

type CheckpointFile = {
  applied: Record<string, { appliedAt: string; status?: CesMigrationStatus }>;
};

function getCheckpointPath(cesDataRoot: string): string {
  return join(cesDataRoot, ".ces-migrations.json");
}

function loadCheckpoints(cesDataRoot: string): CheckpointFile {
  const path = getCheckpointPath(cesDataRoot);
  if (!existsSync(path)) {
    return { applied: {} };
  }
  try {
    const raw = readFileSync(path, "utf-8");
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
      "CES migration checkpoint file has unexpected structure; treating as fresh state",
    );
  } catch {
    log.warn(
      "CES migration checkpoint file is malformed; treating as fresh state",
    );
  }
  return { applied: {} };
}

function saveCheckpoints(
  cesDataRoot: string,
  checkpoints: CheckpointFile,
): void {
  const path = getCheckpointPath(cesDataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(checkpoints, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run all pending CES migrations in registry order.
 *
 * - Skips migrations that already have a checkpoint entry (`"completed"` or
 *   `"failed"`). Only `"started"` and `"rolling_back"` entries are cleared
 *   and re-run (crash recovery — migrations must be idempotent).
 * - Re-runs any migration whose checkpoint is `"started"` or
 *   `"rolling_back"` (crash recovery — migrations must be idempotent).
 * - Marks failed migrations as `"failed"` and continues startup; a failed
 *   migration does not block the RPC server from starting.
 *
 * @param cesDataRoot  The CES-private data root (from `getCesDataRoot(mode)`).
 *   The checkpoint file is stored here as `.ces-migrations.json`.
 * @param backend  The active `SecureKeyBackend` instance, passed directly to
 *   each migration's `run()` function.
 * @param migrations  Ordered list of migrations from the registry.
 */
export async function runCesMigrations(
  cesDataRoot: string,
  backend: SecureKeyBackend,
  migrations: CesMigration[],
): Promise<void> {
  // Validate uniqueness.
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) {
      throw new Error(`Duplicate CES migration id: "${m.id}"`);
    }
    seen.add(m.id);
  }

  const checkpoints = loadCheckpoints(cesDataRoot);

  // Clear any interrupted checkpoints so they re-run.
  for (const [id, entry] of Object.entries(checkpoints.applied)) {
    if (entry.status === "started" || entry.status === "rolling_back") {
      log.warn(
        `CES migration "${id}" was interrupted during a previous run; will re-run`,
      );
      delete checkpoints.applied[id];
    }
  }

  for (const migration of migrations) {
    if (checkpoints.applied[migration.id]?.status === "completed") {
      continue;
    }

    log.info(
      `Running CES migration: ${migration.id} — ${migration.description}`,
    );

    // Mark as started before executing (crash recovery observability).
    checkpoints.applied[migration.id] = {
      appliedAt: new Date().toISOString(),
      status: "started",
    };
    saveCheckpoints(cesDataRoot, checkpoints);

    try {
      await migration.run(backend);
    } catch (error) {
      log.error(
        { migrationId: migration.id, error },
        `CES migration failed: ${migration.id} — marking as failed and continuing`,
      );
      checkpoints.applied[migration.id] = {
        appliedAt: new Date().toISOString(),
        status: "failed",
      };
      saveCheckpoints(cesDataRoot, checkpoints);
      continue;
    }

    checkpoints.applied[migration.id] = {
      appliedAt: new Date().toISOString(),
      status: "completed",
    };
    saveCheckpoints(cesDataRoot, checkpoints);

    log.info(`CES migration completed: ${migration.id}`);
  }
}
