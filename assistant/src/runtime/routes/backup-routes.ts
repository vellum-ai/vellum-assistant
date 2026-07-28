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

import {
  listSnapshotsInDir,
  type SnapshotEntry,
} from "../../backup/list-snapshots.js";
import {
  getLocalBackupsDir,
  resolveOffsiteDestinations,
} from "../../backup/paths.js";
import { restoreFromSnapshot, verifySnapshot } from "../../backup/restore.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import type { BackupConfig, BackupDestination } from "../../config/schema.js";
import { getMemoryCheckpoint } from "../../persistence/checkpoints.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir, getWorkspaceHooksDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { DefaultPathResolver } from "../migrations/vbundle-import-analyzer.js";
import { BadRequestError, RouteError } from "./errors.js";
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
 * Reject encrypted snapshots — decryption has moved to the gateway (ATL-397).
 * The assistant daemon no longer has access to the backup key.
 */
function rejectIfEncrypted(snapshotPath: string): void {
  if (snapshotPath.endsWith(".vbundle.enc")) {
    throw new BadRequestError(
      "Encrypted snapshot restore/verify must go through the gateway, " +
        "which owns the backup key. Use the gateway's backup endpoints instead.",
    );
  }
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

export async function handleBackupCreate(): Promise<never> {
  throw new BadRequestError(
    "Backup snapshot creation has moved to the gateway. " +
      "Use the gateway's POST /v1/backups/create endpoint instead.",
  );
}

export async function handleBackupRestore({ body }: RouteHandlerArgs) {
  const path = body?.path;
  const snapshotPath = await validateSnapshotPath(path);
  rejectIfEncrypted(snapshotPath);

  try {
    const pathResolver = new DefaultPathResolver(
      getWorkspaceDir(),
      getWorkspaceHooksDir(),
    );

    const result = await restoreFromSnapshot(snapshotPath, {
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
  rejectIfEncrypted(snapshotPath);

  try {
    return await verifySnapshot(snapshotPath);
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
// Config-mutation + status handlers
// ---------------------------------------------------------------------------

export async function handleBackupEnable({
  body,
}: RouteHandlerArgs): Promise<BackupConfig> {
  const intervalHours = body?.intervalHours as number | undefined;
  const retention = body?.retention as number | undefined;
  const offsiteEnabled = body?.offsiteEnabled as boolean | undefined;

  if (intervalHours !== undefined) {
    if (
      !Number.isFinite(intervalHours) ||
      intervalHours < 1 ||
      intervalHours > 168
    ) {
      throw new BadRequestError(
        `intervalHours must be between 1 and 168, got ${intervalHours}`,
      );
    }
  }
  if (retention !== undefined) {
    if (!Number.isFinite(retention) || retention < 1 || retention > 100) {
      throw new BadRequestError(
        `retention must be between 1 and 100, got ${retention}`,
      );
    }
  }

  const raw = loadRawConfig();
  setNestedValue(raw, "backup.enabled", true);
  if (intervalHours !== undefined) {
    setNestedValue(raw, "backup.intervalHours", intervalHours);
  }
  if (retention !== undefined) {
    setNestedValue(raw, "backup.retention", retention);
  }
  if (offsiteEnabled !== undefined) {
    setNestedValue(raw, "backup.offsite.enabled", offsiteEnabled);
  }
  saveRawConfig(raw);
  invalidateConfigCache();

  return getConfig().backup;
}

export async function handleBackupDisable(): Promise<{ enabled: false }> {
  const raw = loadRawConfig();
  setNestedValue(raw, "backup.enabled", false);
  saveRawConfig(raw);
  invalidateConfigCache();
  return { enabled: false };
}

export async function handleBackupDestinationsList(): Promise<{
  destinations: BackupDestination[];
}> {
  const config = getConfig();
  return {
    destinations: resolveOffsiteDestinations(
      config.backup.offsite.destinations,
    ),
  };
}

export async function handleBackupDestinationsAdd({
  body,
}: RouteHandlerArgs): Promise<{ destinations: BackupDestination[] }> {
  const path = body?.path;
  const encrypt = body?.encrypt;

  if (typeof path !== "string" || path.length === 0) {
    throw new BadRequestError(
      "Request body must include a non-empty `path` field",
    );
  }
  if (encrypt !== undefined && typeof encrypt !== "boolean") {
    throw new BadRequestError("`encrypt` must be a boolean");
  }

  const current = resolveOffsiteDestinations(
    getConfig().backup.offsite.destinations,
  );
  if (current.some((d) => d.path === path)) {
    throw new BadRequestError(
      `Destination "${path}" already exists. Run 'assistant backup destinations list' to see configured destinations.`,
    );
  }

  const next: BackupDestination[] = [
    ...current,
    { path, encrypt: (encrypt as boolean | undefined) ?? true },
  ];

  const raw = loadRawConfig();
  setNestedValue(raw, "backup.offsite.destinations", next);
  saveRawConfig(raw);
  invalidateConfigCache();

  return { destinations: next };
}

export async function handleBackupDestinationsRemove({
  body,
}: RouteHandlerArgs): Promise<{ destinations: BackupDestination[] }> {
  const path = body?.path;

  if (typeof path !== "string" || path.length === 0) {
    throw new BadRequestError(
      "Request body must include a non-empty `path` field",
    );
  }

  const current = resolveOffsiteDestinations(
    getConfig().backup.offsite.destinations,
  );
  const filtered = current.filter((d) => d.path !== path);
  if (filtered.length === current.length) {
    throw new BadRequestError(
      `Destination "${path}" not found. Run 'assistant backup destinations list' to see configured destinations.`,
    );
  }

  const raw = loadRawConfig();
  setNestedValue(raw, "backup.offsite.destinations", filtered);
  saveRawConfig(raw);
  invalidateConfigCache();

  return { destinations: filtered };
}

export async function handleBackupDestinationsSetEncrypt({
  body,
}: RouteHandlerArgs): Promise<{ destination: BackupDestination }> {
  const path = body?.path;
  const encrypt = body?.encrypt;

  if (typeof path !== "string" || path.length === 0) {
    throw new BadRequestError(
      "Request body must include a non-empty `path` field",
    );
  }
  if (typeof encrypt !== "boolean") {
    throw new BadRequestError("`encrypt` must be a boolean");
  }

  const current = resolveOffsiteDestinations(
    getConfig().backup.offsite.destinations,
  );
  const idx = current.findIndex((d) => d.path === path);
  if (idx === -1) {
    throw new BadRequestError(
      `Destination "${path}" not found. Run 'assistant backup destinations list' to see configured destinations.`,
    );
  }

  const updated = { ...current[idx]!, encrypt };
  const next = current.map((d, i) => (i === idx ? updated : d));

  const raw = loadRawConfig();
  setNestedValue(raw, "backup.offsite.destinations", next);
  saveRawConfig(raw);
  invalidateConfigCache();

  return { destination: updated };
}

export async function handleBackupStatus(): Promise<{
  enabled: boolean;
  intervalHours: number;
  retention: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  localDir: string;
  localSnapshotCount: number;
  offsiteEnabled: boolean;
  offsite: Array<{
    path: string;
    encrypt: boolean;
    reachable: boolean;
    snapshotCount: number;
  }>;
}> {
  const config = getConfig();
  const backup = config.backup;

  const lastRunRaw = getMemoryCheckpoint(LAST_RUN_CHECKPOINT_KEY);
  const lastRunMs = lastRunRaw ? Number.parseInt(lastRunRaw, 10) : NaN;
  const lastRunAt = !Number.isNaN(lastRunMs)
    ? new Date(lastRunMs).toISOString()
    : null;

  let nextRunAt: string | null = null;
  if (backup.enabled && !Number.isNaN(lastRunMs)) {
    const intervalMs = backup.intervalHours * 3600 * 1000;
    nextRunAt = new Date(lastRunMs + intervalMs).toISOString();
  }

  const localDir = getLocalBackupsDir(backup.localDirectory);
  const localSnapshots = await listSnapshotsInDir(localDir);
  const localSnapshotCount = localSnapshots.length;

  const offsiteEnabled = backup.offsite.enabled;
  const offsite: Array<{
    path: string;
    encrypt: boolean;
    reachable: boolean;
    snapshotCount: number;
  }> = [];

  if (offsiteEnabled) {
    const destinations = resolveOffsiteDestinations(
      backup.offsite.destinations,
    );
    for (const dest of destinations) {
      let reachable = false;
      try {
        await fs.stat(dirname(dest.path));
        reachable = true;
      } catch {
        reachable = false;
      }
      const snapshots = reachable ? await listSnapshotsInDir(dest.path) : [];
      offsite.push({
        path: dest.path,
        encrypt: dest.encrypt,
        reachable,
        snapshotCount: snapshots.length,
      });
    }
  }

  return {
    enabled: backup.enabled,
    intervalHours: backup.intervalHours,
    retention: backup.retention,
    lastRunAt,
    nextRunAt,
    localDir,
    localSnapshotCount,
    offsiteEnabled,
    offsite,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "backups_list",
    endpoint: "backups",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
  {
    operationId: "backup_enable",
    endpoint: "backup/enable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupEnable,
    summary: "Enable automated backups",
    description:
      "Sets backup.enabled = true. Optionally overrides intervalHours (1-168), retention (1-100), and offsiteEnabled.",
    tags: ["backups"],
    requestBody: z.object({
      intervalHours: z.number().int().min(1).max(168).optional(),
      retention: z.number().int().min(1).max(100).optional(),
      offsiteEnabled: z.boolean().optional(),
    }),
    responseBody: z.object({}).passthrough(),
  },
  {
    operationId: "backup_disable",
    endpoint: "backup/disable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupDisable,
    summary: "Disable automated backups",
    description:
      "Sets backup.enabled = false. Existing snapshots are untouched.",
    tags: ["backups"],
    responseBody: z.object({
      enabled: z.literal(false),
    }),
  },
  {
    operationId: "backup_destinations_list",
    endpoint: "backup/destinations",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupDestinationsList,
    summary: "List configured offsite backup destinations",
    description:
      "Returns the current offsite destinations array, materializing the iCloud Drive default when no explicit array is configured.",
    tags: ["backups"],
    responseBody: z.object({
      destinations: z.array(
        z.object({
          path: z.string(),
          encrypt: z.boolean(),
        }),
      ),
    }),
  },
  {
    operationId: "backup_destinations_add",
    endpoint: "backup/destinations/add",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupDestinationsAdd,
    summary: "Add an offsite backup destination",
    description:
      "Appends a new destination. Materializes the iCloud default first if destinations is currently null. Errors if the path already exists.",
    tags: ["backups"],
    requestBody: z.object({
      path: z
        .string()
        .min(1)
        .describe("Absolute path to the destination directory"),
      encrypt: z
        .boolean()
        .optional()
        .describe("Encrypt snapshots at this destination (default true)"),
    }),
    responseBody: z.object({
      destinations: z.array(
        z.object({
          path: z.string(),
          encrypt: z.boolean(),
        }),
      ),
    }),
  },
  {
    operationId: "backup_destinations_remove",
    endpoint: "backup/destinations/remove",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupDestinationsRemove,
    summary: "Remove an offsite backup destination",
    description:
      "Removes the destination matching the given path. Errors if no matching destination exists.",
    tags: ["backups"],
    requestBody: z.object({
      path: z
        .string()
        .min(1)
        .describe("Exact path match of the destination to remove"),
    }),
    responseBody: z.object({
      destinations: z.array(
        z.object({
          path: z.string(),
          encrypt: z.boolean(),
        }),
      ),
    }),
  },
  {
    operationId: "backup_destinations_set_encrypt",
    endpoint: "backup/destinations/set-encrypt",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupDestinationsSetEncrypt,
    summary: "Toggle encryption for an existing destination",
    description:
      "Updates the encrypt flag for a destination. Errors if no destination with the given path exists.",
    tags: ["backups"],
    requestBody: z.object({
      path: z
        .string()
        .min(1)
        .describe("Exact path match of an existing destination"),
      encrypt: z
        .boolean()
        .describe("true to encrypt future snapshots, false for plaintext"),
    }),
    responseBody: z.object({
      destination: z.object({
        path: z.string(),
        encrypt: z.boolean(),
      }),
    }),
  },
  {
    operationId: "backup_status",
    endpoint: "backup/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBackupStatus,
    summary: "Show backup status and next-run timing",
    description:
      "Reports enabled/disabled state, interval and retention, last-run and next-run timing from the backup:last_run_at checkpoint, local snapshot count, and per-destination reachability and snapshot counts. When `backup.offsite.enabled` is false the `offsite` array is empty and `offsiteEnabled` is false.",
    tags: ["backups"],
    responseBody: z.object({
      enabled: z.boolean(),
      intervalHours: z.number(),
      retention: z.number(),
      lastRunAt: z.string().nullable(),
      nextRunAt: z.string().nullable(),
      localDir: z.string(),
      localSnapshotCount: z.number(),
      offsiteEnabled: z.boolean(),
      offsite: z.array(
        z.object({
          path: z.string(),
          encrypt: z.boolean(),
          reachable: z.boolean(),
          snapshotCount: z.number(),
        }),
      ),
    }),
  },
];
