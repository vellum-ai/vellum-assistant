import * as Sentry from "@sentry/node";

import type { FilingService } from "../filing/filing-service.js";
import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import type { McpServerManager } from "../mcp/manager.js";
import { getSqlite, resetDb } from "../memory/db-connection.js";
import type { QdrantManager } from "../memory/qdrant-manager.js";
import type { RuntimeHttpServer } from "../runtime/http-server.js";
import { browserManager } from "../tools/browser/browser-manager.js";
import { cleanupShellOutputTempFiles } from "../tools/shared/shell-output.js";
import { getLogger } from "../util/logger.js";
import { getEnrichmentService } from "../workspace/commit-message-enrichment-service.js";
import type { WorkspaceHeartbeatService } from "../workspace/heartbeat-service.js";
import type { DaemonServer } from "./server.js";
import { runShutdownHooks } from "./shutdown-registry.js";

const log = getLogger("lifecycle");

export interface ShutdownDeps {
  server: DaemonServer;
  workspaceHeartbeat: WorkspaceHeartbeatService;
  heartbeat: HeartbeatService;
  filing: FilingService | null;
  runtimeHttp: RuntimeHttpServer | null;
  scheduler: { stop(): void };
  feedScheduler: { stop(): void } | null;
  getMemoryWorker: () => { stop(): void } | null;
  getQdrantManager: () => QdrantManager | null;
  mcpManager: McpServerManager | null;
  telemetryReporter: { stop(): Promise<void> } | null;
  cleanupPidFile: () => void;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;
  let exitCode = 0;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down daemon...");

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
      deps.cleanupPidFile();
      process.exit(1);
    }, 20_000);
    forceTimer.unref();

    await deps.workspaceHeartbeat.stop();
    await deps.heartbeat.stop();
    if (deps.filing) await deps.filing.stop();

    // Run registered skill shutdown hooks (e.g. meet-join session teardown)
    // before stopping the server so any HTTP round-trips and SSE emissions
    // still have live transports.
    try {
      await runShutdownHooks("daemon-shutdown");
    } catch (err) {
      log.warn({ err }, "Skill shutdown hooks failed (non-fatal)");
    }

    // Commit any uncommitted workspace changes before stopping the server.
    // This ensures no workspace state is lost during graceful shutdown.
    try {
      log.info({ phase: "pre_stop" }, "Committing pending workspace changes");
      await deps.workspaceHeartbeat.commitAllPending();
    } catch (err) {
      log.warn({ err, phase: "pre_stop" }, "Shutdown workspace commit failed");
    }

    await deps.server.stop();

    // Final commit sweep: catch any writes that occurred during server.stop()
    // (e.g. in-flight tool executions completing during drain).
    try {
      log.info({ phase: "post_stop" }, "Final workspace commit sweep");
      await deps.workspaceHeartbeat.commitAllPending();
    } catch (err) {
      log.warn(
        { err, phase: "post_stop" },
        "Post-stop workspace commit failed",
      );
    }

    // Flush in-flight enrichment jobs so shutdown commit notes are not dropped.
    // The enrichment service's shutdown() drains active jobs and discards pending ones.
    try {
      await getEnrichmentService().shutdown();
    } catch (err) {
      log.warn({ err }, "Enrichment service shutdown failed (non-fatal)");
    }

    if (deps.telemetryReporter) {
      try {
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("Telemetry flush timed out")),
            3_000,
          ),
        );
        await Promise.race([deps.telemetryReporter.stop(), timeout]);
      } catch (err) {
        log.warn({ err }, "Telemetry reporter shutdown failed (non-fatal)");
      }
    }

    if (deps.runtimeHttp) await deps.runtimeHttp.stop();
    await browserManager.closeAllPages();
    cleanupShellOutputTempFiles();
    deps.scheduler.stop();
    deps.feedScheduler?.stop();
    deps.getMemoryWorker()?.stop();

    if (deps.mcpManager) {
      try {
        await deps.mcpManager.stop();
      } catch (err) {
        log.warn({ err }, "MCP server manager shutdown failed (non-fatal)");
      }
    }

    await deps.getQdrantManager()?.stop();

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
    deps.cleanupPidFile();
    process.exit(exitCode);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);

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
