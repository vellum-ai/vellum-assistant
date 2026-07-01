import * as Sentry from "@sentry/node";

import { disposeAcpSessionManager } from "../acp/index.js";
import { stopCes } from "../credential-execution/ces-runtime.js";
import { stopHeartbeatService } from "../heartbeat/heartbeat-service.js";
import { stopCliIpcServer } from "../ipc/assistant-server.js";
import { stopGatewayFlagListener } from "../ipc/gateway-flag-listener.js";
import { stopMcpServerManager } from "../mcp/manager.js";
import { getSqlite, resetDb } from "../persistence/db-connection.js";
import { stopQdrantManager } from "../persistence/embeddings/qdrant-manager.js";
import { stopMemoryJobsWorker } from "../persistence/jobs-worker.js";
import { stopMemoryWorkerProcess } from "../persistence/worker-control.js";
import { stopConsentRefresh } from "../platform/consent-cache.js";
import { HOOKS } from "../plugin-api/constants.js";
import { runHook } from "../plugins/pipeline.js";
import { stopRuntimeHttpServer } from "../runtime/http-server.js";
import { stopScheduler } from "../schedule/scheduler.js";
import { getSubagentManager } from "../subagent/index.js";
import { stopUsageTelemetryReporter } from "../telemetry/usage-telemetry-reporter.js";
import { browserManager } from "../tools/browser/browser-manager.js";
import { cleanupShellOutputTempFiles } from "../tools/shared/shell-output.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import { getEnrichmentService } from "../workspace/commit-message-enrichment-service.js";
import {
  commitAllPendingWorkspaceChanges,
  stopWorkspaceHeartbeatService,
} from "../workspace/heartbeat-service.js";
import { stopAppSourceWatcher } from "./app-source-watcher.js";
import { stopConfigWatcher } from "./config-watcher.js";
import { stopConversationEvictor } from "./conversation-evictor.js";
import { stopConversations } from "./conversation-store.js";
import { cleanupPidFile } from "./daemon-control.js";
import { stopEventLoopWatchdog } from "./event-loop-watchdog.js";
import { stopDiskPressureGuardForLifecycle } from "./lifecycle.js";
import { stopOrphanReaper } from "./orphan-reaper.js";

const log = getLogger("lifecycle");

/**
 * Stop the daemon's background services and remove the PID file. Invoked on
 * both the graceful-shutdown and force-exit-timeout paths so the process never
 * leaves a stale PID file or orphaned timers behind.
 */
function stopBackgroundServicesAndCleanupPidFile(): void {
  stopGatewayFlagListener();
  stopDiskPressureGuardForLifecycle();
  stopOrphanReaper();
  stopEventLoopWatchdog();
  cleanupPidFile();
}

let shuttingDown = false;

// Shared so a fatal error (unhandledRejection / uncaughtException) arriving
// mid-drain can upgrade the exit code of an already-running graceful shutdown
// from 0 to 1, ensuring supervisors and CI still see the failure.
let exitCode = 0;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Force exit if graceful shutdown takes too long.
  // Set this BEFORE awaiting heartbeat stop so it covers all
  // potentially-blocking async shutdown work.
  //
  // 20s budget: 15s reserved for Meet session teardown
  // (`MeetSessionManager.shutdownAll`), plus ~5s for the remaining
  // daemon work (workspace commits, server drain, enrichment, telemetry,
  // mcp, qdrant, sqlite checkpoint). Without a live Meet session the
  // rest of the shutdown routinely completes in under a second, so this
  // bump only changes behavior for the stuck-shutdown path.
  const forceTimer = setTimeout(() => {
    log.warn("Graceful shutdown timed out, forcing exit");
    stopBackgroundServicesAndCleanupPidFile();
    process.exit(1);
  }, 20_000);
  forceTimer.unref();

  await stopWorkspaceHeartbeatService();
  await stopHeartbeatService();

  // Stop the periodic consent-cache refresh (a daemon-owned interval).
  await stopConsentRefresh();

  // Fire plugin / user / workspace / skill `shutdown` hooks through the unified
  // hook pipeline — the same dispatch path every other lifecycle hook uses —
  // before stopping the server so any teardown work still has live transports.
  // We don't unregister tool/route surfaces here: the daemon is exiting, so that
  // in-memory registry state is discarded with the process anyway.
  try {
    await runHook(HOOKS.SHUTDOWN, {
      assistantVersion: APP_VERSION,
      reason: "shutdown",
    });
  } catch (err) {
    log.warn({ err }, "Plugin shutdown hooks failed (non-fatal)");
  }

  // Commit any uncommitted workspace changes before stopping the server.
  // This ensures no workspace state is lost during graceful shutdown.
  try {
    log.info({ phase: "pre_stop" }, "Committing pending workspace changes");
    await commitAllPendingWorkspaceChanges();
  } catch (err) {
    log.warn({ err, phase: "pre_stop" }, "Shutdown workspace commit failed");
  }

  // Abort all running subagents and tear down conversation-related state.
  getSubagentManager().disposeAll();
  disposeAcpSessionManager();
  stopConversationEvictor();
  stopConfigWatcher();
  stopAppSourceWatcher();
  stopCliIpcServer();
  stopConversations();
  await stopCes();

  // Final commit sweep: catch any writes that occurred during the
  // subagent/conversation teardown (e.g. in-flight tool executions
  // completing during drain).
  try {
    log.info({ phase: "post_stop" }, "Final workspace commit sweep");
    await commitAllPendingWorkspaceChanges();
  } catch (err) {
    log.warn({ err, phase: "post_stop" }, "Post-stop workspace commit failed");
  }

  // Flush in-flight enrichment jobs so shutdown commit notes are not dropped.
  // The enrichment service's shutdown() drains active jobs and discards pending ones.
  try {
    await getEnrichmentService().shutdown();
  } catch (err) {
    log.warn({ err }, "Enrichment service shutdown failed (non-fatal)");
  }

  try {
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Telemetry flush timed out")), 3_000),
    );
    await Promise.race([stopUsageTelemetryReporter(), timeout]);
  } catch (err) {
    log.warn({ err }, "Telemetry reporter shutdown failed (non-fatal)");
  }

  await stopRuntimeHttpServer();
  await browserManager.closeAllPages();
  cleanupShellOutputTempFiles();
  stopScheduler();

  // Stop the in-process memory worker supervisor if it was started on the
  // daemon's event loop (memory.worker.enabled = false).
  stopMemoryJobsWorker();

  // Stop the out-of-process memory worker if it's actually running. This is
  // keyed off live state rather than config: the worker may have been
  // spawned at startup (memory.worker.enabled = true) or out of band via
  // `assistant memory worker start`, so we stop whatever is actually there.
  try {
    const workerStatus = stopMemoryWorkerProcess();
    if (workerStatus.status === "running") {
      log.info(
        { pid: workerStatus.pid },
        "Sent SIGTERM to memory worker process",
      );
    }
  } catch (err) {
    log.warn({ err }, "Failed to stop memory worker process (non-fatal)");
  }

  try {
    await stopMcpServerManager();
  } catch (err) {
    log.warn({ err }, "MCP server manager shutdown failed (non-fatal)");
  }

  await stopQdrantManager();

  // Optimize query planner statistics before closing so they persist for
  // the next session. Checkpoint WAL and close SQLite so no writes are
  // lost on exit. Each step is in its own try block so later steps still
  // run if an earlier one throws (e.g. SQLITE_BUSY).
  try {
    getSqlite().exec("PRAGMA optimize");
  } catch (err) {
    log.warn({ err }, "PRAGMA optimize at shutdown failed (non-fatal)");
  }
  try {
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.warn({ err }, "WAL checkpoint failed (non-fatal)");
  }
  try {
    resetDb();
  } catch (err) {
    log.warn({ err }, "Database close failed (non-fatal)");
  }

  await Sentry.flush(2000);
  clearTimeout(forceTimer);
  stopBackgroundServicesAndCleanupPidFile();
  process.exit(exitCode);
}

export function installShutdownHandlers(): void {
  process.on("SIGTERM", () => {
    log.warn(
      { signal: "SIGTERM", pid: process.pid, uptime: process.uptime() },
      "Received SIGTERM — process termination requested",
    );
    void shutdown();
  });

  process.on("SIGINT", () => {
    log.warn(
      { signal: "SIGINT", pid: process.pid, uptime: process.uptime() },
      "Received SIGINT — user interrupt",
    );
    void shutdown();
  });

  process.on("SIGHUP", () => {
    log.warn(
      { signal: "SIGHUP", pid: process.pid, uptime: process.uptime() },
      "Received SIGHUP — terminal hangup",
    );
    void shutdown();
  });

  process.on("unhandledRejection", (reason) => {
    log.error(
      { err: reason },
      "Unhandled promise rejection — initiating shutdown",
    );
    Sentry.captureException(reason);
    exitCode = 1;
    void shutdown();
  });

  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception — initiating shutdown");
    Sentry.captureException(err);
    exitCode = 1;
    void shutdown();
  });
}
