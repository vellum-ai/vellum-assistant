/**
 * Standalone entry point for the schedule worker as its own OS process.
 *
 * Spawned by `assistant schedules worker start` (and at daemon startup when
 * `schedules.worker.enabled` is set). Loads config, writes a PID file, and
 * claims + executes due schedules (all modes) on a fixed tick until
 * SIGTERM/SIGINT. While the flag is set, the daemon's in-process scheduler
 * leaves schedules to this process.
 *
 * Running as a separate process — off the assistant's main event loop — is
 * the point: expensive scheduled jobs execute here without competing with
 * user-facing traffic, and keep running during a main-thread freeze in the
 * daemon.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { rehydratePlatformCredentials } from "../config/platform-rehydration.js";
import { resetDb } from "../persistence/db-connection.js";
import { initializeTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { getScheduleWorkerPidPath } from "../util/platform.js";
import { runDueSchedulesOnce } from "./scheduler.js";

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

async function main(): Promise<void> {
  // Load config up front so a broken config fails the spawn (before the PID
  // file is written) instead of surfacing on the first tick.
  getConfig();
  const pidPath = getScheduleWorkerPidPath();

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info({ pid: process.pid, pidPath }, "Schedule worker process started");

  // Rehydrate the platform base URL and IDs from the credential store before
  // the first tick. The daemon does this in initializeProvidersAndTools(); this
  // standalone process must do it itself so getPlatformBaseUrl() resolves to
  // the persisted platform environment instead of the VELLUM_ENVIRONMENT
  // default — otherwise valid credentials are sent to the wrong platform and
  // rejected for both inference and background-wake requests.
  await rehydratePlatformCredentials();

  // Populate the tool registry (core built-ins + workspace tools). The daemon
  // does this at startup; this standalone process has to do it itself so
  // workflow schedules pass the core-tools readiness gate and agent-executed
  // schedules run with their tools. Best-effort — a tool-registry failure
  // must not take the worker down with it.
  try {
    await initializeTools();
  } catch (err) {
    log.warn(
      { err },
      "Failed to initialize tools in schedule worker; continuing degraded",
    );
  }

  let stopped = false;
  let tickRunning = false;
  const tick = async () => {
    if (stopped || tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      const result = await runDueSchedulesOnce();
      const processed = result.completed + result.failed + result.skipped;
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

  process.on("SIGUSR1", () => {
    log.info("Received SIGUSR1 — refreshing database connections");
    resetDb();
  });

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

void main().catch((err) => {
  log.error({ err }, "Schedule worker process failed to start");
  cleanupPidFile();
  process.exit(1);
});
