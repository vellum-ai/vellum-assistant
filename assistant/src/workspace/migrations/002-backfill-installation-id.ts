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
  id: "002-backfill-installation-id",
  description:
    "Backfill installationId into lockfile from SQLite checkpoint and clean up stale row",
  run(_workspaceDir: string): void {
    // a. Read existing installation ID from SQLite, or generate a new one
    const existingId = getMemoryCheckpoint("telemetry:installation_id");
    const installationId = existingId || randomUUID();

    // b. Read the lockfile from the standard path
    const base = process.env.BASE_DATA_DIR?.trim() || homedir();
    const lockPath = join(base, ".vellum.lock.json");
    if (!existsSync(lockPath)) return;

    let lockData: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      lockData = raw as Record<string, unknown>;
    } catch {
      return;
    }

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
      deleteMemoryCheckpoint("telemetry:installation_id");
      return;
    }

    // e. Set installationId on the entry and write the lockfile back
    entry.installationId = installationId;
    writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n");

    // f. Delete the stale SQLite row
    deleteMemoryCheckpoint("telemetry:installation_id");
  },
};
