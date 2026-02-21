import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import * as Sentry from '@sentry/node';
import {
  getInterfacesDir,
  getSocketPath,
  getPidPath,
  getHttpTokenPath,
  getRootDir,
  ensureDataDir,
  migrateToDataLayout,
  migrateToWorkspaceLayout,
  removeSocketFile,
} from '../util/platform.js';
import { initializeDb } from '../memory/db.js';
import { rotateToolInvocations } from '../memory/tool-usage-store.js';
import { initializeProviders } from '../providers/registry.js';
import { initializeTools } from '../tools/registry.js';
import { loadConfig } from '../config/loader.js';
import { ensurePromptFiles } from '../config/system-prompt.js';
import { loadPrebuiltHtml } from '../home-base/prebuilt/seed.js';
import { DaemonServer } from './server.js';
import { listWorkItems, updateWorkItem } from '../work-items/work-item-store.js';
import { getLogger, initLogger } from '../util/logger.js';
import { DaemonError } from '../util/errors.js';
import { initSentry } from '../instrument.js';
import { initLogfire } from '../logfire.js';
import { startMemoryJobsWorker } from '../memory/jobs-worker.js';
import { QdrantManager } from '../memory/qdrant-manager.js';
import { initQdrantClient } from '../memory/qdrant-client.js';
import { startScheduler } from '../schedule/scheduler.js';
import { initWatcherEngine } from '../watcher/engine.js';
import { registerWatcherProvider } from '../watcher/provider-registry.js';
import { gmailProvider } from '../watcher/providers/gmail.js';
import { googleCalendarProvider } from '../watcher/providers/google-calendar.js';
import { slackProvider as slackWatcherProvider } from '../watcher/providers/slack.js';
import { registerMessagingProvider } from '../messaging/registry.js';
import { slackProvider as slackMessagingProvider } from '../messaging/providers/slack/adapter.js';
import { gmailMessagingProvider } from '../messaging/providers/gmail/adapter.js';
import { browserManager } from '../tools/browser/browser-manager.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { getHookManager } from '../hooks/manager.js';
import { installTemplates } from '../hooks/templates.js';
import { HeartbeatService } from '../workspace/heartbeat-service.js';
import { AgentHeartbeatService } from '../agent-heartbeat/agent-heartbeat-service.js';
import { getEnrichmentService } from '../workspace/commit-message-enrichment-service.js';
import { reconcileCallsOnStartup } from '../calls/call-recovery.js';
import { TwilioConversationRelayProvider } from '../calls/twilio-provider.js';

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

  // Only create the root dir for socket/PID — the daemon process itself
  // handles migration + full ensureDataDir() in runDaemon(). Calling
  // ensureDataDir() here would pre-create workspace destination dirs
  // and cause migration moves to no-op.
  const rootDir = getRootDir();
  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }

  // Clean up stale socket (only if it's actually a Unix socket)
  const socketPath = getSocketPath();
  removeSocketFile(socketPath);

  // Spawn the daemon as a detached child process
  const mainPath = resolve(
    import.meta.dirname ?? __dirname,
    'main.ts',
  );

  // Redirect the child's stderr to a file instead of piping it back to the
  // parent. A pipe's read end is destroyed when the parent exits, leaving
  // fd 2 broken in the child. Bun (unlike Node.js) does not ignore SIGPIPE,
  // so any later stderr write would silently kill the daemon.
  const stderrPath = join(rootDir, 'daemon-stderr.log');
  const stderrFd = openSync(stderrPath, 'w');

  const child = spawn('bun', ['run', mainPath], {
    detached: true,
    stdio: ['ignore', 'ignore', stderrFd],
    env: { ...process.env },
  });

  // The child inherited the fd; close the parent's copy.
  closeSync(stderrFd);

  let childExited = false;
  let childExitCode: number | null = null;
  child.on('exit', (code) => {
    childExited = true;
    childExitCode = code;
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
    if (childExited) {
      cleanupPidFile();
      const stderr = readFileSync(stderrPath, 'utf-8').trim();
      const detail = stderr
        ? `\n${stderr}`
        : `\nCheck logs at ~/.vellum/workspace/data/logs/ for details.`;
      throw new DaemonError(
        `Daemon exited immediately (code ${childExitCode ?? 'unknown'}).${detail}`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  throw new DaemonError(
    'Daemon started but socket not available after 5 seconds',
  );
}

export type StopResult =
  | { stopped: true }
  | { stopped: false; reason: 'not_running' | 'stop_failed' };

export async function stopDaemon(): Promise<StopResult> {
  const pid = readPid();
  if (pid === null || !isProcessRunning(pid)) {
    cleanupPidFile();
    return { stopped: false, reason: 'not_running' };
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

  // Wait for the process to actually die after SIGKILL. Without this,
  // startDaemon() can race with the dying process's shutdown handler,
  // which removes the socket file and bricks the new daemon.
  const killMaxWait = 2000;
  let killWaited = 0;
  while (killWaited < killMaxWait && isProcessRunning(pid)) {
    await new Promise((r) => setTimeout(r, 100));
    killWaited += 100;
  }

  // Only clean up if the process has actually exited.
  // If it's still alive after SIGKILL + timeout, preserve both socket
  // and PID file so isDaemonRunning() still reports true and prevents
  // a duplicate daemon from being spawned.
  if (!isProcessRunning(pid)) {
    removeSocketFile(getSocketPath());
    cleanupPidFile();
    return { stopped: true };
  }

  log.warn({ pid }, 'Daemon process still running after SIGKILL + timeout, leaving socket and PID file intact');
  return { stopped: false, reason: 'stop_failed' };
}

export async function ensureDaemonRunning(): Promise<void> {
  if (isDaemonRunning()) return;
  await startDaemon();
}

function loadDotEnv(): void {
  dotenvConfig({ path: join(getRootDir(), '.env'), quiet: true });
}

// Entry point for the daemon process itself
export async function runDaemon(): Promise<void> {
  loadDotEnv();
  initSentry();
  await initLogfire();

  // Migration order matters: first move legacy flat files into the data dir
  // structure, then relocate the data dir into the active workspace, and
  // finally create any directories that don't yet exist.
  migrateToDataLayout();
  migrateToWorkspaceLayout();
  ensureDataDir();

  log.info('Daemon startup: migrations complete');

  // Seed the TUI main-window interface from the CLI package's DefaultMainScreen
  // component so the remote runtime can serve it without the old INTERFACES_SEED
  // environment variable.
  const tuiDir = join(getInterfacesDir(), 'tui');
  const mainWindowPath = join(tuiDir, 'main-window.tsx');
  if (!existsSync(mainWindowPath)) {
    try {
      const require = createRequire(import.meta.url);
      const cliPkgPath = require.resolve('@vellumai/cli/package.json');
      const cliRoot = dirname(cliPkgPath);
      const source = readFileSync(join(cliRoot, 'src', 'components', 'DefaultMainScreen.tsx'), 'utf-8');
      mkdirSync(tuiDir, { recursive: true });
      writeFileSync(mainWindowPath, source);
      log.info('Seeded tui/main-window.tsx from @vellumai/cli');
    } catch (err) {
      log.warn({ err }, 'Could not seed tui/main-window.tsx from CLI package');
    }
  }

  // Seed the vellum-desktop interface from the prebuilt Home Base HTML if it
  // doesn't already exist. This ensures the Home tab renders immediately
  // on first launch for both local and remote hatches.
  const desktopIndexPath = join(getInterfacesDir(), 'vellum-desktop', 'index.html');
  if (!existsSync(desktopIndexPath)) {
    const prebuiltHtml = loadPrebuiltHtml();
    if (prebuiltHtml) {
      mkdirSync(join(getInterfacesDir(), 'vellum-desktop'), { recursive: true });
      writeFileSync(desktopIndexPath, prebuiltHtml);
      log.info('Seeded vellum-desktop/index.html from prebuilt Home Base');
    } else {
      log.warn('Could not seed vellum-desktop/index.html — prebuilt HTML not found (missing embedded index.html in home-base/prebuilt/)');
    }
  }

  log.info('Daemon startup: installing templates and initializing DB');
  installTemplates();
  ensurePromptFiles();
  initializeDb();
  log.info('Daemon startup: DB initialized');

  // Recover orphaned work items that were left in 'running' state when the
  // daemon previously crashed or was killed mid-task.
  const orphanedRunning = listWorkItems({ status: 'running' });
  if (orphanedRunning.length > 0) {
    for (const item of orphanedRunning) {
      updateWorkItem(item.id, { status: 'failed', lastRunStatus: 'interrupted' });
      log.info({ workItemId: item.id, title: item.title }, 'Recovered orphaned running work item → failed (interrupted)');
    }
    log.info({ count: orphanedRunning.length }, 'Recovered orphaned running work items');
  }

  // Reconcile in-flight calls that were left in non-terminal states
  // after a daemon crash or restart.
  try {
    const twilioProvider = new TwilioConversationRelayProvider();
    await reconcileCallsOnStartup(twilioProvider, log);
  } catch (err) {
    log.warn({ err }, 'Call recovery failed — continuing startup');
  }

  log.info('Daemon startup: loading config');
  const config = loadConfig();

  if (config.logFile.dir) {
    initLogger({ dir: config.logFile.dir, retentionDays: config.logFile.retentionDays });
  }

  log.info('Daemon startup: initializing providers and tools');
  initializeProviders(config);
  await initializeTools();
  log.info('Daemon startup: providers and tools initialized');

  // Start the IPC socket BEFORE Qdrant so that clients can connect
  // immediately. Qdrant startup can take 30+ seconds (binary download,
  // /readyz polling) which previously blocked the socket from appearing.
  log.info('Daemon startup: starting DaemonServer (IPC socket)');
  const server = new DaemonServer();
  await server.start();
  log.info('Daemon startup: DaemonServer started');

  // Initialize Qdrant vector store — non-fatal so the daemon stays up without it
  const qdrantUrl = process.env.QDRANT_URL?.trim() || config.memory.qdrant.url;
  log.info({ qdrantUrl }, 'Daemon startup: initializing Qdrant');
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

  log.info('Daemon startup: starting memory worker');
  const memoryWorker = startMemoryJobsWorker();
  // Initialize watcher engine and register providers
  registerWatcherProvider(gmailProvider);
  registerWatcherProvider(googleCalendarProvider);
  registerWatcherProvider(slackWatcherProvider);
  initWatcherEngine();

  // Register messaging providers
  registerMessagingProvider(slackMessagingProvider);
  registerMessagingProvider(gmailMessagingProvider);

  const scheduler = startScheduler(
    async (conversationId, message) => {
      await server.processMessage(conversationId, message);
    },
    (reminder) => {
      server.broadcast({
        type: 'reminder_fired',
        reminderId: reminder.id,
        label: reminder.label,
        message: reminder.message,
      });
    },
    (schedule) => {
      server.broadcast({
        type: 'schedule_complete',
        scheduleId: schedule.id,
        name: schedule.name,
      });
    },
    (notification) => {
      server.broadcast({
        type: 'watcher_notification',
        title: notification.title,
        body: notification.body,
      });
    },
    (params) => {
      server.broadcast({
        type: 'watcher_escalation',
        title: params.title,
        body: params.body,
      });
    },
  );

  // Start optional runtime HTTP server when RUNTIME_HTTP_PORT is set
  let runtimeHttp: RuntimeHttpServer | null = null;
  const httpPortEnv = process.env.RUNTIME_HTTP_PORT;
  log.info({ httpPortEnv }, 'Daemon startup: checking RUNTIME_HTTP_PORT');
  if (httpPortEnv) {
    const port = parseInt(httpPortEnv, 10);
    if (!isNaN(port) && port > 0) {
      // Use an explicit env var if provided; otherwise generate a fresh
      // random token. Either way, write it to disk so HTTP clients and
      // the gateway can authenticate.
      const bearerToken = process.env.RUNTIME_PROXY_BEARER_TOKEN || randomBytes(32).toString('hex');
      const httpTokenPath = getHttpTokenPath();
      writeFileSync(httpTokenPath, bearerToken, { mode: 0o600 });
      chmodSync(httpTokenPath, 0o600);

      const hostname = process.env.RUNTIME_HTTP_HOST?.trim() || '127.0.0.1';

      runtimeHttp = new RuntimeHttpServer({
        port,
        hostname,
        bearerToken,
        processMessage: (conversationId, content, attachmentIds, options, sourceChannel) =>
          server.processMessage(conversationId, content, attachmentIds, options, sourceChannel),
        persistAndProcessMessage: (conversationId, content, attachmentIds, options, sourceChannel) =>
          server.persistAndProcessMessage(conversationId, content, attachmentIds, options, sourceChannel),
        runOrchestrator: server.createRunOrchestrator(),
        interfacesDir: getInterfacesDir(),
      });
      try {
        log.info({ port, hostname }, 'Daemon startup: starting runtime HTTP server');
        await runtimeHttp.start();
        server.setHttpPort(port);
        log.info({ port, hostname }, 'Daemon startup: runtime HTTP server listening');
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

  // Start workspace heartbeat service. This periodically checks all
  // tracked workspaces for uncommitted changes and auto-commits when
  // thresholds are exceeded (age > 5 min OR > 20 files changed).
  // Acts as a safety net for long-running operations or background
  // processes that modify workspace files between turn-boundary commits.
  const heartbeat = new HeartbeatService();
  heartbeat.start();

  // Start model-driven heartbeat service (opt-in via config).
  const agentHeartbeat = new AgentHeartbeatService({
    processMessage: (conversationId, content) =>
      server.processMessage(conversationId, content),
    alerter: (alert) => server.broadcast(alert),
  });
  agentHeartbeat.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent re-entrant shutdown
    shuttingDown = true;
    log.info('Shutting down daemon...');

    hookManager.stopWatching();

    // Force exit if graceful shutdown takes too long.
    // Set this BEFORE awaiting heartbeat stop and triggering daemon-stop hooks
    // so it covers all potentially-blocking async shutdown work.
    const forceTimer = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      cleanupPidFile();
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    await heartbeat.stop();
    await agentHeartbeat.stop();

    try {
      await hookManager.trigger('daemon-stop', { pid: process.pid });
    } catch {
      // Don't let hook failures block shutdown
    }

    // Commit any uncommitted workspace changes before stopping the server.
    // This ensures no workspace state is lost during graceful shutdown.
    try {
      log.info({ phase: 'pre_stop' }, 'Committing pending workspace changes');
      await heartbeat.commitAllPending();
    } catch (err) {
      log.warn({ err, phase: 'pre_stop' }, 'Shutdown workspace commit failed');
    }

    await server.stop();

    // Final commit sweep: catch any writes that occurred during server.stop()
    // (e.g. in-flight tool executions completing during drain).
    try {
      log.info({ phase: 'post_stop' }, 'Final workspace commit sweep');
      await heartbeat.commitAllPending();
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

    if (runtimeHttp) await runtimeHttp.stop();
    await browserManager.closeAllPages();
    scheduler.stop();
    memoryWorker.stop();
    await qdrantManager.stop();
    await Sentry.flush(2000);
    clearTimeout(forceTimer);
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
