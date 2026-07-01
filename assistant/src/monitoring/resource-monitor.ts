/**
 * Standalone entry point for the resource monitor as its own OS process.
 *
 * Spawned by `assistant resource-monitor start` (and at daemon startup when
 * `resourceMonitor.enabled` is set). Loads config, starts the sampling loop,
 * writes a PID file, and stays alive until SIGTERM/SIGINT.
 *
 * Running as a separate process — off the assistant's main event loop — is the
 * whole point: the sampler keeps recording during a main-thread freeze, and its
 * on-disk ring buffer survives the OOM SIGKILL that resets all in-VM state.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getResourceMonitorPidPath } from "../util/platform.js";
import {
  type ResourceSamplerHandle,
  startResourceSampler,
} from "./resource-sampler.js";

const log = getLogger("resource-monitor-process");

function cleanupPidFile(): void {
  const pidPath = getResourceMonitorPidPath();
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const pidPath = getResourceMonitorPidPath();

  // Write PID file so `status` and `stop` can find us.
  writeFileSync(pidPath, String(process.pid), { flag: "w" });
  log.info(
    {
      pid: process.pid,
      pidPath,
      sampleIntervalMs: config.resourceMonitor.sampleIntervalMs,
    },
    "Resource monitor process started",
  );

  const sampler: ResourceSamplerHandle = startResourceSampler(
    config.resourceMonitor,
  );

  const shutdown = (signal: string) => {
    log.info({ signal }, "Resource monitor process shutting down");
    sampler.stop();
    cleanupPidFile();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in resource monitor process");
    sampler.stop();
    cleanupPidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in resource monitor process");
    sampler.stop();
    cleanupPidFile();
    process.exit(1);
  });

  process.on("exit", () => {
    sampler.stop();
    cleanupPidFile();
  });
}

void main().catch((err) => {
  log.error({ err }, "Resource monitor process failed to start");
  cleanupPidFile();
  process.exit(1);
});
