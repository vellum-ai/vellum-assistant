/**
 * Standalone entry point for the schedule worker as its own OS process.
 *
 * Spawned by `assistant schedules worker start` (and at daemon startup when
 * `schedules.worker.enabled` is set). Loads config, writes a PID file, and
 * claims + executes due script-mode schedules on a fixed tick until
 * SIGTERM/SIGINT.
 *
 * Running as a separate process — off the assistant's main event loop — is
 * the point: expensive scheduled scripts (long builds, backups, exports)
 * execute here without competing with user-facing traffic, and keep running
 * during a main-thread freeze in the daemon. Non-script schedule modes
 * (execute, notify, wake, workflow) stay in the daemon, whose agent pipeline
 * they depend on.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getScheduleWorkerPidPath } from "../util/platform.js";
import { runScriptSchedulesOnce } from "./script-schedule-runner.js";

const log = getLogger("schedule-worker-process");

/** Same cadence as the daemon scheduler's tick. */
const TICK_INTERVAL_MS = 15_000;

function cleanupPidFile(): void {
  const pidPath = getScheduleWorkerPidPath();
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // best-effort
  }
}

function main(): void {
  // Load config up front so a broken config fails the spawn (before the PID
  // file is written) instead of surfacing on the first tick.
  getConfig();
  const pidPath = getScheduleWorkerPidPath();

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info({ pid: process.pid, pidPath }, "Schedule worker process started");

  let stopped = false;
  let tickRunning = false;
  const tick = async () => {
    if (stopped || tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      const processed = await runScriptSchedulesOnce();
      if (processed > 0) {
        log.info({ processed }, "Schedule worker tick complete");
      }
    } catch (err) {
      log.error({ err }, "Schedule worker tick failed");
    } finally {
      tickRunning = false;
    }
  };

  // Deliberately ref'd (unlike the daemon scheduler's timer): this interval
  // is what keeps the standalone process alive between ticks.
  const timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  void tick();

  const shutdown = (signal: string) => {
    log.info({ signal }, "Schedule worker process shutting down");
    stopped = true;
    clearInterval(timer);
    cleanupPidFile();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Catch stray exceptions that escape the tick loop so they produce a clean
  // pino-formatted log entry (and PID-file cleanup) instead of a raw stack
  // trace on stderr. The stderr fd is already piped to the log file by the
  // spawner, so even without these handlers the trace would be captured —
  // but this gives us structured logging and graceful shutdown.
  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in schedule worker process");
    cleanupPidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in schedule worker process");
    cleanupPidFile();
    process.exit(1);
  });

  // Clean up if the process exits unexpectedly through any other path.
  process.on("exit", () => {
    stopped = true;
    clearInterval(timer);
    cleanupPidFile();
  });
}

try {
  main();
} catch (err) {
  log.error({ err }, "Schedule worker process failed to start");
  cleanupPidFile();
  process.exit(1);
}
