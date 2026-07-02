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

import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { startInProcessMemoryJobsWorker } from "../persistence/jobs-worker.js";
import { registerDefaultPluginPersistenceHooks } from "../plugins/defaults/index.js";
import { registerMemoryPluginJobHandlers } from "../plugins/defaults/memory/job-handler-registration.js";
import { getLogger } from "../util/logger.js";
import { getMemoryWorkerPidPath } from "../util/platform.js";
import { registerDomainJobHandlers } from "./register-job-handlers.js";

const log = getLogger("memory-worker-process");

function cleanupPidFile(): void {
  const pidPath = getMemoryWorkerPidPath();
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const pidPath = getMemoryWorkerPidPath();

  if (config.memory.enabled === false) {
    log.info("Memory is disabled in config; worker process exiting");
    process.exit(0);
  }

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info({ pid: process.pid, pidPath }, "Memory worker process started");

  // This process does not run plugin bootstrap, so self-register everything the
  // worker dispatches from before starting it: the host's non-plugin domain
  // handlers, the memory plugin's own handlers, and the memory
  // persistence-lifecycle hooks (without which the fork-based retrospectives
  // silently drop carried memory state).
  registerDomainJobHandlers();
  registerMemoryPluginJobHandlers();
  registerDefaultPluginPersistenceHooks();
  const worker = startInProcessMemoryJobsWorker();

  // Keep-alive: the worker's setTimeout timers are unref'd, so without
  // this interval the process would exit immediately.
  const keepAlive = setInterval(() => {}, 60_000);

  const shutdown = (signal: string) => {
    log.info({ signal }, "Memory worker process shutting down");
    worker.stop();
    clearInterval(keepAlive);
    cleanupPidFile();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Catch stray exceptions that escape the worker loop so they produce a
  // clean pino-formatted log entry (and PID-file cleanup) instead of a raw
  // stack trace on stderr. The stderr fd is already piped to the log file
  // by the spawner, so even without these handlers the trace would be
  // captured — but this gives us structured logging and graceful shutdown.
  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in memory worker process");
    cleanupPidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in memory worker process");
    cleanupPidFile();
    process.exit(1);
  });

  // Clean up if the process exits unexpectedly through any other path.
  process.on("exit", () => {
    worker.stop();
    cleanupPidFile();
  });
}

void main().catch((err) => {
  log.error({ err }, "Memory worker process failed to start");
  cleanupPidFile();
  process.exit(1);
});
