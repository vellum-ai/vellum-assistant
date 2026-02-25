import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import {
  getInterfacesDir,
  getSocketPath,
  getHttpTokenPath,
  getRootDir,
  ensureDataDir,
} from '../util/platform.js';
import { migrateToDataLayout } from '../migrations/data-layout.js';
import { migrateToWorkspaceLayout } from '../migrations/workspace-layout.js';
import { initializeDb } from '../memory/db.js';
import { rotateToolInvocations } from '../memory/tool-usage-store.js';
import { loadConfig } from '../config/loader.js';
import {
  getQdrantUrlEnv,
  getRuntimeHttpPort,
  getRuntimeProxyBearerToken,
  getRuntimeHttpHost,
  validateEnv,
} from '../config/env.js';
import { ensurePromptFiles } from '../config/system-prompt.js';
import { loadPrebuiltHtml } from '../home-base/prebuilt/seed.js';
import { DaemonServer } from './server.js';
import { setRelayBroadcast } from '../calls/relay-server.js';
import { listWorkItems, updateWorkItem } from '../work-items/work-item-store.js';
import { getLogger, initLogger } from '../util/logger.js';
import { initSentry } from '../instrument.js';
import { initLogfire } from '../logfire.js';
import { startMemoryJobsWorker } from '../memory/jobs-worker.js';
import { QdrantManager } from '../memory/qdrant-manager.js';
import { initQdrantClient } from '../memory/qdrant-client.js';
import { startScheduler } from '../schedule/scheduler.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { getHookManager } from '../hooks/manager.js';
import { installTemplates } from '../hooks/templates.js';
import { installCliLaunchers } from './install-cli-launchers.js';
import { HeartbeatService } from '../workspace/heartbeat-service.js';
import { AgentHeartbeatService } from '../agent-heartbeat/agent-heartbeat-service.js';
import { reconcileCallsOnStartup } from '../calls/call-recovery.js';
import { TwilioConversationRelayProvider } from '../calls/twilio-provider.js';
import { createApprovalCopyGenerator, createApprovalConversationGenerator } from './approval-generators.js';
import { initializeProvidersAndTools, registerWatcherProviders, registerMessagingProviders } from './providers-setup.js';
import { installShutdownHandlers } from './shutdown-handlers.js';
import { writePid, cleanupPidFile } from './daemon-control.js';
import { initPairingHandlers } from './handlers/pairing.js';
import { startRecordingCleanupWorker } from './recording-cleanup.js';

// Re-export public API so existing consumers don't need to change imports
export {
  isDaemonRunning,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  ensureDaemonRunning,
} from './daemon-control.js';
export type { StopResult } from './daemon-control.js';

const log = getLogger('lifecycle');

function loadDotEnv(): void {
  dotenvConfig({ path: join(getRootDir(), '.env'), quiet: true });
}

// Entry point for the daemon process itself
export async function runDaemon(): Promise<void> {
  loadDotEnv();
  validateEnv();
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

  try {
    installCliLaunchers();
  } catch (err) {
    log.warn({ err }, 'CLI launcher installation failed — continuing startup');
  }
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

  await initializeProvidersAndTools(config);

  // Start the IPC socket BEFORE Qdrant so that clients can connect
  // immediately. Qdrant startup can take 30+ seconds (binary download,
  // /readyz polling) which previously blocked the socket from appearing.
  log.info('Daemon startup: starting DaemonServer (IPC socket)');
  const server = new DaemonServer();
  await server.start();
  log.info('Daemon startup: DaemonServer started');

  // Initialize Qdrant vector store — non-fatal so the daemon stays up without it
  const qdrantUrl = getQdrantUrlEnv() || config.memory.qdrant.url;
  log.info({ qdrantUrl }, 'Daemon startup: initializing Qdrant');
  const qdrantManager = new QdrantManager({ url: qdrantUrl });
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

  log.info('Daemon startup: starting recording cleanup worker');
  const recordingCleanup = startRecordingCleanupWorker(config.recording);

  registerWatcherProviders();
  registerMessagingProviders();

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

  // Start the runtime HTTP server. Required for iOS pairing (gateway proxies
  // to it) and optional REST API access. Defaults to port 7821.
  let runtimeHttp: RuntimeHttpServer | null = null;
  const httpPort = getRuntimeHttpPort();
  log.info({ httpPort }, 'Daemon startup: starting runtime HTTP server');

  // Resolve the bearer token in priority order:
  //   1. Explicit env var (e.g. cloud deploys)
  //   2. Existing token file on disk (preserves QR-paired iOS devices across restarts)
  //   3. Fresh random token (first-time startup)
  const httpTokenPath = getHttpTokenPath();
  let bearerToken = getRuntimeProxyBearerToken();
  if (!bearerToken) {
    try {
      const existing = readFileSync(httpTokenPath, 'utf-8').trim();
      if (existing) bearerToken = existing;
    } catch {
      // File doesn't exist or can't be read — will generate below
    }
  }
  if (!bearerToken) {
    bearerToken = randomBytes(32).toString('hex');
  }
  writeFileSync(httpTokenPath, bearerToken, { mode: 0o600 });
  chmodSync(httpTokenPath, 0o600);

  const hostname = getRuntimeHttpHost();

  runtimeHttp = new RuntimeHttpServer({
    port: httpPort,
    hostname,
    bearerToken,
    processMessage: (conversationId, content, attachmentIds, options, sourceChannel) =>
      server.processMessage(conversationId, content, attachmentIds, options, sourceChannel),
    persistAndProcessMessage: (conversationId, content, attachmentIds, options, sourceChannel) =>
      server.persistAndProcessMessage(conversationId, content, attachmentIds, options, sourceChannel),
    runOrchestrator: server.createRunOrchestrator(),
    interfacesDir: getInterfacesDir(),
    approvalCopyGenerator: createApprovalCopyGenerator(),
    approvalConversationGenerator: createApprovalConversationGenerator(),
  });
  try {
    await runtimeHttp.start();
    setRelayBroadcast((msg) => server.broadcast(msg));
    runtimeHttp.setPairingBroadcast((msg) => server.broadcast(msg));
    initPairingHandlers(runtimeHttp.getPairingStore(), bearerToken);
    server.setHttpPort(httpPort);
    log.info({ port: httpPort, hostname }, 'Daemon startup: runtime HTTP server listening');
  } catch (err) {
    log.warn({ err, port: httpPort }, 'Failed to start runtime HTTP server, continuing without it');
    runtimeHttp = null;
  }

  writePid(process.pid);
  log.info({ pid: process.pid }, 'Daemon started');

  const hookManager = getHookManager();
  hookManager.watch();

  void hookManager.trigger('daemon-start', {
    pid: process.pid,
    socketPath: getSocketPath(),
  });

  if (config.auditLog.retentionDays > 0) {
    try {
      rotateToolInvocations(config.auditLog.retentionDays);
    } catch (err) {
      log.warn({ err }, 'Audit log rotation failed');
    }
  }

  const heartbeat = new HeartbeatService();
  heartbeat.start();

  const agentHeartbeat = new AgentHeartbeatService({
    processMessage: (conversationId, content) =>
      server.processMessage(conversationId, content),
    alerter: (alert) => server.broadcast(alert),
  });
  agentHeartbeat.start();

  installShutdownHandlers({
    server,
    heartbeat,
    agentHeartbeat,
    hookManager,
    runtimeHttp,
    scheduler,
    memoryWorker,
    recordingCleanup,
    qdrantManager,
    cleanupPidFile,
  });
}
