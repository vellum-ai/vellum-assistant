import { randomBytes } from 'node:crypto';
import { chmodSync,readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config as dotenvConfig } from 'dotenv';

import { setPointerCopyGenerator } from '../calls/call-pointer-messages.js';
import { reconcileCallsOnStartup } from '../calls/call-recovery.js';
import { setRelayBroadcast } from '../calls/relay-server.js';
import { TwilioConversationRelayProvider } from '../calls/twilio-provider.js';
import { setVoiceBridgeDeps } from '../calls/voice-session-bridge.js';
import { isAssistantFeatureFlagEnabled } from '../config/assistant-feature-flags.js';
import {
  getQdrantUrlEnv,
  getRuntimeHttpHost,
  getRuntimeHttpPort,
  getRuntimeProxyBearerToken,
  validateEnv,
} from '../config/env.js';
import { loadConfig } from '../config/loader.js';
import { ensurePromptFiles } from '../config/system-prompt.js';
import { syncUpdateBulletinOnStartup } from '../config/update-bulletin.js';
import { HeartbeatService } from '../heartbeat/heartbeat-service.js';
import { getHookManager } from '../hooks/manager.js';
import { installTemplates } from '../hooks/templates.js';
import { closeSentry, initSentry } from '../instrument.js';
import { initLogfire } from '../logfire.js';
import { getMcpServerManager } from '../mcp/manager.js';
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
import { initSigningKey, loadOrCreateSigningKey } from '../runtime/actor-token-service.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';
import { ensureVellumGuardianBinding } from '../runtime/guardian-vellum-migration.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { startScheduler } from '../schedule/scheduler.js';
import { getLogger, initLogger } from '../util/logger.js';
import {
  ensureDataDir,
  getHttpTokenPath,
  getInterfacesDir,
  getRootDir,
  getSocketPath,
  removeSocketFile,
} from '../util/platform.js';
import { listWorkItems, updateWorkItem } from '../work-items/work-item-store.js';
import { WorkspaceHeartbeatService } from '../workspace/heartbeat-service.js';
import { createApprovalConversationGenerator,createApprovalCopyGenerator } from './approval-generators.js';
import { createPointerCopyGenerator } from './call-pointer-generators.js';
import { hasNoAuthOverride, hasUngatedNoAuthOverride } from './connection-policy.js';
import { cleanupPidFile, cleanupPidFileIfOwner, writePid } from './daemon-control.js';
import { createGuardianActionCopyGenerator, createGuardianFollowUpConversationGenerator } from './guardian-action-generators.js';
import { initPairingHandlers } from './handlers/pairing.js';
import { installCliLaunchers } from './install-cli-launchers.js';
import type { ServerMessage } from './ipc-protocol.js';
import { initializeProvidersAndTools, registerMessagingProviders,registerWatcherProviders } from './providers-setup.js';
import { seedInterfaceFiles } from './seed-files.js';
import { DaemonServer } from './server.js';
import { initSlashPairingContext } from './session-slash.js';
import { installShutdownHandlers } from './shutdown-handlers.js';

// Re-export public API so existing consumers don't need to change imports
export type { StopResult } from './daemon-control.js';
export {
  cleanupPidFile,
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

  if (hasUngatedNoAuthOverride()) {
    log.warn('VELLUM_DAEMON_NOAUTH is set but VELLUM_UNSAFE_AUTH_BYPASS=1 is not — auth bypass is IGNORED and authentication remains enabled. Set VELLUM_UNSAFE_AUTH_BYPASS=1 to confirm the bypass.');
  } else if (hasNoAuthOverride()) {
    log.warn('VELLUM_DAEMON_NOAUTH is set — IPC authentication is DISABLED. This should only be used for development or SSH-forwarded sockets. Do not use in production.');
  }

  // Track whether the IPC socket has been created so we can clean it up
  // if init crashes after the socket is bound but before shutdown handlers
  // are installed.
  let socketCreated = false;

  try {
    // Initialize crash reporting eagerly so early startup failures are
    // captured. After config loads we check the opt-out flag and call
    // closeSentry() if the user has disabled it.
    initSentry();

    await initLogfire();

    // Migration order matters: first move legacy flat files into the data dir
    // structure, then relocate the data dir into the active workspace, and
    // finally create any directories that don't yet exist.
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();

    // Resolve and write the bearer token as early as possible so the CLI
    // (which polls for this file during gateway startup) doesn't time out
    // waiting for Qdrant or other slow init steps to finish.
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
    log.info('Daemon startup: bearer token written');

    // Load (or generate + persist) the actor-token signing key so tokens
    // survive daemon restarts. Must happen after ensureDataDir() creates
    // the protected directory.
    initSigningKey(loadOrCreateSigningKey());

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

    // Backfill vellum guardian binding for existing installations
    try {
      ensureVellumGuardianBinding('self');
    } catch (err) {
      log.warn({ err }, 'Vellum guardian binding backfill failed — continuing startup');
    }

    try {
      syncUpdateBulletinOnStartup();
    } catch (err) {
      log.warn({ err }, 'Bulletin sync failed — continuing startup');
    }

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

    // If the user has opted out of crash reporting, stop Sentry from capturing
    // future events. Early-startup crashes before this point are still captured.
    const collectUsageData = isAssistantFeatureFlagEnabled('feature_flags.collect-usage-data.enabled', config);
    if (!collectUsageData) {
      await closeSentry();
    }

    await initializeProvidersAndTools(config);

    // Start the IPC socket BEFORE Qdrant so that clients can connect
    // immediately. Qdrant startup can take 30+ seconds (binary download,
    // /readyz polling) which previously blocked the socket from appearing.
    log.info('Daemon startup: starting DaemonServer (IPC socket)');
    const server = new DaemonServer();
    await server.start();
    socketCreated = true;
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
          routingIntent: reminder.routingIntent,
          routingHints: reminder.routingHints,
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
      guardianActionCopyGenerator: createGuardianActionCopyGenerator(),
      guardianFollowUpConversationGenerator: createGuardianFollowUpConversationGenerator(),
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
      getOrCreateSession: (conversationId, _transport) =>
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
      setPointerCopyGenerator(createPointerCopyGenerator());
      runtimeHttp.setPairingBroadcast((msg) => server.broadcast(msg as ServerMessage));
      initPairingHandlers(runtimeHttp.getPairingStore(), bearerToken);
      initSlashPairingContext(runtimeHttp.getPairingStore());
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

    // Download embedding runtime in background (non-blocking).
    // If download fails, local embeddings gracefully fall back to cloud backends.
    void (async () => {
      try {
        const { EmbeddingRuntimeManager } = await import('../memory/embedding-runtime-manager.js');
        const runtimeManager = new EmbeddingRuntimeManager();
        if (!runtimeManager.isReady()) {
          log.info('Downloading embedding runtime in background...');
          await runtimeManager.ensureInstalled();
          // Reset the localBackendBroken flag so auto mode retries local embeddings
          const { clearEmbeddingBackendCache } = await import('../memory/embedding-backend.js');
          clearEmbeddingBackendCache();
          log.info('Embedding runtime download complete');
        }
      } catch (err) {
        log.warn({ err }, 'Embedding runtime download failed — local embeddings will use cloud fallback');
      }
    })();

    if (config.auditLog.retentionDays > 0) {
      try {
        rotateToolInvocations(config.auditLog.retentionDays);
      } catch (err) {
        log.warn({ err }, 'Audit log rotation failed');
      }
    }

    const workspaceHeartbeat = new WorkspaceHeartbeatService();
    workspaceHeartbeat.start();

    const heartbeatConfig = config.heartbeat;
    const heartbeat = new HeartbeatService({
      processMessage: (conversationId, content) =>
        server.processMessage(conversationId, content),
      alerter: (alert) => server.broadcast(alert),
    });
    heartbeat.start();
    server.setHeartbeatService(heartbeat);
    log.info({ enabled: heartbeatConfig.enabled, intervalMs: heartbeatConfig.intervalMs }, 'Heartbeat service configured');

    // Retrieve the MCP manager if MCP servers were configured.
    // The manager is a singleton created during initializeProvidersAndTools().
    const mcpManager = config.mcp?.servers && Object.keys(config.mcp.servers).length > 0
      ? getMcpServerManager()
      : null;

    installShutdownHandlers({
      server,
      workspaceHeartbeat,
      heartbeat,
      hookManager,
      runtimeHttp,
      scheduler,
      memoryWorker,
      qdrantManager,
      mcpManager,
      cleanupPidFile,
    });
  } catch (err) {
    log.error({ err }, 'Daemon startup failed — cleaning up');
    cleanupPidFileIfOwner(process.pid);
    if (socketCreated) {
      try {
        removeSocketFile(getSocketPath());
      } catch {
        // Best-effort socket cleanup
      }
    }
    throw err;
  }
}
