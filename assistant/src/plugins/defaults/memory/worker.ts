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
import { isMemoryEnabled } from "../../../config/memory-v3-gate.js";
import { rehydratePlatformCredentials } from "../../../config/platform-rehydration.js";
import { resetDb } from "../../../persistence/db-connection.js";
import {
  EMBEDDING_SHUTDOWN_BUDGET_MS,
  shutdownEmbeddingBackends,
  terminateEmbeddingWorkersNow,
} from "../../../persistence/embeddings/embedding-backend.js";
import { disableStreamSeqStamping } from "../../../runtime/assistant-stream-state.js";
import { initializeTools } from "../../../tools/registry.js";
import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../../../util/worker-process.js";
import { registerWorkerPluginSurface } from "../../worker-plugin-surface.js";
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

  if (!isMemoryEnabled(config)) {
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

  // Jobs in this process wake real agent conversations, so it registers the
  // default plugin hook surface (hooks and injectors, no init hooks) the same
  // way the daemon does, and the job handlers the worker dispatches from: the
  // memory plugin's own plus the host's non-plugin domain handlers.
  registerWorkerPluginSurface();
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

  let worker: ReturnType<typeof startMemoryJobsWorkerLoop> | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let disposePidGuard: (() => void) | null = null;
  // Set synchronously by shutdown() so startup below can tell it has been
  // superseded. Eviction exits immediately, but a signal arriving mid-startup
  // defers its exit to reap the backend, and without this flag that worker
  // would fall through to the jobs worker loop, whose
  // resetRunningJobsToPending() resets the LIVE successor's in-progress jobs
  // and fires the startup orphan sweeps against its data.
  let shuttingDown = false;
  const shutdown = (signal: string, opts: { immediate?: boolean } = {}) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "Memory worker process shutting down");
    worker?.stop();
    if (keepAlive != null) {
      clearInterval(keepAlive);
    }
    disposePidGuard?.();
    cleanupWorkerPidFile(pidPath);

    // Eviction means a successor is already live and about to reset every
    // `running` job to `pending`. `worker.stop()` does not cancel the tick
    // already in flight, so staying alive to reap would let this process keep
    // executing a job the successor has just reclaimed.
    //
    // Exit now, but kill the owned embed worker first. Waiting for the
    // successor's reclaim sweep to adopt it does not work: eviction is detected
    // on a 15s poll, by which point that sweep has already run and classified
    // the child as another live process's, leaving two workers alive.
    if (opts.immediate) {
      terminateEmbeddingWorkersNow();
      process.exit(0);
    }

    // Signal shutdown: no successor exists, so take the time to reap the ONNX
    // worker subprocess this process owns rather than leaving an orphan
    // (JARVIS-1125). `shutdownEmbeddingBackends` enforces its own ceiling, so
    // this outer race only has to sit above it to stay a backstop rather than
    // the thing that cuts the reap short.
    void Promise.race([
      shutdownEmbeddingBackends().catch((err: unknown) => {
        log.warn({ err }, "Embedding backend shutdown failed (non-fatal)");
      }),
      Bun.sleep(EMBEDDING_SHUTDOWN_BUDGET_MS + 1_000),
    ]).finally(() => process.exit(0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Arm the identity guard before the worker loop starts. Its on-arm check runs
  // synchronously, so a worker superseded during startup calls shutdown() here,
  // before it dispatches any jobs.
  disposePidGuard = startWorkerPidFileGuard(pidPath, {
    onEvicted: (reason) => {
      log.warn({ reason }, "Evicted: the PID file no longer names this worker");
      shutdown("pid-file-eviction", { immediate: true });
    },
  });

  // shutdown() defers the exit to reap the embedding backend, so startup must
  // stop itself rather than relying on process.exit having already fired.
  if (shuttingDown) {
    return;
  }

  worker = startMemoryJobsWorkerLoop();

  // Keep-alive: the worker's setTimeout timers are unref'd, so without
  // this interval the process would exit immediately.
  keepAlive = setInterval(() => {}, 60_000);

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
    worker?.stop();
    cleanupWorkerPidFile(getMemoryWorkerPidPath());
  });
}

void main().catch((err) => {
  log.error({ err }, "Memory worker process failed to start");
  cleanupWorkerPidFile(getMemoryWorkerPidPath());
  process.exit(1);
});
