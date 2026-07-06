import * as Sentry from "@sentry/node";

import { disposeAcpSessionManager } from "../acp/index.js";
import { stopCes } from "../credential-execution/ces-runtime.js";
import { stopHeartbeatService } from "../heartbeat/heartbeat-service.js";
import { stopCliIpcServer } from "../ipc/assistant-server.js";
import { stopGatewayFlagListener } from "../ipc/gateway-flag-listener.js";
import { stopMcpServerManager } from "../mcp/manager.js";
import { stopMonitoring } from "../monitoring/control.js";
import {
  runAsyncSqlite,
  spawnDetachedWalCheckpoint,
} from "../persistence/db-async-query.js";
import { getSqlite, isDbOpen, resetDb } from "../persistence/db-connection.js";
import { stopQdrantManager } from "../persistence/embeddings/qdrant-manager.js";
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
import { cleanupPidFile, cleanupPidFileIfOwner } from "./daemon-control.js";
import { isStartupComplete } from "./daemon-readiness.js";
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
    // A stuck shutdown may never reach the graceful WAL checkpoint below —
    // fold the WAL from a detached subprocess that survives this exit, so
    // the next boot opens a small WAL instead of paying a multi-minute
    // recovery. Skipped when the DB was never opened: there is nothing to
    // fold, and sqlite3 would create an empty DB file.
    if (isDbOpen() && !spawnDetachedWalCheckpoint()) {
      log.warn(
        "No sqlite3 CLI on host — WAL left at high-water mark on force-exit",
      );
    }
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

  // Stop the resource monitor process if it's actually running.
  stopMonitoring();

  try {
    await stopMcpServerManager();
  } catch (err) {
    log.warn({ err }, "MCP server manager shutdown failed (non-fatal)");
  }

  await stopQdrantManager();

  // Optimize query planner statistics before closing so they persist for
  // the next session. Checkpoint WAL and close SQLite so no writes are
  // lost on exit. Each step is in its own try block so later steps still
  // run if an earlier one throws (e.g. SQLITE_BUSY). Skipped entirely when
  // the DB was never opened: there is nothing to persist, fold, or close,
  // and the lazy `getSqlite()` accessor would open the database just to
  // tear it down.
  if (isDbOpen()) {
    try {
      getSqlite().exec("PRAGMA optimize");
    } catch (err) {
      log.warn({ err }, "PRAGMA optimize at shutdown failed (non-fatal)");
    }
    // Fold the WAL back into the main database so the next boot opens a
    // small WAL instead of paying a multi-minute recovery (see
    // `checkpointWalBeforeOpen` in db-init.ts). Runs through `runAsyncSqlite`
    // (sqlite3 subprocess when available) because a synchronous checkpoint
    // of a WAL at its high-water mark blocks the event loop, which keeps the
    // force-exit timer above from ever firing. Off the loop, the timer stays
    // armed — and if it fires mid-checkpoint, the subprocess survives
    // `process.exit` and finishes the fold in the background.
    try {
      const checkpointResult = await runAsyncSqlite(
        "PRAGMA wal_checkpoint(TRUNCATE)",
        "shutdown:wal-checkpoint-truncate",
      );
      if (checkpointResult.ok) {
        log.info(
          {
            backend: checkpointResult.backend,
            elapsedMs: checkpointResult.elapsedMs,
          },
          "Shutdown WAL checkpoint complete",
        );
      } else {
        log.warn(
          { error: checkpointResult.error, backend: checkpointResult.backend },
          "WAL checkpoint failed (non-fatal)",
        );
      }
    } catch (err) {
      log.warn({ err }, "WAL checkpoint failed (non-fatal)");
    }
    try {
      resetDb();
    } catch (err) {
      log.warn({ err }, "Database close failed (non-fatal)");
    }
  }

  await Sentry.flush(2000);
  clearTimeout(forceTimer);
  stopBackgroundServicesAndCleanupPidFile();
  process.exit(exitCode);
}

/**
 * Minimal exit for signals and fatal errors that land before startup
 * completes. The graceful `shutdown()` path assumes started subsystems and
 * would interleave its teardown with the still-running startup sequence, so
 * this path does only the work that matters mid-boot: fold the WAL when the
 * DB is already open (detached, so the fold survives the exit) and remove
 * the PID file when this process wrote it — ownership-checked so a duplicate
 * daemon exiting early never deletes the live daemon's PID file.
 */
function exitDuringStartup(code: number): void {
  if (isDbOpen()) {
    spawnDetachedWalCheckpoint();
  }
  cleanupPidFileIfOwner(process.pid);
  process.exit(code);
}

function handleShutdownSignal(signal: string, message: string): void {
  log.warn({ signal, pid: process.pid, uptime: process.uptime() }, message);
  if (!isStartupComplete()) {
    log.warn(
      { signal },
      "Signal arrived before startup completed — exiting without graceful shutdown",
    );
    exitDuringStartup(0);
    return;
  }
  void shutdown();
}

function handleFatalError(err: unknown, message: string): void {
  log.error({ err }, message);
  Sentry.captureException(err);
  exitCode = 1;
  if (!isStartupComplete()) {
    exitDuringStartup(1);
    return;
  }
  void shutdown();
}

/**
 * Install signal and fatal-error handlers. Runs before any blocking startup
 * work — a boot that inherits a large WAL can spend minutes in DB init, and
 * without handlers a SIGTERM in that window is the default hard kill (no WAL
 * fold, no PID cleanup). Handlers stay in the minimal `exitDuringStartup`
 * mode until `setStartupComplete()` marks the daemon ready; from then on
 * signals run the full graceful `shutdown()`.
 */
export function installShutdownHandlers(): void {
  process.on("SIGTERM", () => {
    handleShutdownSignal(
      "SIGTERM",
      "Received SIGTERM — process termination requested",
    );
  });

  process.on("SIGINT", () => {
    handleShutdownSignal("SIGINT", "Received SIGINT — user interrupt");
  });

  process.on("SIGHUP", () => {
    handleShutdownSignal("SIGHUP", "Received SIGHUP — terminal hangup");
  });

  process.on("unhandledRejection", (reason) => {
    handleFatalError(
      reason,
      "Unhandled promise rejection — initiating shutdown",
    );
  });

  process.on("uncaughtException", (err) => {
    handleFatalError(err, "Uncaught exception — initiating shutdown");
  });
}
