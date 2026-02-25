import * as Sentry from '@sentry/node';
import { getSqlite, resetDb } from '../memory/db.js';
import { browserManager } from '../tools/browser/browser-manager.js';
import { getEnrichmentService } from '../workspace/commit-message-enrichment-service.js';
import { getLogger } from '../util/logger.js';
import type { DaemonServer } from './server.js';
import type { RuntimeHttpServer } from '../runtime/http-server.js';
import type { HeartbeatService } from '../workspace/heartbeat-service.js';
import type { AgentHeartbeatService } from '../agent-heartbeat/agent-heartbeat-service.js';
import type { QdrantManager } from '../memory/qdrant-manager.js';
import type { HookManager } from '../hooks/manager.js';

const log = getLogger('lifecycle');

export interface ShutdownDeps {
  server: DaemonServer;
  heartbeat: HeartbeatService;
  agentHeartbeat: AgentHeartbeatService;
  hookManager: HookManager;
  runtimeHttp: RuntimeHttpServer | null;
  scheduler: { stop(): void };
  memoryWorker: { stop(): void };
  recordingCleanup: { stop(): void };
  qdrantManager: QdrantManager;
  cleanupPidFile: () => void;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down daemon...');

    deps.hookManager.stopWatching();

    // Force exit if graceful shutdown takes too long.
    // Set this BEFORE awaiting heartbeat stop and triggering daemon-stop hooks
    // so it covers all potentially-blocking async shutdown work.
    const forceTimer = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      deps.cleanupPidFile();
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    await deps.heartbeat.stop();
    await deps.agentHeartbeat.stop();

    try {
      await deps.hookManager.trigger('daemon-stop', { pid: process.pid });
    } catch {
      // Don't let hook failures block shutdown
    }

    // Commit any uncommitted workspace changes before stopping the server.
    // This ensures no workspace state is lost during graceful shutdown.
    try {
      log.info({ phase: 'pre_stop' }, 'Committing pending workspace changes');
      await deps.heartbeat.commitAllPending();
    } catch (err) {
      log.warn({ err, phase: 'pre_stop' }, 'Shutdown workspace commit failed');
    }

    await deps.server.stop();

    // Final commit sweep: catch any writes that occurred during server.stop()
    // (e.g. in-flight tool executions completing during drain).
    try {
      log.info({ phase: 'post_stop' }, 'Final workspace commit sweep');
      await deps.heartbeat.commitAllPending();
    } catch (err) {
      log.warn({ err, phase: 'post_stop' }, 'Post-stop workspace commit failed');
    }

    // Flush in-flight enrichment jobs so shutdown commit notes are not dropped.
    // The enrichment service's shutdown() drains active jobs and discards pending ones.
    try {
      await getEnrichmentService().shutdown();
    } catch (err) {
      log.warn({ err }, 'Enrichment service shutdown failed (non-fatal)');
    }

    if (deps.runtimeHttp) await deps.runtimeHttp.stop();
    await browserManager.closeAllPages();
    deps.scheduler.stop();
    deps.memoryWorker.stop();
    deps.recordingCleanup.stop();
    await deps.qdrantManager.stop();

    // Checkpoint WAL and close SQLite so no writes are lost on exit.
    // Checkpoint and close are in separate try blocks so that close()
    // always runs even if checkpointing throws (e.g. SQLITE_BUSY).
    try {
      getSqlite().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log.warn({ err }, 'WAL checkpoint failed (non-fatal)');
    }
    try {
      resetDb();
    } catch (err) {
      log.warn({ err }, 'Database close failed (non-fatal)');
    }

    await Sentry.flush(2000);
    clearTimeout(forceTimer);
    deps.cleanupPidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
    Sentry.captureException(reason);
  });

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'Uncaught exception');
    Sentry.captureException(err);
  });
}
