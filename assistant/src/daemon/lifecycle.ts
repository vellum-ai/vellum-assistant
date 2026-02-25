import { randomBytes } from 'node:crypto';
import { chmodSync,readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config as dotenvConfig } from 'dotenv';

import { reconcileCallsOnStartup } from '../calls/call-recovery.js';
import { setRelayBroadcast } from '../calls/relay-server.js';
import { TwilioConversationRelayProvider } from '../calls/twilio-provider.js';
import { setVoiceBridgeDeps } from '../calls/voice-session-bridge.js';
import {
  getQdrantUrlEnv,
  getRuntimeHttpHost,
  getRuntimeHttpPort,
  getRuntimeProxyBearerToken,
  validateEnv,
} from '../config/env.js';
import { loadConfig } from '../config/loader.js';
import { ensurePromptFiles } from '../config/system-prompt.js';
import { HeartbeatService } from '../heartbeat/heartbeat-service.js';
import { getHookManager } from '../hooks/manager.js';
import { installTemplates } from '../hooks/templates.js';
import { initSentry } from '../instrument.js';
import { initLogfire } from '../logfire.js';
import * as attachmentsStore from '../memory/attachments-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import { initializeDb } from '../memory/db.js';
import { startMemoryJobsWorker } from '../memory/jobs-worker.js';
import { initQdrantClient } from '../memory/qdrant-client.js';
import { QdrantManager } from '../memory/qdrant-manager.js';
import { rotateToolInvocations } from '../memory/tool-usage-store.js';
import { migrateToDataLayout } from '../migrations/data-layout.js';
import { migrateToWorkspaceLayout } from '../migrations/workspace-layout.js';
import { emitNotificationSignal, registerBroadcastFn } from '../notifications/emit-signal.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { startScheduler } from '../schedule/scheduler.js';
import { getLogger, initLogger } from '../util/logger.js';
import {
  ensureDataDir,
  getHttpTokenPath,
  getInterfacesDir,
  getRootDir,
  getSocketPath,
} from '../util/platform.js';
import { listWorkItems, updateWorkItem } from '../work-items/work-item-store.js';
import { WorkspaceHeartbeatService } from '../workspace/heartbeat-service.js';
import { createApprovalConversationGenerator,createApprovalCopyGenerator } from './approval-generators.js';
import { cleanupPidFile,writePid } from './daemon-control.js';
import { initPairingHandlers } from './handlers/pairing.js';
import { installCliLaunchers } from './install-cli-launchers.js';
import type { ServerMessage } from './ipc-protocol.js';
import { initializeProvidersAndTools, registerMessagingProviders,registerWatcherProviders } from './providers-setup.js';
import { seedInterfaceFiles } from './seed-files.js';
import { DaemonServer } from './server.js';
import { installShutdownHandlers } from './shutdown-handlers.js';

// Re-export public API so existing consumers don't need to change imports
export type { StopResult } from './daemon-control.js';
export {
  ensureDaemonRunning,
  getDaemonStatus,
  isDaemonRunning,
  startDaemon,
  stopDaemon,
} from './daemon-control.js';

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

  seedInterfaceFiles();

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

  registerWatcherProviders();
  registerMessagingProviders();

  // Register the IPC broadcast function for the notification signal pipeline's
  // macOS adapter so it can deliver notification_intent messages to desktop clients.
  registerBroadcastFn((msg) => server.broadcast(msg));

  const scheduler = startScheduler(
    async (conversationId, message) => {
      await server.processMessage(conversationId, message);
    },
    (reminder) => {
      void emitNotificationSignal({
        sourceEventName: 'reminder.fired',
        sourceChannel: 'scheduler',
        sourceSessionId: reminder.id,
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
        contextPayload: {
          reminderId: reminder.id,
          label: reminder.label,
          message: reminder.message,
        },
        dedupeKey: `reminder:${reminder.id}`,
      });
    },
    (schedule) => {
      void emitNotificationSignal({
        sourceEventName: 'schedule.complete',
        sourceChannel: 'scheduler',
        sourceSessionId: schedule.id,
        attentionHints: {
          requiresAction: false,
          urgency: 'medium',
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
        contextPayload: {
          scheduleId: schedule.id,
          name: schedule.name,
        },
      });
    },
    (notification) => {
      void emitNotificationSignal({
        sourceEventName: 'watcher.notification',
        sourceChannel: 'watcher',
        sourceSessionId: `watcher-${Date.now()}`,
        attentionHints: {
          requiresAction: false,
          urgency: 'low',
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
        contextPayload: {
          title: notification.title,
          body: notification.body,
        },
      });
    },
    (params) => {
      void emitNotificationSignal({
        sourceEventName: 'watcher.escalation',
        sourceChannel: 'watcher',
        sourceSessionId: `watcher-escalation-${Date.now()}`,
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
        contextPayload: {
          title: params.title,
          body: params.body,
        },
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
    processMessage: (conversationId, content, attachmentIds, options, sourceChannel, sourceInterface) =>
      server.processMessage(conversationId, content, attachmentIds, options, sourceChannel, sourceInterface),
    persistAndProcessMessage: (conversationId, content, attachmentIds, options, sourceChannel, sourceInterface) =>
      server.persistAndProcessMessage(conversationId, content, attachmentIds, options, sourceChannel, sourceInterface),
    interfacesDir: getInterfacesDir(),
    approvalCopyGenerator: createApprovalCopyGenerator(),
    approvalConversationGenerator: createApprovalConversationGenerator(),
    sendMessageDeps: {
      getOrCreateSession: (conversationId) =>
        server.getSessionForMessages(conversationId),
      assistantEventHub,
      resolveAttachments: (attachmentIds) =>
        attachmentsStore.getAttachmentsByIds(attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        })),
    },
  });

  // Inject voice bridge deps BEFORE attempting to start the HTTP server.
  // The bridge must be available even when the HTTP server fails to bind.
  setVoiceBridgeDeps({
    getOrCreateSession: (conversationId, transport) =>
      server.getSessionForMessages(conversationId),
    resolveAttachments: (attachmentIds) =>
      attachmentsStore.getAttachmentsByIds(attachmentIds).map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        mimeType: a.mimeType,
        data: a.dataBase64,
      })),
    deriveDefaultStrictSideEffects: (conversationId) => {
      const threadType = conversationStore.getConversationThreadType(conversationId);
      return threadType === 'private';
    },
  });
  try {
    await runtimeHttp.start();
    setRelayBroadcast((msg) => server.broadcast(msg));
    runtimeHttp.setPairingBroadcast((msg) => server.broadcast(msg as ServerMessage));
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

  const workspaceHeartbeat = new WorkspaceHeartbeatService();
  workspaceHeartbeat.start();

  const heartbeat = new HeartbeatService({
    processMessage: (conversationId, content) =>
      server.processMessage(conversationId, content),
    alerter: (alert) => server.broadcast(alert),
  });
  heartbeat.start();

  installShutdownHandlers({
    server,
    workspaceHeartbeat,
    heartbeat,
    hookManager,
    runtimeHttp,
    scheduler,
    memoryWorker,
    qdrantManager,
    cleanupPidFile,
  });
}
