/**
 * Standalone entry point for the resource monitor as its own OS process.
 *
 * Spawned at every daemon startup (and on demand by `assistant monitoring
 * start`). Loads config, starts the sampling loop, writes a PID file, and
 * stays alive until SIGTERM/SIGINT.
 *
 * Running as a separate process — off the assistant's main event loop — is the
 * whole point: the sampler keeps recording during a main-thread freeze, and its
 * on-disk ring buffer survives the OOM SIGKILL that resets all in-VM state.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { resetDb } from "../persistence/db-connection.js";
import { getLogger } from "../util/logger.js";
import {
  getMonitoringDataDir,
  getMonitoringPidPath,
} from "../util/platform.js";
import {
  type PluginSourceWatchHandle,
  startPluginSourceWatch,
} from "./plugin-source-watch.js";
import {
  type ResourceSamplerHandle,
  startResourceSampler,
} from "./resource-sampler.js";

const log = getLogger("monitoring-worker");

function cleanupPidFile(): void {
  const pidPath = getMonitoringPidPath();
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const pidPath = getMonitoringPidPath();

  // Ensure the data dir exists before the PID write — the sampler's ring buffer
  // would otherwise be the first to create it, but the PID file lands here too.
  mkdirSync(getMonitoringDataDir(), { recursive: true });

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info(
    {
      pid: process.pid,
      pidPath,
      sampleIntervalMs: config.monitoring.sampleIntervalMs,
    },
    "Resource monitor process started",
  );

  const sampler: ResourceSamplerHandle = startResourceSampler(
    config.monitoring,
  );
  const sourceWatch: PluginSourceWatchHandle = startPluginSourceWatch(
    config.monitoring.pluginSourceScanIntervalMs,
  );

  const shutdown = (signal: string) => {
    log.info({ signal }, "Resource monitor process shutting down");
    sourceWatch.stop();
    sampler.stop();
    cleanupPidFile();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("SIGUSR1", () => {
    log.info("Received SIGUSR1 — refreshing database connections");
    resetDb();
  });

  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in resource monitor process");
    sourceWatch.stop();
    sampler.stop();
    cleanupPidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in resource monitor process");
    sourceWatch.stop();
    sampler.stop();
    cleanupPidFile();
    process.exit(1);
  });

  process.on("exit", () => {
    sourceWatch.stop();
    sampler.stop();
    cleanupPidFile();
  });
}

void main().catch((err) => {
  log.error({ err }, "Resource monitor process failed to start");
  cleanupPidFile();
  process.exit(1);
});
