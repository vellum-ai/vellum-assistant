import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
} from "../../memory/checkpoints.js";
import { getExternalAssistantId } from "../../runtime/auth/external-assistant-id.js";
import type { WorkspaceMigration } from "./types.js";

export const backfillInstallationIdMigration: WorkspaceMigration = {
  id: "010-backfill-installation-id",
  description:
    "Backfill installationId into lockfile from SQLite checkpoint and clean up stale row",
  run(_workspaceDir: string): void {
    // a. Read existing installation ID from SQLite, or generate a new one.
    //    On fresh installs the memory_checkpoints table may not exist yet,
    //    so treat errors as null.
    let existingId: string | null = null;
    try {
      existingId = getMemoryCheckpoint("telemetry:installation_id");
    } catch {
      // Table doesn't exist yet — fresh install, no prior ID to recover.
    }
    const installationId = existingId || randomUUID();

    // b. Read the lockfile — check both the current and legacy lockfile paths
    //    to support installs that haven't migrated the filename yet.
    const base = process.env.BASE_DATA_DIR?.trim() || homedir();
    const lockCandidates = [
      join(base, ".vellum.lock.json"),
      join(base, ".vellum.lockfile.json"),
    ];

    let lockPath: string | undefined;
    let lockData: Record<string, unknown> | undefined;
    for (const candidate of lockCandidates) {
      if (!existsSync(candidate)) continue;
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
    if (!lockPath || !lockData) return;

    // c. Find the assistant entry that corresponds to this daemon instance
    const assistants = lockData.assistants as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(assistants)) return;

    const externalId = getExternalAssistantId();
    const entry = assistants.find((a) => a.assistantId === externalId);
    if (!entry) return;

    // d. If already has a truthy installationId, skip lockfile write (idempotent)
    if (entry.installationId) {
      // e is skipped for lockfile write, but still clean up SQLite
      try {
        deleteMemoryCheckpoint("telemetry:installation_id");
      } catch {
        // Table doesn't exist — nothing to clean up.
      }
      return;
    }

    // e. Set installationId on the entry and write the lockfile back
    entry.installationId = installationId;
    writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n");

    // f. Delete the stale SQLite row
    try {
      deleteMemoryCheckpoint("telemetry:installation_id");
    } catch {
      // Table doesn't exist — nothing to clean up.
    }
  },
};
