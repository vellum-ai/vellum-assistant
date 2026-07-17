/**
 * Standalone entry point for the resource monitor as its own OS process.
 *
 * Spawned at every daemon startup (and on demand by `assistant monitoring
 * start`). Loads config, starts the sampling loop and the non-turn telemetry
 * reporter, writes a PID file, and stays alive until SIGTERM/SIGINT.
 *
 * Running as a separate process — off the assistant's main event loop — is the
 * whole point: the sampler keeps recording during a main-thread freeze, its
 * on-disk ring buffer survives the OOM SIGKILL that resets all in-VM state,
 * and telemetry keeps flushing while the daemon is busy or stalled.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { rehydratePlatformCredentials } from "../config/platform-rehydration.js";
import { resetDb } from "../persistence/db-connection.js";
import { startConsentRefresh } from "../platform/consent-cache.js";
import {
  startConfigSnapshotReporter,
  stopConfigSnapshotReporter,
} from "../telemetry/config-setting-snapshot.js";
import {
  startMonitorUsageTelemetryReporter,
  stopUsageTelemetryReporter,
} from "../telemetry/usage-telemetry-reporter.js";
import { getLogger } from "../util/logger.js";
import {
  getMonitoringDataDir,
  getMonitoringPidPath,
} from "../util/platform.js";
import {
  type PluginSourceWatchHandle,
  startPluginSourceWatch,
} from "./plugin-source-watch.js";
import { type RecoveryHandle, startRecovery } from "./recovery/run-recovery.js";
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

  // Rehydrate the platform base URL and IDs from the credential store before
  // the telemetry reporter starts. The daemon does this in
  // initializeProvidersAndTools(); this standalone process must do it itself so
  // the non-turn telemetry it flushes carries the platform organization and
  // user context instead of shipping with those fields empty.
  await rehydratePlatformCredentials();

  const sampler: ResourceSamplerHandle = startResourceSampler(
    config.monitoring,
  );
  const sourceWatch: PluginSourceWatchHandle = startPluginSourceWatch(
    config.monitoring.pluginSourceScanIntervalMs,
  );
  // Crash recovery runs here, off the daemon's boot path and event loop.
  const recovery: RecoveryHandle = startRecovery();

  // Flush the non-turn telemetry sources from this process, off the daemon's
  // event loop. The reporter's share_analytics gate reads the consent cache,
  // so this process runs its own refresh loop.
  startConsentRefresh();
  startMonitorUsageTelemetryReporter();

  // Emit the tracked config settings into the config_setting pipeline this
  // process flushes.
  startConfigSnapshotReporter();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "Resource monitor process shutting down");
    recovery.stop();
    stopConfigSnapshotReporter();
    sourceWatch.stop();
    sampler.stop();
    // Bounded final telemetry flush, mirroring the daemon's shutdown. This
    // is load-bearing for the opt-out contract: when share_analytics is
    // off, flush() is what advances this process's watermarks past rows
    // recorded during the opt-out window — without it, rows since the last
    // 5-minute cycle would ship after a later opt-in. When opted in, it
    // ships the tail instead of leaving it for the next boot.
    try {
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Telemetry flush timed out")), 3_000),
      );
      await Promise.race([stopUsageTelemetryReporter(), timeout]);
    } catch (err) {
      log.warn({ err }, "Telemetry reporter shutdown failed (non-fatal)");
    }
    cleanupPidFile();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("SIGUSR1", () => {
    log.info("Received SIGUSR1 — refreshing database connections");
    resetDb();
  });

  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception in resource monitor process");
    recovery.stop();
    sourceWatch.stop();
    sampler.stop();
    cleanupPidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection in resource monitor process");
    recovery.stop();
    sourceWatch.stop();
    sampler.stop();
    cleanupPidFile();
    process.exit(1);
  });

  process.on("exit", () => {
    recovery.stop();
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
