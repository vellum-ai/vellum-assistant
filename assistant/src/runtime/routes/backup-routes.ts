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
import { getConfig } from "../../config/loader.js";
import type { BackupDestination } from "../../config/schema.js";
import { getMemoryCheckpoint } from "../../memory/checkpoints.js";
import { getLogger } from "../../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspaceHooksDir,
} from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { DefaultPathResolver } from "../migrations/vbundle-import-analyzer.js";

const log = getLogger("backup-routes");

/** Memory checkpoint key for the last successful backup run (milliseconds). */
const LAST_RUN_CHECKPOINT_KEY = "backup:last_run_at";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an absolute path via `realpath`, following symlinks. Returns `null`
 * when the path does not exist or any component is missing. Callers that need
 * to distinguish missing-file from other errors should check separately.
 */
async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

/**
 * Check whether `candidate` is contained inside `root`. Containment is
 * inclusive of `root` itself (so `root === candidate` is accepted) and uses
 * the platform path separator so a root of `/a` doesn't accidentally match
 * `/a-evil/`. Callers must pass already-realpath'd inputs.
 */
function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

/**
 * Build the list of absolute directories a restore/verify target is allowed
 * to live inside. Includes the local backups directory plus every configured
 * offsite destination (after resolving the null → iCloud default).
 */
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
 * Resolve a caller-supplied snapshot path against the allowed roots. Returns
 * the realpath'd candidate on success, or an `Response` error envelope if the
 * path is missing, outside every root, or a symlink that escapes.
 *
 * Symlink handling: we realpath both the candidate and every root, then
 * compare. A symlink inside an allowed root pointing at `/etc/passwd` would
 * be caught here because `realpath(candidate)` returns `/etc/passwd` which
 * is not inside any allowed root.
 */
async function validateSnapshotPath(
  rawPath: unknown,
): Promise<{ path: string } | { error: Response }> {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return {
      error: httpError(
        "BAD_REQUEST",
        "Request body must include a non-empty `path` field",
        400,
      ),
    };
  }

  const realCandidate = await safeRealpath(rawPath);
  if (realCandidate == null) {
    return {
      error: httpError(
        "BAD_REQUEST",
        `Snapshot path does not exist: ${rawPath}`,
        400,
      ),
    };
  }

  const allowedRoots = computeAllowedRoots();
  for (const root of allowedRoots) {
    const realRoot = await safeRealpath(root);
    if (realRoot == null) continue;
    if (isInside(realCandidate, realRoot)) {
      return { path: realCandidate };
    }
  }

  return {
    error: httpError(
      "BAD_REQUEST",
      "Snapshot path is outside the configured backup directories",
      400,
    ),
  };
}

/**
 * Load the backup decryption key iff the target snapshot is encrypted. Returns
 * `{ key: null }` for plaintext bundles without touching the filesystem.
 * Returns `{ error }` with a clear 400 envelope when an encrypted bundle is
 * supplied but no key file exists (an unrecoverable user-facing state that
 * should not silently 500).
 */
async function loadKeyIfEncrypted(
  snapshotPath: string,
): Promise<{ key: Buffer | null } | { error: Response }> {
  if (!snapshotPath.endsWith(".vbundle.enc")) {
    return { key: null };
  }
  const key = await readBackupKey(getBackupKeyPath());
  if (key == null) {
    return {
      error: httpError(
        "BAD_REQUEST",
        "Encrypted snapshot requires a backup key, but backup.key is missing",
        400,
      ),
    };
  }
  return { key };
}

// ---------------------------------------------------------------------------
// GET /v1/backups
// ---------------------------------------------------------------------------

/**
 * Shape returned by {@link handleBackupList}. Exported so client code (and
 * the test suite) can type the JSON response without re-deriving it.
 */
export interface BackupListResponse {
  local: SnapshotEntry[];
  offsite: Array<{
    destination: BackupDestination;
    snapshots: SnapshotEntry[];
    reachable: boolean;
  }>;
  nextRunAt: string | null;
}

/**
 * List all known backup snapshots — local and every configured offsite
 * destination — along with scheduling metadata. Per-destination `reachable`
 * reflects whether `dirname(destination.path)` exists on disk right now (the
 * same probe the offsite writer uses), so clients can distinguish "empty
 * destination" from "unavailable destination" without a second round trip.
 */
export async function handleBackupList(_req: Request): Promise<Response> {
  try {
    const config = getConfig();
    const localDir = getLocalBackupsDir(config.backup.localDirectory);
    const local = await listSnapshotsInDir(localDir);

    const offsite: BackupListResponse["offsite"] = [];
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

    const body: BackupListResponse = { local, offsite, nextRunAt };
    return Response.json(body);
  } catch (err) {
    log.error({ err }, "Failed to list backups");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Failed to list backups",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// POST /v1/backups/create
// ---------------------------------------------------------------------------

/**
 * Trigger a manual backup snapshot immediately. This bypasses both the
 * `backup.enabled` flag and the interval gate, but still honors the
 * snapshot-in-progress mutex: a concurrent caller receives a 409.
 *
 * On success, returns the full `BackupRunResult` so the client can render
 * per-destination outcomes without re-listing.
 */
export async function handleBackupCreate(_req: Request): Promise<Response> {
  try {
    const config = getConfig();
    const result: BackupRunResult = await createSnapshotNow(
      config.backup,
      new Date(),
    );
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Map the mutex rejection to 409 so clients can distinguish "try again
    // later" from a real failure. Matches both the in-process variant
    // (`"snapshot in progress"`) and the cross-process file-lock variant
    // (`"snapshot in progress (locked by pid N)"`).
    if (message.startsWith("snapshot in progress")) {
      return httpError("CONFLICT", "A snapshot is already in progress", 409);
    }
    log.error({ err }, "Manual backup snapshot failed");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/backups/restore
// ---------------------------------------------------------------------------

interface RestoreRequestBody {
  path: unknown;
  includeCredentials?: unknown;
}

/**
 * Restore a snapshot into the live workspace. Destructive: the underlying
 * `commitImport` flow backs up existing files before overwriting, but callers
 * should still treat this as an irreversible "replace the workspace" operation.
 *
 * `includeCredentials` defaults to `false`; when true, credential entries from
 * the bundle are returned to the caller alongside the manifest summary so they
 * can be re-persisted via the separate credential-import path.
 */
export async function handleBackupRestore(req: Request): Promise<Response> {
  let body: RestoreRequestBody;
  try {
    body = (await req.json()) as RestoreRequestBody;
  } catch {
    return httpError(
      "BAD_REQUEST",
      "Request body must be valid JSON with a `path` field",
      400,
    );
  }

  const validated = await validateSnapshotPath(body.path);
  if ("error" in validated) return validated.error;
  const snapshotPath = validated.path;

  const keyResult = await loadKeyIfEncrypted(snapshotPath);
  if ("error" in keyResult) return keyResult.error;

  try {
    const pathResolver = new DefaultPathResolver(
      getWorkspaceDir(),
      getWorkspaceHooksDir(),
    );
    const result = await restoreFromSnapshot(snapshotPath, {
      key: keyResult.key ?? undefined,
      includeCredentials: body.includeCredentials === true,
      pathResolver,
      workspaceDir: getWorkspaceDir(),
    });

    return Response.json({
      manifest: result.manifest,
      restoredFiles: result.restoredFiles,
      credentialsIncluded: result.credentials.length,
    });
  } catch (err) {
    log.error({ err, snapshotPath }, "Snapshot restore failed");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Snapshot restore failed",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// POST /v1/backups/verify
// ---------------------------------------------------------------------------

interface VerifyRequestBody {
  path: unknown;
}

/**
 * Verify a snapshot (decrypts if needed, runs `validateVBundle`) without
 * touching the workspace. Does not throw on validation or decryption failure
 * — those surface as `{ valid: false, error: ... }` so callers can render a
 * uniform status for each snapshot in a list.
 */
export async function handleBackupVerify(req: Request): Promise<Response> {
  let body: VerifyRequestBody;
  try {
    body = (await req.json()) as VerifyRequestBody;
  } catch {
    return httpError(
      "BAD_REQUEST",
      "Request body must be valid JSON with a `path` field",
      400,
    );
  }

  const validated = await validateSnapshotPath(body.path);
  if ("error" in validated) return validated.error;
  const snapshotPath = validated.path;

  const keyResult = await loadKeyIfEncrypted(snapshotPath);
  if ("error" in keyResult) return keyResult.error;

  try {
    const result = await verifySnapshot(snapshotPath, {
      key: keyResult.key ?? undefined,
    });
    return Response.json(result);
  } catch (err) {
    log.error({ err, snapshotPath }, "Snapshot verification failed");
    return httpError(
      "INTERNAL_ERROR",
      err instanceof Error ? err.message : "Snapshot verification failed",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function backupRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "backups",
      method: "GET",
      summary: "List backup snapshots",
      description:
        "Lists local and offsite backup snapshots. Each offsite destination includes a `reachable` flag reflecting whether the backing volume is currently available.",
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
        nextRunAt: z.string().nullable(),
      }),
      handler: async ({ req }) => handleBackupList(req),
    },
    {
      endpoint: "backups/create",
      method: "POST",
      summary: "Create a backup snapshot immediately",
      description:
        "Trigger a manual snapshot. Bypasses the enabled and interval gates, but honors the in-progress mutex — a concurrent caller receives 409.",
      tags: ["backups"],
      responseBody: z.object({
        local: z.object({}).passthrough(),
        offsite: z.array(z.unknown()),
        durationMs: z.number(),
      }),
      handler: async ({ req }) => handleBackupCreate(req),
    },
    {
      endpoint: "backups/restore",
      method: "POST",
      summary: "Restore from a backup snapshot",
      description:
        "Restores a snapshot into the workspace. Destructive: the underlying commit flow backs up existing files before overwriting.",
      tags: ["backups"],
      requestBody: z.object({
        path: z
          .string()
          .describe("Absolute path to the snapshot file to restore"),
        includeCredentials: z
          .boolean()
          .optional()
          .describe(
            "Whether to extract credential entries from the bundle (default false)",
          ),
      }),
      responseBody: z.object({
        manifest: z.object({}).passthrough(),
        restoredFiles: z.number(),
        credentialsIncluded: z.number(),
      }),
      handler: async ({ req }) => handleBackupRestore(req),
    },
    {
      endpoint: "backups/verify",
      method: "POST",
      summary: "Verify a backup snapshot",
      description:
        "Validates a snapshot without restoring. Decrypts encrypted bundles to a temp file, runs the vbundle validator, and returns a pass/fail status.",
      tags: ["backups"],
      requestBody: z.object({
        path: z
          .string()
          .describe("Absolute path to the snapshot file to verify"),
      }),
      responseBody: z.object({
        valid: z.boolean(),
        manifest: z.object({}).passthrough().optional(),
        error: z.string().optional(),
      }),
      handler: async ({ req }) => handleBackupVerify(req),
    },
  ];
}
