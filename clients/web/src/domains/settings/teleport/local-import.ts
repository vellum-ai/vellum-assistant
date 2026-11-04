/**
 * Import a `.vbundle` from platform object storage into a local assistant.
 *
 * The local runtime fetches the signed URL and stream-imports the bundle as a
 * background job, the same path `vellum teleport --local` takes. The bytes
 * never pass through the renderer, and the import runs under the streaming
 * importer's size limits rather than the buffered raw-body validator's.
 */

import { t } from "@/i18n";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

import {
  connectLocalGateway,
  type LocalGateway,
  type LocalMigrationJob,
  pollLocalMigrationJob,
  startLocalImportFromUrl,
} from "./teleport-gateway-client";
import { TeleportError } from "./teleport-types";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface LocalImportOptions {
  /** Attempts to start the import while a freshly hatched gateway comes up. */
  startAttempts?: number;
  /** Delay between start attempts. */
  startRetryMs?: number;
  /** How often to poll the runtime's import job. */
  pollIntervalMs?: number;
  /** How long to wait for the import job before giving up. */
  timeoutMs?: number;
  /** Consecutive failed polls tolerated before the last error is thrown. */
  maxConsecutivePollErrors?: number;
}

const DEFAULTS: Required<LocalImportOptions> = {
  startAttempts: 30,
  startRetryMs: 1_000,
  pollIntervalMs: 5_000,
  // Matches the runtime's deadline for fetching the bundle URL.
  timeoutMs: 3_600_000,
  maxConsecutivePollErrors: 5,
};

/** Run a local import end to end and resolve once the runtime reports it complete. */
export async function importBundleToLocal(
  local: LockfileAssistant,
  bundleUrl: string,
  options: LocalImportOptions = {},
): Promise<void> {
  const resolved = { ...DEFAULTS, ...options };
  const { gateway, jobId } = await startImportWhenReady(
    local,
    bundleUrl,
    resolved,
  );
  await awaitLocalImportJob(local, gateway, jobId, resolved);
}

/**
 * Start the import, retrying while the gateway is unreachable or answers 5xx,
 * in lieu of an explicit readiness gate. Any other refusal is the runtime's
 * answer to this bundle URL, so it fails immediately.
 */
async function startImportWhenReady(
  local: LockfileAssistant,
  bundleUrl: string,
  { startAttempts, startRetryMs }: Required<LocalImportOptions>,
): Promise<{ gateway: LocalGateway; jobId: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < startAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(startRetryMs);
    }
    try {
      const gateway = await connectLocalGateway(local);
      const started = await startLocalImportFromUrl(gateway, bundleUrl);
      if (started.ok) {
        return { gateway, jobId: started.jobId };
      }
      lastError = new TeleportError("import_failed", started.message);
      if (started.status < 500) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new TeleportError(
        "import_failed",
        t("settings:teleportCard.importFailed"),
      );
}

/**
 * Poll the import job over the gateway connection that started it, and
 * reconnect after a failed poll in case its token is what failed.
 */
async function awaitLocalImportJob(
  local: LockfileAssistant,
  startedOn: LocalGateway,
  jobId: string,
  {
    pollIntervalMs,
    timeoutMs,
    maxConsecutivePollErrors,
  }: Required<LocalImportOptions>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let gateway: LocalGateway | null = startedOn;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let job: LocalMigrationJob;
    try {
      gateway ??= await connectLocalGateway(local);
      job = await pollLocalMigrationJob(gateway, jobId, "import_failed");
    } catch (error) {
      gateway = null;
      consecutiveErrors += 1;
      if (consecutiveErrors > maxConsecutivePollErrors) {
        throw error;
      }
      continue;
    }
    consecutiveErrors = 0;
    if (job.status === "complete") {
      return;
    }
    if (job.status === "failed") {
      throw new TeleportError(
        "import_failed",
        job.error ?? t("settings:teleportCard.importJobFailed"),
      );
    }
  }
  throw new TeleportError(
    "import_failed",
    t("settings:teleportCard.importTimedOut"),
  );
}
