/**
 * Standalone entry point for the memory jobs worker as its own OS process.
 *
 * Spawned by `assistant memory worker start`. Loads config, starts the
 * worker loop, writes a PID file, and stays alive until SIGTERM/SIGINT.
 *
 * The worker's internal `setTimeout` calls `.unref()`, which is correct
 * inside the daemon (don't keep the daemon alive for the worker) but would
 * cause this standalone process to exit immediately. A ref'd keep-alive
 * interval prevents that.
 */

import { writeFileSync } from "node:fs";

import { getConfig } from "../../../config/loader.js";
import { rehydratePlatformCredentials } from "../../../config/platform-rehydration.js";
import { resetDb } from "../../../persistence/db-connection.js";
import { disableStreamSeqStamping } from "../../../runtime/assistant-stream-state.js";
import { initializeTools } from "../../../tools/registry.js";
import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../../../util/worker-process.js";
import { registerMemoryPluginJobHandlers } from "./job-handler-registration.js";
import { startMemoryJobsWorkerLoop } from "./jobs-worker.js";
import { getLogger } from "./logging.js";
import { getMemoryWorkerPidPath } from "./paths.js";

const log = getLogger("memory-worker-process");

async function main(): Promise<void> {
  // Only the daemon stamps SSE seqs and writes the shared reservation file.
  disableStreamSeqStamping();
  const config = getConfig();
  const pidPath = getMemoryWorkerPidPath();

  if (config.memory.enabled === false) {
    log.info("Memory is disabled in config; worker process exiting");
    process.exit(0);
  }

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info({ pid: process.pid, pidPath }, "Memory worker process started");

  // Rehydrate the platform base URL and IDs from the credential store before
  // any job runs. The daemon does this in initializeProvidersAndTools(); this
  // standalone process must do it itself so getPlatformBaseUrl() resolves to
  // the persisted platform environment instead of the VELLUM_ENVIRONMENT
  // default. Retrospective and consolidation passes wake real agent
  // conversations whose inference and background-wake requests go through the
  // platform proxy — without rehydration those requests hit the wrong platform
  // and are rejected.
  await rehydratePlatformCredentials();

  // This process does not run plugin bootstrap, so self-register the job
  // handlers the worker dispatches from before starting it — the memory
  // plugin's own plus the host's non-plugin domain handlers.
  registerMemoryPluginJobHandlers();

  // Populate the tool registry (core built-ins + workspace tools), exactly as
  // the daemon and the schedule worker do at startup. Jobs in this process
  // wake real agent conversations (retrospective and consolidation passes,
  // and any subagents they spawn), and those conversations resolve their tool
  // surface from this process's registry — without it, every tool such a pass
  // is granted (including `remember`, the point of a retrospective) errors as
  // "Unknown tool". Best-effort: a registry failure must not take the worker
  // down; passes degrade to a reduced tool surface instead.
  try {
    await initializeTools();
  } catch (err) {
    log.warn(
      { err },
      "Failed to initialize tools in memory worker; continuing degraded",
    );
  }

  const worker = startMemoryJobsWorkerLoop();

  // Keep-alive: the worker's setTimeout timers are unref'd, so without
  // this interval the process would exit immediately.
  const keepAlive = setInterval(() => {}, 60_000);

  let disposePidGuard: (() => void) | null = null;
  const shutdown = (signal: string) => {
    log.info({ signal }, "Memory worker process shutting down");
    worker.stop();
    clearInterval(keepAlive);
    disposePidGuard?.();
    cleanupWorkerPidFile(pidPath);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  disposePidGuard = startWorkerPidFileGuard(pidPath, {
    onEvicted: (reason) => {
      log.warn(
        { reason },
        "Evicted — the PID file no longer names this worker",
      );
      shutdown("pid-file-eviction");
    },
  });

  process.on("SIGUSR1", () => {
    log.info("Received SIGUSR1 — refreshing database connections");
    resetDb();
  });

  // Catch stray exceptions that escape the worker loop so they produce a
  // clean pino-formatted log entry (and PID-file cleanup) instead of a raw
  // stack trace on stderr. The stderr fd is already piped to the log file
  // by the spawner, so even without these handlers the trace would be
  // captured — but this gives us structured logging and graceful shutdown.
  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in memory worker process");
    cleanupWorkerPidFile(getMemoryWorkerPidPath());
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in memory worker process");
    cleanupWorkerPidFile(getMemoryWorkerPidPath());
    process.exit(1);
  });

  // Clean up if the process exits unexpectedly through any other path.
  process.on("exit", () => {
    worker.stop();
    cleanupWorkerPidFile(getMemoryWorkerPidPath());
  });
}

void main().catch((err) => {
  log.error({ err }, "Memory worker process failed to start");
  cleanupWorkerPidFile(getMemoryWorkerPidPath());
  process.exit(1);
});
