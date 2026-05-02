/**
 * Gateway backup worker.
 *
 * Drives the backup pipeline on a configurable interval. On each tick:
 * 1. Read backup config from workspace config.json
 * 2. Check whether enough time has passed since the last successful run
 * 3. Call the daemon's /v1/migrations/export to get a plaintext .vbundle
 * 4. Write the plaintext archive to the local backup directory
 * 5. Encrypt + mirror to offsite destinations (key never leaves this process)
 * 6. Apply retention to all pools
 *
 * The backup key lives in GATEWAY_SECURITY_DIR and is never exposed to the
 * assistant daemon. The daemon produces the data; the gateway handles the
 * security envelope.
 */

import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { mintServiceToken } from "../auth/token-exchange.js";
import { readConfigFileOrEmpty } from "../config-file-utils.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";
import { getGatewaySecurityDir } from "../paths.js";
import { ensureBackupKey } from "./backup-key.js";
import type { SnapshotEntry } from "./list-snapshots.js";
import { pruneLocalSnapshots, writeLocalSnapshot } from "./local-writer.js";
import type { BackupDestination, OffsiteWriteResult } from "./offsite-writer.js";
import {
  pruneOffsiteSnapshotsInAll,
  writeOffsiteSnapshotToAll,
} from "./offsite-writer.js";
import { getBackupKeyPath, getLocalBackupsDir } from "./paths.js";

const log = getLogger("backup-worker");

/** Tick interval: check every 5 minutes whether a backup is due. */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Timeout for the daemon export request (60 minutes for large workspaces). */
const EXPORT_TIMEOUT_MS = 60 * 60 * 1000;

/** File used to persist the last successful backup timestamp across restarts. */
const LAST_RUN_FILENAME = "backup-last-run-at";

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  offsite: {
    enabled: boolean;
    destinations: BackupDestination[] | null;
  };
  localDirectory: string | null;
}

/** Default iCloud Drive destination (macOS) with encryption enabled. */
function defaultOffsiteDestinations(): BackupDestination[] {
  const home = process.env.HOME || "";
  if (!home) return [];
  return [
    {
      path: join(
        home,
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs",
        "VellumAssistant",
        "backups",
      ),
      encrypt: true,
    },
  ];
}

function readBackupConfig(): BackupConfig {
  const raw = readConfigFileOrEmpty();
  const backup = (raw.backup ?? {}) as Record<string, unknown>;

  const enabled = backup.enabled === true;
  const intervalHours =
    typeof backup.intervalHours === "number" ? backup.intervalHours : 6;
  const retention =
    typeof backup.retention === "number" ? backup.retention : 3;

  const offsiteRaw = (backup.offsite ?? {}) as Record<string, unknown>;
  const offsiteEnabled = offsiteRaw.enabled !== false;
  let destinations: BackupDestination[] | null = null;
  if (Array.isArray(offsiteRaw.destinations)) {
    destinations = offsiteRaw.destinations
      .filter(
        (d): d is { path: string; encrypt?: boolean } =>
          d && typeof d === "object" && typeof (d as Record<string, unknown>).path === "string",
      )
      .map((d) => ({
        path: d.path,
        encrypt: d.encrypt !== false,
      }));
  }

  const localDirectory =
    typeof backup.localDirectory === "string" ? backup.localDirectory : null;

  return {
    enabled,
    intervalHours,
    retention,
    offsite: { enabled: offsiteEnabled, destinations },
    localDirectory,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint persistence
// ---------------------------------------------------------------------------

function getCheckpointPath(): string {
  return join(getGatewaySecurityDir(), LAST_RUN_FILENAME);
}

function readLastRunAt(): number {
  try {
    const raw = readFileSync(getCheckpointPath(), "utf-8").trim();
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

function writeLastRunAt(timestamp: number): void {
  try {
    writeFileSync(getCheckpointPath(), String(timestamp), "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to persist backup checkpoint");
  }
}

// ---------------------------------------------------------------------------
// Core backup pipeline
// ---------------------------------------------------------------------------

export interface BackupRunResult {
  local: SnapshotEntry;
  offsite: OffsiteWriteResult[];
  durationMs: number;
}

interface BackupDeps {
  /** Base URL of the assistant daemon (e.g. http://localhost:7821). */
  assistantRuntimeBaseUrl: string;
}

/**
 * Perform a single backup run:
 * 1. Export plaintext vbundle from daemon
 * 2. Write to local backup directory
 * 3. Encrypt + mirror to offsite destinations
 * 4. Apply retention
 */
async function performBackup(
  config: BackupConfig,
  now: Date,
  deps: BackupDeps,
): Promise<BackupRunResult> {
  const startTimestamp = Date.now();
  const localDir = getLocalBackupsDir(config.localDirectory);

  // Resolve offsite destinations
  const destinations = config.offsite.enabled
    ? (config.offsite.destinations ?? defaultOffsiteDestinations())
    : [];

  // Ensure the backup key if any destination needs encryption
  const needsKey = destinations.some((d) => d.encrypt);
  const key: Buffer | null = needsKey
    ? await ensureBackupKey(getBackupKeyPath())
    : null;

  // Call the daemon's export endpoint to get a plaintext vbundle
  const serviceToken = mintServiceToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(
      `${deps.assistantRuntimeBaseUrl}/v1/migrations/export`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ description: "Gateway backup worker" }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Daemon export failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  // Stream the response body to a temp file
  const tempPath = join(tmpdir(), `vellum-backup-${randomUUID()}.vbundle`);
  try {
    const readableBody = response.body;
    if (!readableBody) {
      throw new Error("Daemon export returned an empty response body");
    }

    const writeStream = createWriteStream(tempPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun's ReadableStream type doesn't match Node's web ReadableStream
    const nodeReadable = Readable.fromWeb(readableBody as any);
    await pipeline(nodeReadable, writeStream);

    // Write the plaintext archive to the local backup directory
    const localResult = await writeLocalSnapshot(tempPath, localDir, now);

    // Mirror to offsite destinations (with encryption)
    const offsiteResults = await writeOffsiteSnapshotToAll(
      localResult.path,
      destinations,
      key,
      now,
    );

    // Apply retention
    await pruneLocalSnapshots(localDir, config.retention);
    await pruneOffsiteSnapshotsInAll(destinations, config.retention);

    log.info(
      {
        localPath: localResult.path,
        offsite: offsiteResults.map((r) => ({
          path: r.destination.path,
          status: r.entry ? "ok" : r.skipped ? "skipped" : "error",
          reason: r.skipped ?? r.error,
        })),
      },
      "Backup snapshot complete",
    );

    return {
      local: localResult,
      offsite: offsiteResults,
      durationMs: Date.now() - startTimestamp,
    };
  } catch (err) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // best-effort
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tick + worker lifecycle
// ---------------------------------------------------------------------------

/** Prevent concurrent backup runs. */
let snapshotInProgress = false;

/**
 * A single tick of the backup worker. Checks config, interval, and mutex
 * before delegating to performBackup.
 */
export async function runBackupTick(deps: BackupDeps): Promise<void> {
  const config = readBackupConfig();
  if (!config.enabled) return;

  const now = new Date();
  const lastRunAt = readLastRunAt();
  const intervalMs = config.intervalHours * 3600_000;

  if (lastRunAt > 0 && now.getTime() - lastRunAt < intervalMs) {
    return; // Not due yet
  }

  if (snapshotInProgress) {
    log.info("Backup tick skipped — snapshot already in progress");
    return;
  }

  snapshotInProgress = true;
  try {
    await performBackup(config, now, deps);
    writeLastRunAt(now.getTime());
  } catch (err) {
    log.error({ err }, "Backup tick failed");
  } finally {
    snapshotInProgress = false;
  }
}

/**
 * Manual snapshot trigger. Bypasses the enabled + interval checks but
 * still honors the concurrency mutex.
 */
export async function createSnapshotNow(
  deps: BackupDeps,
): Promise<BackupRunResult> {
  if (snapshotInProgress) {
    throw new Error("A backup snapshot is already in progress");
  }

  const config = readBackupConfig();
  const now = new Date();

  snapshotInProgress = true;
  try {
    const result = await performBackup(config, now, deps);
    writeLastRunAt(now.getTime());
    return result;
  } finally {
    snapshotInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

export interface BackupWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

/**
 * Start the periodic backup worker. Returns a handle with stop() and
 * runOnce() methods.
 */
export function startBackupWorker(deps: BackupDeps): BackupWorkerHandle {
  try {
    const timer = setInterval(async () => {
      try {
        await runBackupTick(deps);
      } catch (err) {
        log.error({ err }, "Backup worker tick unhandled error");
      }
    }, TICK_INTERVAL_MS);

    if (typeof timer.unref === "function") timer.unref();

    return {
      stop: () => clearInterval(timer),
      runOnce: () => runBackupTick(deps),
    };
  } catch (err) {
    log.warn({ err }, "Failed to start backup worker — continuing without it");
    return {
      stop: () => {},
      runOnce: () => Promise.resolve(),
    };
  }
}
