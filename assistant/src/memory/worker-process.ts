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
import { getLogger } from "../util/logger.js";
import { getMemoryWorkerPidPath } from "../util/platform.js";
import { startMemoryJobsWorker } from "./jobs-worker.js";

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

  const worker = startMemoryJobsWorker();

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
