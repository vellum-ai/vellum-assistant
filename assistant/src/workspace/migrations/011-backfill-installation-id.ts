import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

const INSTALLATION_ID_CHECKPOINT_KEY = "telemetry:installation_id";

/**
 * Open the assistant SQLite database read-write, or return null when it does
 * not exist yet (fresh install) or cannot be opened. The path mirrors
 * getDbPath(): `<workspace>/data/db/assistant.db`.
 */
function openAssistantDb(workspaceDir: string): Database | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    return new Database(dbPath);
  } catch {
    return null;
  }
}

/**
 * Read the persisted installation ID from the `memory_checkpoints` table.
 * Returns null when the database, table, or row is absent — a fresh install
 * has no prior ID to recover. Never throws.
 */
function readInstallationIdCheckpoint(workspaceDir: string): string | null {
  const db = openAssistantDb(workspaceDir);
  if (!db) {
    return null;
  }
  try {
    const row = db
      .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
      .get(INSTALLATION_ID_CHECKPOINT_KEY) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Delete the installation-ID checkpoint row. Idempotent and never throws — a
 * missing table or row is a successful no-op.
 */
function deleteInstallationIdCheckpoint(workspaceDir: string): void {
  const db = openAssistantDb(workspaceDir);
  if (!db) {
    return;
  }
  try {
    db.query(`DELETE FROM memory_checkpoints WHERE key = ?`).run(
      INSTALLATION_ID_CHECKPOINT_KEY,
    );
  } catch {
    // Table doesn't exist — nothing to clean up.
  } finally {
    db.close();
  }
}

export const backfillInstallationIdMigration: WorkspaceMigration = {
  id: "011-backfill-installation-id",
  description:
    "Backfill installationId into lockfile from SQLite checkpoint and clean up stale row",

  down(_workspaceDir: string): void {
    // The forward migration moved an installationId from a SQLite checkpoint
    // into the lockfile entry. Rolling back by removing installationId from
    // the lockfile would break telemetry continuity and the field is harmless
    // to leave in place. The SQLite checkpoint was already deleted and
    // cannot be restored.
    //
    // No-op: leaving installationId in the lockfile is safe and non-disruptive.
  },

  run(workspaceDir: string): void {
    // a. Read existing installation ID from SQLite, or generate a new one.
    const installationId =
      readInstallationIdCheckpoint(workspaceDir) || randomUUID();

    // b. Read the lockfile — check both the current and legacy lockfile paths
    //    to support installs that haven't migrated the filename yet.
    //    Always reads from homedir(), matching resolveInstanceDataDir() in
    //    platform.ts — the lockfile is a per-user file, not per-instance.
    const home = homedir();
    const lockCandidates = [
      join(home, ".vellum.lock.json"),
      join(home, ".vellum.lockfile.json"),
    ];

    let lockPath: string | undefined;
    let lockData: Record<string, unknown> | undefined;
    for (const candidate of lockCandidates) {
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          lockPath = candidate;
          lockData = raw as Record<string, unknown>;
          break;
        }
      } catch {
        // Malformed — try next candidate.
      }
    }
    if (!lockPath || !lockData) {
      return;
    }

    // c. Find the assistant entry that corresponds to this daemon instance.
    //    The external assistant ID comes from the VELLUM_ASSISTANT_NAME env
    //    var, set by CLI hatch and Docker setup.
    const assistants = lockData.assistants as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(assistants)) {
      return;
    }

    const externalId = process.env.VELLUM_ASSISTANT_NAME || undefined;
    const entry = assistants.find((a) => a.assistantId === externalId);
    if (!entry) {
      return;
    }

    // d. If already has a truthy installationId, skip lockfile write (idempotent)
    if (entry.installationId) {
      // e is skipped for lockfile write, but still clean up SQLite
      deleteInstallationIdCheckpoint(workspaceDir);
      return;
    }

    // e. Set installationId on the entry and write the lockfile back
    entry.installationId = installationId;
    writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n");

    // f. Delete the stale SQLite row
    deleteInstallationIdCheckpoint(workspaceDir);
  },
};
