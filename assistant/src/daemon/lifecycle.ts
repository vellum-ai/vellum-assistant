import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

import { resolve } from 'node:path';
import * as Sentry from '@sentry/node';
import {
  getSocketPath,
  getPidPath,
  ensureDataDir,
  migrateToDataLayout,
  removeSocketFile,
} from '../util/platform.js';
import { initializeDb } from '../memory/db.js';
import { rotateToolInvocations } from '../memory/tool-usage-store.js';
import { initializeProviders } from '../providers/registry.js';
import { initializeTools } from '../tools/registry.js';
import { loadConfig } from '../config/loader.js';
import { ensurePromptFiles } from '../config/system-prompt.js';
import { DaemonServer } from './server.js';
import { getLogger } from '../util/logger.js';
import { DaemonError } from '../util/errors.js';
import { startMemoryJobsWorker } from '../memory/jobs-worker.js';
import { QdrantManager } from '../memory/qdrant-manager.js';
import { initQdrantClient } from '../memory/qdrant-client.js';
import { startScheduler } from '../schedule/scheduler.js';
import { browserManager } from '../tools/browser/browser-manager.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { getHookManager } from '../hooks/manager.js';
import { installTemplates } from '../hooks/templates.js';

const log = getLogger('lifecycle');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  writeFileSync(getPidPath(), String(pid));
}

function cleanupPidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  if (!isProcessRunning(pid)) {
    // Stale PID file
    cleanupPidFile();
    return false;
  }
  return true;
}

export function getDaemonStatus(): { running: boolean; pid?: number } {
  const pid = readPid();
  if (pid === null) return { running: false };
  if (!isProcessRunning(pid)) {
    cleanupPidFile();
    return { running: false };
  }
  return { running: true, pid };
}

export async function startDaemon(): Promise<{
  pid: number;
  alreadyRunning: boolean;
}> {
  const status = getDaemonStatus();
  if (status.running && status.pid) {
    return { pid: status.pid, alreadyRunning: true };
  }

  ensureDataDir();

  // Clean up stale socket (only if it's actually a Unix socket)
  const socketPath = getSocketPath();
  removeSocketFile(socketPath);

  // Spawn the daemon as a detached child process
  const mainPath = resolve(
    import.meta.dirname ?? __dirname,
    'main.ts',
  );

  const child = spawn('bun', ['run', mainPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new DaemonError('Failed to start daemon: no PID returned');
  }

  writePid(pid);

  // Wait for socket to appear
  const maxWait = 5000;
  const interval = 100;
  let waited = 0;
  while (waited < maxWait) {
    if (existsSync(socketPath)) {
      return { pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  throw new DaemonError(
    'Daemon started but socket not available after 5 seconds',
  );
}

export async function stopDaemon(): Promise<{ stopped: boolean }> {
  const pid = readPid();
  if (pid === null || !isProcessRunning(pid)) {
    cleanupPidFile();
    return { stopped: false };
  }

  process.kill(pid, 'SIGTERM');

  // Wait for process to exit
  const maxWait = 5000;
  const interval = 100;
  let waited = 0;
  while (waited < maxWait) {
    if (!isProcessRunning(pid)) {
      cleanupPidFile();
      return { stopped: true };
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    log.debug({ err, pid }, 'SIGKILL failed, process already exited');
  }
  cleanupPidFile();
  return { stopped: true };
}

export async function ensureDaemonRunning(): Promise<void> {
  if (isDaemonRunning()) return;
  await startDaemon();
}

// Entry point for the daemon process itself
export async function runDaemon(): Promise<void> {
  migrateToDataLayout();
  ensureDataDir();
  installTemplates();
  ensurePromptFiles();
  initializeDb();

  const config = loadConfig();

  initializeProviders(config);
  await initializeTools();

  // Initialize Qdrant vector store — non-fatal so the daemon stays up without it
  const qdrantUrl = process.env.QDRANT_URL?.trim() || config.memory.qdrant.url;
  const qdrantManager = new QdrantManager({
    url: qdrantUrl,
  });
  try {
    await qdrantManager.start();
    initQdrantClient({
      url: qdrantUrl,
      collection: config.memory.qdrant.collection,
      vectorSize: config.memory.qdrant.vectorSize,
      onDisk: config.memory.qdrant.onDisk,
      quantization: config.memory.qdrant.quantization,
    });
    log.info('Qdrant vector store initialized');
  } catch (err) {
    log.warn({ err }, 'Qdrant failed to start — memory features will be unavailable');
  }

  const server = new DaemonServer();
  await server.start();
  const memoryWorker = startMemoryJobsWorker();
  const scheduler = startScheduler(async (conversationId, message) => {
    await server.processMessage('schedule', conversationId, message);
  });

  // Start optional runtime HTTP server when RUNTIME_HTTP_PORT is set
  let runtimeHttp: RuntimeHttpServer | null = null;
  const httpPortEnv = process.env.RUNTIME_HTTP_PORT;
  if (httpPortEnv) {
    const port = parseInt(httpPortEnv, 10);
    if (!isNaN(port) && port > 0) {
      runtimeHttp = new RuntimeHttpServer({
        port,
        processMessage: (assistantId, conversationId, content, attachmentIds) =>
          server.processMessage(assistantId, conversationId, content, attachmentIds),
        persistAndProcessMessage: (assistantId, conversationId, content, attachmentIds) =>
          server.persistAndProcessMessage(assistantId, conversationId, content, attachmentIds),
        runOrchestrator: server.createRunOrchestrator(),
      });
      try {
        await runtimeHttp.start();
        server.setHttpPort(port);
      } catch (err) {
        log.warn({ err, port }, 'Failed to start runtime HTTP server, continuing without it');
        runtimeHttp = null;
      }
    }
  }

  writePid(process.pid);
  log.info({ pid: process.pid }, 'Daemon started');

  const hookManager = getHookManager();
  hookManager.watch();

  void hookManager.trigger('daemon-start', {
    pid: process.pid,
    socketPath: getSocketPath(),
  });

  // Rotate old audit log entries after startup handshake is complete.
  // This runs after the socket is listening so it won't block the 5s
  // readiness window in startDaemon().
  if (config.auditLog.retentionDays > 0) {
    try {
      rotateToolInvocations(config.auditLog.retentionDays);
    } catch (err) {
      log.warn({ err }, 'Audit log rotation failed');
    }
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent re-entrant shutdown
    shuttingDown = true;
    log.info('Shutting down daemon...');

    hookManager.stopWatching();

    // Force exit if graceful shutdown takes too long.
    // Set this BEFORE triggering daemon-stop hooks so it covers hook execution time.
    const forceTimer = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      cleanupPidFile();
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    try {
      await hookManager.trigger('daemon-stop', { pid: process.pid });
    } catch {
      // Don't let hook failures block shutdown
    }

    await server.stop();
    if (runtimeHttp) await runtimeHttp.stop();
    await browserManager.closeAllPages();
    scheduler.stop();
    memoryWorker.stop();
    await qdrantManager.stop();
    await Sentry.flush(2000);
    cleanupPidFile();
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
