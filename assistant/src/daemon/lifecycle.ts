import { createHash } from "node:crypto";
import { join } from "node:path";

import { config as dotenvConfig } from "dotenv";

import { setPointerMessageProcessor } from "../calls/call-pointer-messages.js";
import { reconcileCallsOnStartup } from "../calls/call-recovery.js";
import { setRelayBroadcast } from "../calls/relay-server.js";
import { TwilioConversationRelayProvider } from "../calls/twilio-provider.js";
import { setVoiceBridgeDeps } from "../calls/voice-session-bridge.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import {
  getQdrantHttpPortEnv,
  getQdrantUrlEnv,
  getRuntimeHttpHost,
  getRuntimeHttpPort,
  setIngressPublicBaseUrl,
  validateEnv,
} from "../config/env.js";
import { loadConfig } from "../config/loader.js";
import { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import { getHookManager } from "../hooks/manager.js";
import { installTemplates } from "../hooks/templates.js";
import { closeSentry, initSentry } from "../instrument.js";
import { disableLogfire, initLogfire } from "../logfire.js";
import { getMcpServerManager } from "../mcp/manager.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import { expireAllPendingCanonicalRequests } from "../memory/canonical-guardian-store.js";
import {
  deleteMessageById,
  getConversationType,
  getMessages,
  purgePrivateConversations,
} from "../memory/conversation-crud.js";
import { resolveConversationId } from "../memory/conversation-key-store.js";
import { initializeDb } from "../memory/db.js";
import {
  selectEmbeddingBackend,
  SPARSE_EMBEDDING_VERSION,
} from "../memory/embedding-backend.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { startMemoryJobsWorker } from "../memory/jobs-worker.js";
import { initQdrantClient } from "../memory/qdrant-client.js";
import { QdrantManager } from "../memory/qdrant-manager.js";
import { rotateToolInvocations } from "../memory/tool-usage-store.js";
import {
  emitNotificationSignal,
  registerBroadcastFn,
} from "../notifications/emit-signal.js";
import { backfillManualTokenConnections } from "../oauth/manual-token-connection.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import { ensurePromptFiles } from "../prompts/system-prompt.js";
import { syncUpdateBulletinOnStartup } from "../prompts/update-bulletin.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { mintCredentialPair } from "../runtime/auth/credential-service.js";
import {
  initAuthSigningKey,
  loadOrCreateSigningKey,
  mintPairingBearerToken,
} from "../runtime/auth/token-service.js";
import { ensureVellumGuardianBinding } from "../runtime/guardian-vellum-migration.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { startScheduler } from "../schedule/scheduler.js";
import { BOOTSTRAPPED_ACTOR_HTTP_TOKEN } from "../security/credential-key.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { UsageTelemetryReporter } from "../telemetry/usage-telemetry-reporter.js";
import { getLogger, initLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getInterfacesDir,
  getRootDir,
  getWorkspaceDir,
} from "../util/platform.js";
import {
  listWorkItems,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import { WorkspaceHeartbeatService } from "../workspace/heartbeat-service.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { runWorkspaceMigrations } from "../workspace/migrations/runner.js";
import {
  createApprovalConversationGenerator,
  createApprovalCopyGenerator,
} from "./approval-generators.js";
import { initSlashPairingContext } from "./conversation-slash.js";
import {
  cleanupPidFile,
  cleanupPidFileIfOwner,
  writePid,
} from "./daemon-control.js";
import {
  createGuardianActionCopyGenerator,
  createGuardianFollowUpConversationGenerator,
} from "./guardian-action-generators.js";
import {
  cancelGeneration,
  clearAllConversations,
  regenerateResponse,
  renameConversation,
  switchConversation,
  undoLastMessage,
} from "./handlers/conversations.js";
import type { ServerMessage } from "./message-protocol.js";
import {
  initializeProvidersAndTools,
  registerMessagingProviders,
  registerWatcherProviders,
} from "./providers-setup.js";
import { seedInterfaceFiles } from "./seed-files.js";
import { DaemonServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown-handlers.js";
import { handleWatchObservation } from "./watch-handler.js";

// Re-export public API so existing consumers don't need to change imports
export type { StopResult } from "./daemon-control.js";
export {
  cleanupPidFile,
  ensureDaemonRunning,
  getDaemonStatus,
  isDaemonRunning,
  startDaemon,
  stopDaemon,
} from "./daemon-control.js";

const log = getLogger("lifecycle");

function loadDotEnv(): void {
  dotenvConfig({ path: join(getRootDir(), ".env"), quiet: true });
}

// Entry point for the daemon process itself
export async function runDaemon(): Promise<void> {
  loadDotEnv();
  validateEnv();

  try {
    // Initialize crash reporting eagerly so early startup failures are
    // captured. After config loads we check the opt-out flag and call
    // closeSentry() if the user has disabled it.
    initSentry();

    await initLogfire();

    ensureDataDir();
    await runWorkspaceMigrations(getWorkspaceDir(), WORKSPACE_MIGRATIONS);

    // Load (or generate + persist) the auth signing key so tokens survive
    // daemon restarts. Must happen after ensureDataDir() creates the
    // protected directory.
    const signingKey = loadOrCreateSigningKey();
    initAuthSigningKey(signingKey);

    log.info("Daemon startup: migrations complete");

    seedInterfaceFiles();

    log.info("Daemon startup: installing templates and initializing DB");
    installTemplates();
    ensurePromptFiles();

    initializeDb();
    // Seed well-known OAuth provider configurations (insert-if-not-exists)
    seedOAuthProviders();
    // Backfill oauth_connection rows for manual-token providers (Telegram,
    // Slack channel) that already have keychain credentials from before the
    // oauth_connection migration. Safe to call on every startup.
    try {
      await backfillManualTokenConnections();
    } catch (err) {
      log.warn(
        { err },
        "Manual-token connection backfill failed — continuing startup",
      );
    }
    log.info("Daemon startup: DB initialized");

    // Purge private (temporary) conversations from the previous session.
    // These are ephemeral by design and should not survive daemon restarts.
    const { count: purgedCount, deletedMemory } = purgePrivateConversations();
    if (purgedCount > 0) {
      log.info(
        { purgedCount },
        `Purged ${purgedCount} private conversation(s) from previous session`,
      );
      // Qdrant may not be ready at startup, so enqueue vector cleanup jobs
      // rather than attempting direct deletion.
      for (const segId of deletedMemory.segmentIds) {
        enqueueMemoryJob("delete_qdrant_vectors", {
          targetType: "segment",
          targetId: segId,
        });
      }
      for (const itemId of deletedMemory.orphanedItemIds) {
        enqueueMemoryJob("delete_qdrant_vectors", {
          targetType: "item",
          targetId: itemId,
        });
      }
      if (
        deletedMemory.segmentIds.length > 0 ||
        deletedMemory.orphanedItemIds.length > 0
      ) {
        log.info(
          {
            segments: deletedMemory.segmentIds.length,
            orphanedItems: deletedMemory.orphanedItemIds.length,
          },
          "Enqueued Qdrant vector cleanup jobs for purged private conversations",
        );
      }
    }

    // Expire pending interaction-bound canonical guardian requests left over
    // from before this process started.  Their in-memory pending-interaction
    // session references are gone, so they can never be completed.  Only
    // interaction-bound kinds (tool_approval, pending_question) are expired;
    // persistent kinds (access_request, tool_grant_request) remain valid
    // across restarts.
    const expiredCount = expireAllPendingCanonicalRequests();
    if (expiredCount > 0) {
      log.info(
        { event: "startup_expired_stale_requests", expiredCount },
        `Expired ${expiredCount} stale interaction-bound canonical request(s) from previous process`,
      );
    }

    // Ensure a vellum guardian binding exists and mint the CLI edge token
    // as an actor token bound to the guardian principal.
    let guardianPrincipalId: string | undefined;
    try {
      guardianPrincipalId = ensureVellumGuardianBinding(
        DAEMON_INTERNAL_ASSISTANT_ID,
      );
    } catch (err) {
      log.warn(
        { err },
        "Vellum guardian binding backfill failed — continuing startup",
      );
    }

    if (guardianPrincipalId) {
      const cliDeviceId = "daemon-cli";
      const hashedDeviceId = createHash("sha256")
        .update(cliDeviceId)
        .digest("hex");
      const credentials = mintCredentialPair({
        platform: "cli",
        deviceId: cliDeviceId,
        guardianPrincipalId,
        hashedDeviceId,
      });

      const stored = await setSecureKeyAsync(
        BOOTSTRAPPED_ACTOR_HTTP_TOKEN,
        credentials.accessToken,
      );
      if (!stored) {
        log.warn("Failed to persist CLI edge token in credential store");
      } else {
        log.info("Daemon startup: CLI edge token written to credential store");
      }
    } else {
      log.warn("No guardian principal available — CLI edge token not written");
    }

    try {
      syncUpdateBulletinOnStartup();
    } catch (err) {
      log.warn({ err }, "Bulletin sync failed — continuing startup");
    }

    // Recover orphaned work items that were left in 'running' state when the
    // daemon previously crashed or was killed mid-task.
    const orphanedRunning = listWorkItems({ status: "running" });
    if (orphanedRunning.length > 0) {
      for (const item of orphanedRunning) {
        updateWorkItem(item.id, {
          status: "failed",
          lastRunStatus: "interrupted",
        });
        log.info(
          { workItemId: item.id, title: item.title },
          "Recovered orphaned running work item → failed (interrupted)",
        );
      }
      log.info(
        { count: orphanedRunning.length },
        "Recovered orphaned running work items",
      );
    }

    try {
      const twilioProvider = new TwilioConversationRelayProvider();
      await reconcileCallsOnStartup(twilioProvider, log);
    } catch (err) {
      log.warn({ err }, "Call recovery failed — continuing startup");
    }

    log.info("Daemon startup: loading config");
    const config = loadConfig();

    // Seed module-level ingress state from the workspace config so that
    // getIngressPublicBaseUrl() returns the correct value immediately after
    // startup (before any handleIngressConfig("set") call). Without this,
    // code paths that read the module-level state directly (e.g. session-slash
    // pairing info) would see undefined until an explicit set.
    if (config.ingress.enabled && config.ingress.publicBaseUrl) {
      setIngressPublicBaseUrl(config.ingress.publicBaseUrl);
      log.info(
        { url: config.ingress.publicBaseUrl },
        "Daemon startup: seeded ingress URL from workspace config",
      );
    }

    if (config.logFile.dir) {
      initLogger({
        dir: config.logFile.dir,
        retentionDays: config.logFile.retentionDays,
      });
    }

    // If the user has opted out of crash reporting, stop Sentry from capturing
    // future events. Early-startup crashes before this point are still captured.
    const collectUsageData = isAssistantFeatureFlagEnabled(
      "feature_flags.collect-usage-data.enabled",
      config,
    );
    if (!collectUsageData) {
      await closeSentry();
    }

    let telemetryReporter: UsageTelemetryReporter | null = null;
    if (collectUsageData) {
      telemetryReporter = new UsageTelemetryReporter();
      telemetryReporter.start();
      log.info("Usage telemetry reporter started");
    }

    // If Logfire observability is not explicitly enabled, disable it so
    // wrapWithLogfire() calls during provider setup become no-ops. Logfire
    // is initialized eagerly (before config loads) for the same reason as
    // Sentry — but the feature flag gates whether it actually traces.
    const logfireEnabled = isAssistantFeatureFlagEnabled(
      "feature_flags.logfire.enabled",
      config,
    );
    if (!logfireEnabled) {
      disableLogfire();
    }

    await initializeProvidersAndTools(config);

    // Start the DaemonServer (session manager) before Qdrant so HTTP
    // routes can begin accepting requests while Qdrant initializes.
    log.info("Daemon startup: starting DaemonServer");
    const server = new DaemonServer();
    await server.start();
    log.info("Daemon startup: DaemonServer started");

    // Initialize Qdrant vector store — non-fatal so the daemon stays up without it
    // Prefer QDRANT_HTTP_PORT (locally-spawned Qdrant on a specific port) over
    // QDRANT_URL (external Qdrant instance) so the CLI can set the port without
    // triggering QdrantManager's external mode which skips local process spawn.
    const qdrantHttpPort = getQdrantHttpPortEnv();
    const qdrantUrl = qdrantHttpPort
      ? `http://127.0.0.1:${qdrantHttpPort}`
      : getQdrantUrlEnv() || config.memory.qdrant.url;
    log.info({ qdrantUrl }, "Daemon startup: initializing Qdrant");
    const qdrantManager = new QdrantManager({ url: qdrantUrl });
    try {
      await qdrantManager.start();
      const embeddingSelection = await selectEmbeddingBackend(config);
      const embeddingModel = embeddingSelection.backend
        ? `${embeddingSelection.backend.provider}:${embeddingSelection.backend.model}:sparse-v${SPARSE_EMBEDDING_VERSION}`
        : undefined;
      const qdrantClient = initQdrantClient({
        url: qdrantUrl,
        collection: config.memory.qdrant.collection,
        vectorSize: config.memory.qdrant.vectorSize,
        onDisk: config.memory.qdrant.onDisk,
        quantization: config.memory.qdrant.quantization,
        embeddingModel,
      });

      // Eagerly ensure the collection exists so we detect migrations
      // (unnamed→named vectors, dimension/model changes) at startup.
      // If a destructive migration occurred, enqueue a rebuild_index job
      // to re-embed all memory items from the SQLite cache.
      const { migrated } = await qdrantClient.ensureCollection();
      if (migrated) {
        enqueueMemoryJob("rebuild_index", {});
        log.info("Qdrant collection was migrated — enqueued rebuild_index job");
      }

      log.info("Qdrant vector store initialized");
    } catch (err) {
      log.warn(
        { err },
        "Qdrant failed to start — memory features will be unavailable",
      );
    }

    log.info("Daemon startup: starting memory worker");
    const memoryWorker = startMemoryJobsWorker();

    registerWatcherProviders();
    registerMessagingProviders();

    // Register the broadcast function for the notification signal pipeline's
    // macOS adapter so it can deliver notification_intent messages to clients.
    registerBroadcastFn((msg) => server.broadcast(msg));

    const scheduler = startScheduler(
      async (conversationId, message, options) => {
        await server.processMessage(
          conversationId,
          message,
          undefined,
          options?.trustClass
            ? {
                trustContext: {
                  sourceChannel: "vellum",
                  trustClass: options.trustClass,
                },
              }
            : undefined,
        );
      },
      async (schedule) => {
        await emitNotificationSignal({
          sourceEventName: "schedule.notify",
          sourceChannel: "scheduler",
          sourceSessionId: schedule.id,
          attentionHints: {
            requiresAction: true,
            urgency: "high",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: {
            scheduleId: schedule.id,
            label: schedule.label,
            message: schedule.message,
          },
          routingIntent: schedule.routingIntent,
          routingHints: schedule.routingHints,
          dedupeKey: `schedule:notify:${schedule.id}:${Date.now()}`,
          throwOnError: true,
        });
      },
      (schedule) => {
        void emitNotificationSignal({
          sourceEventName: "schedule.complete",
          sourceChannel: "scheduler",
          sourceSessionId: schedule.id,
          attentionHints: {
            requiresAction: false,
            urgency: "medium",
            isAsyncBackground: true,
            visibleInSourceNow: false,
          },
          contextPayload: {
            scheduleId: schedule.id,
            name: schedule.name,
          },
          dedupeKey: `schedule:complete:${schedule.id}:${Date.now()}`,
        });
      },
      (notification) => {
        void emitNotificationSignal({
          sourceEventName: "watcher.notification",
          sourceChannel: "watcher",
          sourceSessionId: `watcher-${Date.now()}`,
          attentionHints: {
            requiresAction: false,
            urgency: "low",
            isAsyncBackground: true,
            visibleInSourceNow: false,
          },
          contextPayload: {
            title: notification.title,
            body: notification.body,
          },
          dedupeKey: `watcher:notification:${Date.now()}`,
        });
      },
      (params) => {
        void emitNotificationSignal({
          sourceEventName: "watcher.escalation",
          sourceChannel: "watcher",
          sourceSessionId: `watcher-escalation-${Date.now()}`,
          attentionHints: {
            requiresAction: true,
            urgency: "high",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: {
            title: params.title,
            body: params.body,
          },
          dedupeKey: `watcher:escalation:${Date.now()}`,
        });
      },
      (info) => {
        server.broadcast({
          type: "schedule_conversation_created",
          conversationId: info.conversationId,
          scheduleJobId: info.scheduleJobId,
          title: info.title,
        });
      },
    );

    // Start the runtime HTTP server. Required for iOS pairing (gateway proxies
    // to it) and optional REST API access. Defaults to port 7821.
    let runtimeHttp: RuntimeHttpServer | null = null;
    const httpPort = getRuntimeHttpPort();
    log.info({ httpPort }, "Daemon startup: starting runtime HTTP server");

    const hostname = getRuntimeHttpHost();

    // Mint a JWT bearer token for the pairing flow. The pairing handler
    // and HTTP auto-approve logic both guard on a non-empty bearer token.
    const pairingBearerToken = mintPairingBearerToken();

    runtimeHttp = new RuntimeHttpServer({
      port: httpPort,
      hostname,
      bearerToken: pairingBearerToken,
      processMessage: (
        conversationId,
        content,
        attachmentIds,
        options,
        sourceChannel,
        sourceInterface,
      ) =>
        server.processMessage(
          conversationId,
          content,
          attachmentIds,
          options,
          sourceChannel,
          sourceInterface,
        ),
      interfacesDir: getInterfacesDir(),
      approvalCopyGenerator: createApprovalCopyGenerator(),
      approvalConversationGenerator: createApprovalConversationGenerator(),
      guardianActionCopyGenerator: createGuardianActionCopyGenerator(),
      guardianFollowUpConversationGenerator:
        createGuardianFollowUpConversationGenerator(),
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
      findConversation: (sessionId) => server.findSession(sessionId),
      findConversationBySurfaceId: (surfaceId) =>
        server.findSessionBySurfaceId(surfaceId),
      getSkillContext: () => server.getSkillContext(),
      getModelSetContext: () => server.getHandlerContext(),
      conversationManagementDeps: {
        switchConversation: (conversationId) =>
          switchConversation(conversationId, server.getHandlerContext()),
        renameConversation: (conversationId, name) =>
          renameConversation(conversationId, name),
        clearAllConversations: () =>
          clearAllConversations(server.getHandlerContext()),
        cancelGeneration: (sessionId) =>
          cancelGeneration(sessionId, server.getHandlerContext()),
        destroyConversation: (sessionId) => server.destroySession(sessionId),
        undoLastMessage: (sessionId) =>
          undoLastMessage(sessionId, server.getHandlerContext()),
        regenerateResponse: (sessionId) => {
          // Resolve conversation key up front so SSE events are tagged with
          // the internal conversation ID, not the raw client key.
          const resolvedId = resolveConversationId(sessionId) ?? sessionId;
          let hubChain: Promise<void> = Promise.resolve();
          const sendEvent = (event: ServerMessage) => {
            const ae = buildAssistantEvent(
              DAEMON_INTERNAL_ASSISTANT_ID,
              event,
              resolvedId,
            );
            hubChain = (async () => {
              await hubChain;
              try {
                await assistantEventHub.publish(ae);
              } catch (err) {
                log.warn(
                  { err },
                  "assistant-events hub subscriber threw during regenerate",
                );
              }
            })();
          };
          return regenerateResponse(
            sessionId,
            server.getHandlerContext(),
            sendEvent,
          );
        },
      },
      getWatchDeps: () => {
        const ctx = server.getHandlerContext();
        return {
          handleWatchObservation: async (params) => {
            await handleWatchObservation(
              {
                type: "watch_observation",
                watchId: params.watchId,
                sessionId: params.sessionId,
                ocrText: params.ocrText,
                appName: params.appName,
                windowTitle: params.windowTitle,
                bundleIdentifier: params.bundleIdentifier,
                timestamp: params.timestamp,
                captureIndex: params.captureIndex,
                totalExpected: params.totalExpected,
              },
              ctx,
            );
          },
        };
      },
      getRecordingDeps: () => ({
        getHandlerContext: () => server.getHandlerContext(),
      }),
      getCesClient: () => server.getCesClient(),
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
        const conversationType = getConversationType(conversationId);
        return conversationType === "private";
      },
    });
    try {
      await runtimeHttp.start();
      setRelayBroadcast((msg) => server.broadcast(msg));
      setPointerMessageProcessor(
        async (conversationId, instruction, requiredFacts) => {
          const session = await server.getSessionForMessages(conversationId);

          // Constrain pointer generation to a tool-disabled path so call-
          // status events cannot trigger unintended side-effect tools.
          // Incrementing toolsDisabledDepth causes the resolveTools callback
          // to return an empty tool list, preventing the LLM from seeing or
          // invoking any tools during the pointer agent loop.
          //
          // A depth counter (rather than a boolean) ensures that overlapping
          // pointer requests on the same session don't clear each other's
          // constraint — each caller increments on entry and decrements in
          // its own finally block.
          session.toolsDisabledDepth++;
          try {
            const messageId = await session.persistUserMessage(
              instruction,
              [],
              undefined,
              { pointerInstruction: true },
              "[Call status event]",
            );

            // Helper: roll back persisted messages on failure, then reload
            // in-memory history from the (now cleaned) DB. Reloading avoids
            // stale-index issues when context compaction reassigns the
            // messages array during runAgentLoop.
            const rollback = async (extraMessageIds?: string[]) => {
              try {
                deleteMessageById(messageId);
              } catch {
                /* best effort */
              }
              for (const id of extraMessageIds ?? []) {
                try {
                  deleteMessageById(id);
                } catch {
                  /* best effort */
                }
              }
              try {
                await session.loadFromDb();
              } catch {
                /* best effort */
              }
            };

            // Snapshot message IDs before the agent loop so we can diff
            // afterwards to find exactly which messages this run created,
            // avoiding positional heuristics that break under concurrency.
            //
            // Caveat: the diff captures *all* new messages in the
            // conversation during the loop window, not just those from
            // this specific agent loop.  If a concurrent pointer event
            // falls back to a deterministic addMessage() while our loop
            // is in flight, that message lands in our diff.  The race
            // requires two pointer events for the same conversation
            // within the agent loop window *and* this run must fail or
            // fail fact-check — narrow enough to accept.  A future
            // improvement could tag messages with a per-run correlation
            // ID so rollback only targets its own output.
            const preRunMessageIds = new Set(
              getMessages(conversationId).map((m) => m.id),
            );

            let agentLoopError: string | undefined;
            let generatedText = "";
            await session.runAgentLoop(instruction, messageId, (msg) => {
              if (
                "type" in msg &&
                msg.type === "assistant_text_delta" &&
                "text" in msg
              ) {
                generatedText += (msg as { text: string }).text;
              }
              if (
                "type" in msg &&
                (msg.type === "error" || msg.type === "conversation_error")
              ) {
                agentLoopError =
                  "message" in msg
                    ? (msg as { message: string }).message
                    : "userMessage" in msg
                      ? (msg as { userMessage: string }).userMessage
                      : "Agent loop failed";
              }
            });

            // Identify messages created during this run by diffing against
            // the pre-run snapshot. This captures all messages added to the
            // conversation during the loop window, which may include messages
            // from concurrent pointer events (see over-capture caveat above).
            const postRunMessages = getMessages(conversationId);
            const createdMessageIds = postRunMessages
              .filter((m) => !preRunMessageIds.has(m.id) && m.id !== messageId)
              .map((m) => m.id);

            if (agentLoopError) {
              await rollback(createdMessageIds);
              throw new Error(agentLoopError);
            }

            // Post-generation fact check: verify the assistant's response
            // includes all required factual details (phone number, duration,
            // outcome keyword, etc.). If the model omitted or rewrote them,
            // remove both the instruction and generated messages and throw so
            // the deterministic fallback fires.
            //
            // Validation uses text accumulated from assistant_text_delta
            // events during the agent loop rather than a DB lookup, avoiding
            // any positional ambiguity when concurrent pointer events
            // interleave messages in the conversation.
            if (requiredFacts && requiredFacts.length > 0) {
              const missingFacts = requiredFacts.filter(
                (fact) => !generatedText.includes(fact),
              );
              if (missingFacts.length > 0) {
                log.warn(
                  { conversationId, missingFacts },
                  "Generated pointer text failed fact validation — falling back to deterministic",
                );
                await rollback(createdMessageIds);
                throw new Error(
                  "Generated pointer text failed fact validation",
                );
              }
            }
          } finally {
            // Restore tool availability so subsequent turns aren't affected.
            session.toolsDisabledDepth--;
          }
        },
      );
      runtimeHttp.setPairingBroadcast((msg) =>
        server.broadcast(msg as ServerMessage),
      );
      initSlashPairingContext(runtimeHttp.getPairingStore());
      server.setHttpPort(httpPort);
      log.info(
        { port: httpPort, hostname },
        "Daemon startup: runtime HTTP server listening",
      );
    } catch (err) {
      log.warn(
        { err, port: httpPort },
        "Failed to start runtime HTTP server, continuing without it",
      );
      runtimeHttp = null;
    }

    writePid(process.pid);
    log.info({ pid: process.pid }, "Daemon started");

    const hookManager = getHookManager();
    hookManager.watch();

    void hookManager.trigger("daemon-start", {
      pid: process.pid,
    });

    // Download embedding runtime in background (non-blocking).
    // If download fails, local embeddings gracefully fall back to cloud backends.
    void (async () => {
      try {
        const { EmbeddingRuntimeManager } =
          await import("../memory/embedding-runtime-manager.js");
        const runtimeManager = new EmbeddingRuntimeManager();
        if (!runtimeManager.isReady()) {
          log.info("Downloading embedding runtime in background...");
          await runtimeManager.ensureInstalled();
          // Reset the localBackendBroken flag so auto mode retries local embeddings
          const { clearEmbeddingBackendCache } =
            await import("../memory/embedding-backend.js");
          clearEmbeddingBackendCache();
          log.info("Embedding runtime download complete");
        }
      } catch (err) {
        log.warn(
          { err },
          "Embedding runtime download failed — local embeddings will use cloud fallback",
        );
      }
    })();

    if (config.auditLog.retentionDays > 0) {
      try {
        rotateToolInvocations(config.auditLog.retentionDays);
      } catch (err) {
        log.warn({ err }, "Audit log rotation failed");
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
    log.info(
      {
        enabled: heartbeatConfig.enabled,
        intervalMs: heartbeatConfig.intervalMs,
      },
      "Heartbeat service configured",
    );

    // Retrieve the MCP manager if MCP servers were configured.
    // The manager is a singleton created during initializeProvidersAndTools().
    const mcpManager =
      config.mcp?.servers && Object.keys(config.mcp.servers).length > 0
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
      telemetryReporter,
      cleanupPidFile,
    });
  } catch (err) {
    log.error({ err }, "Daemon startup failed — cleaning up");
    cleanupPidFileIfOwner(process.pid);
    throw err;
  }
}
