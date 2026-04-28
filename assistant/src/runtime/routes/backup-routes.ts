/**
 * Route handlers for the backup/restore endpoints.
 *
 * GET  /v1/backups             — list local + offsite snapshots
 * POST /v1/backups/create      — manual snapshot trigger (bypasses schedule gates)
 * POST /v1/backups/restore     — restore a snapshot into the workspace
 * POST /v1/backups/verify      — verify a snapshot without restoring
 *
 * The list endpoint reports a per-destination `reachable` flag so callers can
 * render offsite status (e.g. iCloud Drive enabled / external volume mounted)
 * without probing each path themselves.
 *
 * Restore and verify accept a `path` pointing at a concrete snapshot file. The
 * path must resolve (via `realpath`) to somewhere inside the configured local
 * or offsite backup directories — this prevents a caller from coaxing the
 * daemon into restoring an arbitrary file via a symlink escape.
 *
 * The backup decryption key is only loaded when the target file is a
 * `.vbundle.enc` (encrypted) bundle. Plaintext `.vbundle` files never touch
 * the key material, which means plaintext-only installs never create the
 * key file as a side effect of list/restore/verify.
 */

import { promises as fs } from "node:fs";
import { dirname, sep } from "node:path";

import { z } from "zod";

import { readBackupKey } from "../../backup/backup-key.js";
import {
  type BackupRunResult,
  createSnapshotNow,
} from "../../backup/backup-worker.js";
import {
  listSnapshotsInDir,
  type SnapshotEntry,
} from "../../backup/list-snapshots.js";
import {
  getBackupKeyPath,
  getLocalBackupsDir,
  resolveOffsiteDestinations,
} from "../../backup/paths.js";
import { restoreFromSnapshot, verifySnapshot } from "../../backup/restore.js";
import { getConfig, invalidateConfigCache } from "../../config/loader.js";
import type { BackupDestination } from "../../config/schema.js";
import { getMemoryCheckpoint } from "../../memory/checkpoints.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir, getWorkspaceHooksDir } from "../../util/platform.js";
import { DefaultPathResolver } from "../migrations/vbundle-import-analyzer.js";
import { BadRequestError, ConflictError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("backup-routes");

/** Memory checkpoint key for the last successful backup run (milliseconds). */
const LAST_RUN_CHECKPOINT_KEY = "backup:last_run_at";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

function computeAllowedRoots(): string[] {
  const config = getConfig();
  const roots: string[] = [getLocalBackupsDir(config.backup.localDirectory)];
  for (const dest of resolveOffsiteDestinations(
    config.backup.offsite.destinations,
  )) {
    roots.push(dest.path);
  }
  return roots;
}

/**
 * Resolve a caller-supplied snapshot path against the allowed roots.
 * Throws BadRequestError if the path is missing, outside every root,
 * or a symlink that escapes.
 */
async function validateSnapshotPath(rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new BadRequestError(
      "Request body must include a non-empty `path` field",
    );
  }

  const realCandidate = await safeRealpath(rawPath);
  if (realCandidate == null) {
    throw new BadRequestError(`Snapshot path does not exist: ${rawPath}`);
  }

  const allowedRoots = computeAllowedRoots();
  for (const root of allowedRoots) {
    const realRoot = await safeRealpath(root);
    if (realRoot == null) continue;
    if (isInside(realCandidate, realRoot)) {
      return realCandidate;
    }
  }

  throw new BadRequestError(
    "Snapshot path is outside the configured backup directories",
  );
}

/**
 * Load the backup decryption key iff the target snapshot is encrypted.
 * Returns null for plaintext bundles. Throws BadRequestError when an
 * encrypted bundle is supplied but no key file exists.
 */
async function loadKeyIfEncrypted(
  snapshotPath: string,
): Promise<Buffer | null> {
  if (!snapshotPath.endsWith(".vbundle.enc")) {
    return null;
  }
  const key = await readBackupKey(getBackupKeyPath());
  if (key == null) {
    throw new BadRequestError(
      "Encrypted snapshot requires a backup key, but backup.key is missing",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface BackupListResponse {
  local: SnapshotEntry[];
  offsite: Array<{
    destination: BackupDestination;
    snapshots: SnapshotEntry[];
    reachable: boolean;
  }>;
  offsiteEnabled: boolean;
  nextRunAt: string | null;
}

export async function handleBackupList(): Promise<BackupListResponse> {
  const config = getConfig();
  const localDir = getLocalBackupsDir(config.backup.localDirectory);
  const local = await listSnapshotsInDir(localDir);

  const offsiteEnabled = config.backup.offsite.enabled;
  const offsite: BackupListResponse["offsite"] = [];
  if (offsiteEnabled) {
    for (const destination of resolveOffsiteDestinations(
      config.backup.offsite.destinations,
    )) {
      let reachable = false;
      try {
        await fs.stat(dirname(destination.path));
        reachable = true;
      } catch {
        reachable = false;
      }
      const snapshots = reachable
        ? await listSnapshotsInDir(destination.path)
        : [];
      offsite.push({ destination, snapshots, reachable });
    }
  }

  let nextRunAt: string | null = null;
  if (config.backup.enabled) {
    const lastRunRaw = getMemoryCheckpoint(LAST_RUN_CHECKPOINT_KEY);
    if (lastRunRaw != null) {
      const lastRunMs = Number.parseInt(lastRunRaw, 10);
      if (!Number.isNaN(lastRunMs)) {
        const intervalMs = config.backup.intervalHours * 3600 * 1000;
        nextRunAt = new Date(lastRunMs + intervalMs).toISOString();
      }
    }
  }

  return { local, offsite, offsiteEnabled, nextRunAt };
}

export async function handleBackupCreate(): Promise<BackupRunResult> {
  try {
    const config = getConfig();
    return await createSnapshotNow(config.backup, new Date());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("snapshot in progress")) {
      throw new ConflictError("A snapshot is already in progress");
    }
    log.error({ err }, "Manual backup snapshot failed");
    throw new RouteError(message, "INTERNAL_ERROR", 500);
  }
}

export async function handleBackupRestore({ body }: RouteHandlerArgs) {
  const path = body?.path;
  const snapshotPath = await validateSnapshotPath(path);
  const key = await loadKeyIfEncrypted(snapshotPath);

  try {
    const pathResolver = new DefaultPathResolver(
      getWorkspaceDir(),
      getWorkspaceHooksDir(),
    );

    const result = await restoreFromSnapshot(snapshotPath, {
      key: key ?? undefined,
      pathResolver,
      workspaceDir: getWorkspaceDir(),
    });

    invalidateConfigCache();

    return {
      manifest: result.manifest,
      restoredFiles: result.restoredFiles,
    };
  } catch (err) {
    log.error({ err, snapshotPath }, "Snapshot restore failed");
    throw new RouteError(
      err instanceof Error ? err.message : "Snapshot restore failed",
      "INTERNAL_ERROR",
      500,
    );
  }
}

export async function handleBackupVerify({ body }: RouteHandlerArgs) {
  const path = body?.path;
  const snapshotPath = await validateSnapshotPath(path);
  const key = await loadKeyIfEncrypted(snapshotPath);

  try {
    return await verifySnapshot(snapshotPath, {
      key: key ?? undefined,
    });
  } catch (err) {
    log.error({ err, snapshotPath }, "Snapshot verification failed");
    throw new RouteError(
      err instanceof Error ? err.message : "Snapshot verification failed",
      "INTERNAL_ERROR",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "backups_list",
    endpoint: "backups",
    method: "GET",
    handler: handleBackupList,
    summary: "List backup snapshots",
    description:
      "Lists local and offsite backup snapshots. Each offsite destination includes a `reachable` flag reflecting whether the backing volume is currently available. When `backup.offsite.enabled` is false the `offsite` array is empty and `offsiteEnabled` is false — clients should gate offsite UI on `offsiteEnabled` rather than `offsite.length`.",
    tags: ["backups"],
    responseBody: z.object({
      local: z.array(z.unknown()),
      offsite: z.array(
        z.object({
          destination: z.object({}).passthrough(),
          snapshots: z.array(z.unknown()),
          reachable: z.boolean(),
        }),
      ),
      offsiteEnabled: z.boolean(),
      nextRunAt: z.string().nullable(),
    }),
  },
  {
    operationId: "backups_create",
    endpoint: "backups/create",
    method: "POST",
    handler: handleBackupCreate,
    summary: "Create a backup snapshot immediately",
    description:
      "Trigger a manual snapshot. Bypasses the enabled and interval gates, but honors the in-progress mutex — a concurrent caller receives 409.",
    tags: ["backups"],
    responseBody: z.object({
      local: z.object({}).passthrough(),
      offsite: z.array(z.unknown()),
      durationMs: z.number(),
    }),
  },
  {
    operationId: "backups_restore",
    endpoint: "backups/restore",
    method: "POST",
    handler: handleBackupRestore,
    summary: "Restore from a backup snapshot",
    description:
      "Restores a snapshot into the workspace. Destructive: the underlying commit flow backs up existing files before overwriting. The daemon closes the live SQLite handle before writing and invalidates its config/trust caches afterwards. Credentials are NOT included — users re-authenticate integrations after a restore.",
    tags: ["backups"],
    requestBody: z.object({
      path: z
        .string()
        .describe("Absolute path to the snapshot file to restore"),
    }),
    responseBody: z.object({
      manifest: z.object({}).passthrough(),
      restoredFiles: z.number(),
    }),
  },
  {
    operationId: "backups_verify",
    endpoint: "backups/verify",
    method: "POST",
    handler: handleBackupVerify,
    summary: "Verify a backup snapshot",
    description:
      "Validates a snapshot without restoring. Decrypts encrypted bundles to a temp file, runs the vbundle validator, and returns a pass/fail status.",
    tags: ["backups"],
    requestBody: z.object({
      path: z.string().describe("Absolute path to the snapshot file to verify"),
    }),
    responseBody: z.object({
      valid: z.boolean(),
      manifest: z.object({}).passthrough().optional(),
      error: z.string().optional(),
    }),
  },
];
