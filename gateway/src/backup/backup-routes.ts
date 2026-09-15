/**
 * Gateway HTTP routes for backup operations.
 *
 * These routes are the guardian-facing API for backup management. The
 * assistant daemon has no backup CLI or routes — all backup operations
 * go through the gateway, which owns the encryption key and performs
 * the encrypt/decrypt operations.
 *
 * Routes:
 *   GET  /v1/backups        — list local + offsite snapshots
 *   POST /v1/backups/create — manual snapshot trigger
 */

import { readConfigFileOrEmpty } from "../config-file-utils.js";
import { getLogger } from "../logger.js";
import { listSnapshotsInDir, type SnapshotEntry } from "./list-snapshots.js";
import { getLocalBackupsDir } from "./paths.js";
import { createSnapshotNow } from "./backup-worker.js";

const log = getLogger("backup-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BackupDestination {
  path: string;
  encrypt: boolean;
}

function readBackupDestinations(): {
  localDir: string;
  offsiteDestinations: BackupDestination[];
} {
  const raw = readConfigFileOrEmpty();
  const backup = (raw.backup ?? {}) as Record<string, unknown>;

  const localDirectory =
    typeof backup.localDirectory === "string" ? backup.localDirectory : null;
  const localDir = getLocalBackupsDir(localDirectory);

  const offsiteRaw = (backup.offsite ?? {}) as Record<string, unknown>;
  const offsiteEnabled = offsiteRaw.enabled !== false;
  let offsiteDestinations: BackupDestination[] = [];

  if (offsiteEnabled) {
    if (Array.isArray(offsiteRaw.destinations)) {
      offsiteDestinations = offsiteRaw.destinations
        .filter(
          (d): d is { path: string; encrypt?: boolean } =>
            d &&
            typeof d === "object" &&
            typeof (d as Record<string, unknown>).path === "string",
        )
        .map((d) => ({ path: d.path, encrypt: d.encrypt !== false }));
    }
    // null destinations = iCloud default, but we don't list those unless
    // they already have snapshots on disk.
  }

  return { localDir, offsiteDestinations };
}

function snapshotToJson(entry: SnapshotEntry): Record<string, unknown> {
  return {
    path: entry.path,
    filename: entry.filename,
    created_at: entry.createdAt.toISOString(),
    size_bytes: entry.sizeBytes,
    encrypted: entry.encrypted,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

interface BackupRouteDeps {
  assistantRuntimeBaseUrl: string;
}

/**
 * GET /v1/backups — list local and offsite snapshots.
 */
export function createListBackupsHandler(_deps: BackupRouteDeps) {
  return async function handleListBackups(_req: Request): Promise<Response> {
    try {
      const { localDir, offsiteDestinations } = readBackupDestinations();

      const localSnapshots = await listSnapshotsInDir(localDir);
      const offsitePools: Array<{
        destination: BackupDestination;
        snapshots: SnapshotEntry[];
      }> = [];

      for (const dest of offsiteDestinations) {
        const snapshots = await listSnapshotsInDir(dest.path);
        offsitePools.push({ destination: dest, snapshots });
      }

      return Response.json({
        local: {
          directory: localDir,
          snapshots: localSnapshots.map(snapshotToJson),
        },
        offsite: offsitePools.map((pool) => ({
          directory: pool.destination.path,
          encrypted: pool.destination.encrypt,
          snapshots: pool.snapshots.map(snapshotToJson),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Failed to list backups");
      return Response.json(
        { error: "Internal Server Error", message },
        { status: 500 },
      );
    }
  };
}

/**
 * POST /v1/backups/create — manual snapshot trigger.
 */
export function createBackupSnapshotHandler(deps: BackupRouteDeps) {
  return async function handleCreateBackup(_req: Request): Promise<Response> {
    try {
      const result = await createSnapshotNow(deps);

      return Response.json({
        success: true,
        local: snapshotToJson(result.local),
        offsite: result.offsite.map((r) => ({
          destination: r.destination.path,
          status: r.entry ? "ok" : r.skipped ? "skipped" : "error",
          entry: r.entry ? snapshotToJson(r.entry) : null,
          error: r.error ?? null,
        })),
        duration_ms: result.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Manual backup snapshot failed");

      if (message.includes("already in progress")) {
        return Response.json(
          { error: "Conflict", message: "A backup snapshot is already in progress" },
          { status: 409 },
        );
      }

      return Response.json(
        { error: "Internal Server Error", message },
        { status: 500 },
      );
    }
  };
}
