import { join } from "node:path";

import { config as dotenvConfig } from "dotenv";

import type { BackupWorkerHandle } from "../backup/backup-worker.js";
import { startBackupWorker } from "../backup/backup-worker.js";
import { setPointerMessageProcessor } from "../calls/call-pointer-messages.js";
import { reconcileCallsOnStartup } from "../calls/call-recovery.js";
import { setRelayBroadcast } from "../calls/relay-server.js";
import { TwilioConversationRelayProvider } from "../calls/twilio-provider.js";
import { setVoiceBridgeDeps } from "../calls/voice-session-bridge.js";
import { initFeatureFlagOverrides } from "../config/assistant-feature-flags.js";
import {
  getPlatformAssistantId,
  getQdrantHttpPortEnv,
  getQdrantUrlEnv,
  getRuntimeHttpHost,
  getRuntimeHttpPort,
  setIngressPublicBaseUrl,
  validateEnv,
} from "../config/env.js";
import { loadConfig, mergeDefaultWorkspaceConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import type { CesClient } from "../credential-execution/client.js";
import { createCesClient } from "../credential-execution/client.js";
import {
  isCesCredentialBackendEnabled,
  isCesToolsEnabled,
} from "../credential-execution/feature-gates.js";
import {
  type CesProcessManager,
  CesUnavailableError,
  createCesProcessManager,
} from "../credential-execution/process-manager.js";
import {
  awaitCesClientWithTimeout,
  DEFAULT_CES_STARTUP_TIMEOUT_MS,
} from "../credential-execution/startup-timeout.js";
import { FilingService } from "../filing/filing-service.js";
import { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import {
  type FeedSchedulerHandle,
  startFeedScheduler,
} from "../home/feed-scheduler.js";
import { backfillRelationshipStateIfMissing } from "../home/relationship-state-writer.js";
import { getHookManager } from "../hooks/manager.js";
import { installTemplates } from "../hooks/templates.js";
import { closeSentry, initSentry, setSentryDeviceId } from "../instrument.js";
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
import { deleteOldTraceEvents } from "../memory/trace-event-store.js";
import {
  emitNotificationSignal,
  registerBroadcastFn,
} from "../notifications/emit-signal.js";
import { backfillManualTokenConnections } from "../oauth/manual-token-connection.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import { ensurePromptFiles } from "../prompts/system-prompt.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import {
  initAuthSigningKey,
  mintPairingBearerToken,
  resolveSigningKey,
} from "../runtime/auth/token-service.js";
import {
  initCapabilityTokenSecret,
  loadOrCreateCapabilityTokenSecret,
  writeDaemonTokenFallback,
} from "../runtime/capability-tokens.js";
import { ensureVellumGuardianBinding } from "../runtime/guardian-vellum-migration.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { recoverInterruptedImport } from "../runtime/migrations/vbundle-streaming-importer.js";
import { startScheduler } from "../schedule/scheduler.js";
import {
  onCesClientChanged,
  setCesClient,
  setCesReconnect,
} from "../security/secure-keys.js";
import { UsageTelemetryReporter } from "../telemetry/usage-telemetry-reporter.js";
import { registerBuiltinTtsProviders } from "../tts/providers/register-builtins.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger, initLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getDotEnvPath,
  getInterfacesDir,
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
import { backfillSlackInjectionTemplates } from "./handlers/config-slack-channel.js";
import {
  cancelGeneration,
  clearAllConversations,
  regenerateResponse,
  renameConversation,
  switchConversation,
  undoLastMessage,
} from "./handlers/conversations.js";
import { installAssistantSymlink } from "./install-symlink.js";
import type { ServerMessage } from "./message-protocol.js";
import { runProfilerSweep } from "./profiler-run-store.js";
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
  dotenvConfig({ path: getDotEnvPath(), quiet: true });
}

export interface CesStartupResult {
  client: CesClient | undefined;
  processManager: CesProcessManager | undefined;
  clientPromise: Promise<CesClient | undefined> | undefined;
  abortController: AbortController | undefined;
}

/**
 * Start the CES (Credential Execution Service) process and perform the RPC
 * handshake. Returns a promise that resolves with the CES client and process
 * manager. Callers can fire-and-forget — the daemon does not need to await
 * this for startup to continue.
 *
 * The managed sidecar accepts exactly one bootstrap connection, so this must
 * be called at the process level (not per-conversation).
 */
export async function startCesProcess(
  config: AssistantConfig,
): Promise<CesStartupResult> {
  const shouldStartCes =
    isCesToolsEnabled(config) || isCesCredentialBackendEnabled(config);
  if (!shouldStartCes) {
    return {
      client: undefined,
      processManager: undefined,
      clientPromise: undefined,
      abortController: undefined,
    };
  }

  const pm = createCesProcessManager({ assistantConfig: config });
  const abortController = new AbortController();
  let clientRef: CesClient | undefined;

  const clientPromise = (async (): Promise<CesClient | undefined> => {
    try {
      const transport = await pm.start();
      if (abortController.signal.aborted) {
        throw new Error("CES initialization aborted during shutdown");
      }
      const client = createCesClient(transport);
      clientRef = client;
      // Resolve the assistant API key so CES can use it for platform
      // credential materialisation. In managed mode the key is provisioned
      // after hatch and stored in the credential store — CES can't read
      // the env var, so we pass it via the handshake.
      const proxyCtx = await resolveManagedProxyContext();
      const assistantId = getPlatformAssistantId();
      const { accepted, reason } = await client.handshake({
        ...(proxyCtx.assistantApiKey
          ? { assistantApiKey: proxyCtx.assistantApiKey }
          : {}),
        ...(assistantId ? { assistantId } : {}),
      });
      if (abortController.signal.aborted) {
        client.close();
        throw new Error("CES initialization aborted during shutdown");
      }
      if (accepted) {
        log.info(
          "CES client initialized and handshake accepted (server-level)",
        );
        return client;
      }
      log.warn(
        { reason },
        "CES handshake rejected — CES tools will be unavailable",
      );
      client.close();
      clientRef = undefined;
      await pm.stop();
      return undefined;
    } catch (err) {
      if (err instanceof CesUnavailableError) {
        log.info(
          { reason: err.message },
          "CES is not available — CES tools will be unavailable",
        );
      } else {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to initialize CES client — CES tools will be unavailable",
        );
      }
      await pm.stop().catch(() => {});
      clientRef = undefined;
      return undefined;
    }
  })();

  return {
    get client() {
      return clientRef;
    },
    processManager: pm,
    clientPromise,
    abortController,
  };
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

    ensureDataDir();

    // Recover from any streaming `.vbundle` import that was interrupted by a
    // crash or SIGKILL. If the previous process died between
    // `carryOverPreservedPaths` and the atomic workspace swap, the live
    // workspace may be missing `data/db` / `data/qdrant` / etc. The marker
    // at `<workspaceDir>.import-marker.json` (persisted before any rename
    // runs) tells us where the orphaned preserved paths landed; the
    // recovery helper moves them back into the live workspace and cleans
    // up the temp tree. Running this BEFORE `initializeDb()` ensures the
    // DB singleton opens against the fully-restored `assistant.db`.
    try {
      const recoveryResult = await recoverInterruptedImport(getWorkspaceDir());
      if (!recoveryResult.ok) {
        // Rollback is intentionally unresolved — backup/temp/marker are
        // preserved on disk so an operator (or a later retry) can finish
        // the recovery. Log loudly so ops sees it, but don't block start-up:
        // the daemon still needs to come up for diagnostics. The next
        // `streamCommitImport` will refuse to start a new import until the
        // marker is resolved.
        log.error(
          { failedCount: recoveryResult.failedCount },
          "Interrupted-import recovery is INCOMPLETE; leftover .pre-import-* / .import-* scratch dirs remain in the workspace. Manual intervention may be required before the next import can run.",
        );
      }
    } catch (err) {
      log.warn(
        { err },
        "recoverInterruptedImport threw during daemon startup; continuing",
      );
    }

    // Load (or generate + persist) the auth signing key so tokens survive
    // daemon restarts.
    const signingKey = resolveSigningKey();
    initAuthSigningKey(signingKey);

    // Load (or generate + persist) the capability-token HMAC secret used
    // to mint scoped tokens for the chrome extension pair endpoint.
    // Wrapped in try/catch so a disk failure here never blocks startup —
    // tokens can still be minted using a lazy on-demand load inside the
    // capability-tokens module.
    try {
      initCapabilityTokenSecret(loadOrCreateCapabilityTokenSecret());
    } catch (err) {
      log.warn(
        { err },
        "Failed to pre-load capability token secret — continuing startup (lazy load will handle subsequent calls)",
      );
    }

    // Pre-populate the feature flag cache from the gateway so all
    // subsequent sync isAssistantFeatureFlagEnabled() calls have data.
    // Fired non-blocking so a slow or unreachable gateway doesn't delay
    // daemon startup (the IPC call has a 3s connect + 5s call timeout
    // that would otherwise stall the critical path).
    void initFeatureFlagOverrides().catch((err) =>
      log.warn({ err }, "Background feature flag init failed"),
    );

    seedInterfaceFiles();

    log.info("Daemon startup: installing templates and initializing DB");
    installTemplates();
    ensurePromptFiles();

    // DB must be initialized before workspace migrations because some
    // workspace migrations (e.g. 009-backfill-conversation-disk-view)
    // depend on DB migrations having run (e.g. the inline-attachment-to-disk
    // backfill that populates attachment filePaths).
    //
    // If DB initialization fails (e.g. a migration error), the daemon
    // continues in a degraded state — DB-dependent features won't work but
    // the HTTP server and config-based subsystems still start so the process
    // remains reachable for health checks and diagnostics.
    let dbReady = false;
    try {
      initializeDb();
      dbReady = true;
      log.info("Daemon startup: DB initialized");
    } catch (err) {
      log.error(
        { err },
        "DB initialization failed — continuing startup in degraded mode",
      );
    }

    // Seed well-known OAuth provider configurations (insert-if-not-exists).
    // Runs in its own try/catch so a seeding error doesn't force degraded mode
    // when the DB itself initialized successfully.
    if (dbReady) {
      try {
        seedOAuthProviders();
      } catch (err) {
        log.warn({ err }, "OAuth provider seeding failed — continuing startup");
      }
    }

    if (dbReady) {
      await runWorkspaceMigrations(getWorkspaceDir(), WORKSPACE_MIGRATIONS);
      log.info("Daemon startup: workspace migrations complete");

      // Profiler retention sweep — prune completed profiler runs to stay
      // within configured byte-count, run-count, and free-space budgets.
      // Runs on every startup and is safe to call from explicit cleanup routes.
      try {
        const sweepResult = runProfilerSweep();
        if (sweepResult.prunedCount > 0 || sweepResult.activeRunOverBudget) {
          log.info(
            {
              prunedCount: sweepResult.prunedCount,
              freedBytes: sweepResult.freedBytes,
              activeRunOverBudget: sweepResult.activeRunOverBudget,
              remainingRuns: sweepResult.remainingRuns,
            },
            "Profiler retention sweep completed on startup",
          );
        }
      } catch (err) {
        log.warn(
          { err },
          "Profiler retention sweep failed — continuing startup",
        );
      }

      // Backfill oauth_connection rows for manual-token providers (Telegram,
      // Slack channel) that already have stored credentials from before the
      // oauth_connection migration. Safe to call on every startup.
      //
      // Must run AFTER workspace migrations.
      // Otherwise syncManualTokenConnection sees no stored credentials and
      // incorrectly removes existing connection rows.
      try {
        await backfillManualTokenConnections();
      } catch (err) {
        log.warn(
          { err },
          "Manual-token connection backfill failed — continuing startup",
        );
      }

      // One-time backfill of `relationship-state.json` for existing or
      // upgraded users so they don't land on an empty Home page after the
      // Phase 3 ship. Runs after DB init + workspace migrations so the
      // writer can actually resolve the guardian persona file and list
      // connected OAuth providers — firing this from `ensurePromptFiles()`
      // would be too early (DB isn't ready yet) and produce a degraded
      // snapshot with zero facts and zero unlocked capabilities.
      //
      // Deferred via `setImmediate` so any sync filesystem/DB work the
      // writer does (`readdirSync`, `readFileSync`, contact + provider
      // lookups) happens on a later tick, off the startup critical path.
      // Failures are logged — not silenced — to match the pattern used by
      // other `void … .catch()` fire-and-forgets in this file and the
      // assistant/CLAUDE.md rule that all errors must be observable.
      setImmediate(() => {
        void backfillRelationshipStateIfMissing().catch((err) =>
          log.warn(
            { err },
            "Relationship state backfill failed — continuing startup",
          ),
        );
      });

      // Backfill injection templates on Slack bot token credentials so the
      // credential proxy can inject Authorization headers. Safe on every startup.
      try {
        backfillSlackInjectionTemplates();
      } catch (err) {
        log.warn(
          { err },
          "Slack injection template backfill failed — continuing startup",
        );
      }

      // Now that workspace migrations have run (including 003-seed-device-id
      // which may copy the legacy installationId into device.json), it is safe
      // to read the device ID and set the Sentry tag.
      setSentryDeviceId(getDeviceId());

      // Purge private (temporary) conversations from the previous daemon run.
      // These are ephemeral by design and should not survive daemon restarts.
      const { count: purgedCount, deletedMemory } = purgePrivateConversations();
      if (purgedCount > 0) {
        log.info(
          { purgedCount },
          `Purged ${purgedCount} private conversation(s) from previous daemon run`,
        );
        // Qdrant may not be ready at startup, so enqueue vector cleanup jobs
        // rather than attempting direct deletion.
        for (const segId of deletedMemory.segmentIds) {
          enqueueMemoryJob("delete_qdrant_vectors", {
            targetType: "segment",
            targetId: segId,
          });
        }
        for (const summaryId of deletedMemory.deletedSummaryIds) {
          enqueueMemoryJob("delete_qdrant_vectors", {
            targetType: "summary",
            targetId: summaryId,
          });
        }
        if (
          deletedMemory.segmentIds.length > 0 ||
          deletedMemory.deletedSummaryIds.length > 0
        ) {
          log.info(
            {
              segments: deletedMemory.segmentIds.length,
              deletedSummaries: deletedMemory.deletedSummaryIds.length,
            },
            "Enqueued Qdrant vector cleanup jobs for purged private conversations",
          );
        }
      }

      // Expire stale pending canonical guardian requests left over from before
      // this process started.  Two categories are cleaned up:
      //
      // 1. Interaction-bound kinds (tool_approval, pending_question) — their
      //    in-memory pending-interaction session references are gone, so they
      //    can never be completed.
      // 2. Any pending request whose expiresAt has already passed — persistent
      //    kinds (access_request, tool_grant_request) that expired while the
      //    daemon was stopped are transitioned so dedup logic doesn't return
      //    stale rows.
      const expiredCount = expireAllPendingCanonicalRequests();
      if (expiredCount > 0) {
        log.info(
          { event: "startup_expired_stale_requests", expiredCount },
          `Expired ${expiredCount} stale canonical request(s) from previous process`,
        );
      }

      // Ensure a vellum guardian binding exists so the identity system works
      // without requiring a manual bootstrap step.
      let localGuardianPrincipalId = "local";
      try {
        localGuardianPrincipalId = ensureVellumGuardianBinding(
          DAEMON_INTERNAL_ASSISTANT_ID,
        );
      } catch (err) {
        log.warn(
          { err },
          "Vellum guardian binding backfill failed — continuing startup",
        );
      }

      // Write a dev-only fallback capability token to the per-instance
      // protected directory so developers can manually pair the chrome
      // extension without the native messaging helper. Production pairing
      // goes through `POST /v1/browser-extension-pair` via the native helper.
      try {
        writeDaemonTokenFallback(localGuardianPrincipalId);
      } catch (err) {
        log.warn(
          { err },
          "Failed to write dev daemon-token fallback — continuing startup",
        );
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
    } // end if (dbReady)

    // Merge CLI-provided default config (from VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH)
    // into the workspace config file before the first loadConfig() call so
    // onboarding preferences are persisted alongside schema defaults.
    mergeDefaultWorkspaceConfig();

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

    // Privacy gating: Sentry crash/error reporting is gated by sendDiagnostics,
    // while the usage telemetry reporter is gated by collectUsageData. Both are
    // disabled in dev mode. Early-startup crashes before this point are still captured.
    const isDevMode = process.env.VELLUM_DEV === "1";
    const sendDiagnostics = !isDevMode && config.sendDiagnostics;
    const collectUsageData = !isDevMode && config.collectUsageData;
    if (!sendDiagnostics) {
      await closeSentry();
    }

    let telemetryReporter: UsageTelemetryReporter | null = null;
    if (collectUsageData) {
      telemetryReporter = new UsageTelemetryReporter();
      telemetryReporter.start();
      log.info("Usage telemetry reporter started");
    }

    // CES lifecycle — kick off early so CES handshake runs concurrently with
    // provider/tool initialization. The CES sidecar accepts exactly one
    // bootstrap connection, so startup must happen at the process level.
    const cesStartupPromise = startCesProcess(config);

    // When the credential backend flag is enabled, CES startup must complete
    // BEFORE provider initialization so credential reads can go through CES.
    // Block with a 20-second timeout — fall back to direct credential store
    // on timeout.
    if (isCesCredentialBackendEnabled(config)) {
      const cesResult = await cesStartupPromise;
      // startCesProcess() returns immediately — the actual handshake runs
      // inside clientPromise. Await it (with a 20s timeout) so the CES client
      // is available before provider initialization.
      if (cesResult.clientPromise) {
        const client = await awaitCesClientWithTimeout(
          cesResult.clientPromise,
          {
            timeoutMs: DEFAULT_CES_STARTUP_TIMEOUT_MS,
            onTimeout: () => {
              log.warn(
                "CES handshake timed out after 20s — falling back to direct credential store",
              );
            },
          },
        );
        if (client) {
          setCesClient(client);
        }
      }

      // Register CES reconnection callback so the credential layer can
      // re-establish the connection when the transport dies, instead of
      // falling back to the encrypted file store.
      if (cesResult.processManager) {
        const pm = cesResult.processManager;

        // Snapshot the managed-proxy context and assistant ID at CES startup
        // so the reconnect closure below never calls back into
        // `resolveManagedProxyContext()`. That function reads the assistant
        // API key via `getSecureKeyAsync()`, which — once `setCesClient()`
        // has resolved the backend to CES RPC — routes the read through CES
        // itself. During a reconnect the old transport is dead and a new
        // one is being set up by this very closure, so the nested credential
        // read recursively awaits its own in-flight reconnection and
        // deadlocks until `CREDENTIAL_OP_TIMEOUT_MS` (45s) fires. That
        // 45-second stall delays every CES restart and causes dependent
        // credential reads (e.g. Meet's STT provider resolution) to return
        // `undefined` during the window. API key rotation uses the
        // `updateAssistantApiKey` RPC on the live client, not a reconnect,
        // so caching at startup is safe.
        const startupProxyCtx = await resolveManagedProxyContext();
        const startupAssistantId = getPlatformAssistantId();

        setCesReconnect(async () => {
          try {
            await pm.stop();
            const transport = await pm.start();
            const newClient = createCesClient(transport);
            const { accepted, reason } = await newClient.handshake({
              ...(startupProxyCtx.assistantApiKey
                ? { assistantApiKey: startupProxyCtx.assistantApiKey }
                : {}),
              ...(startupAssistantId
                ? { assistantId: startupAssistantId }
                : {}),
            });
            if (accepted) {
              log.info("CES reconnection handshake accepted");
              return newClient;
            }
            log.warn({ reason }, "CES reconnection handshake rejected");
            newClient.close();
            await pm.stop().catch(() => {});
            return undefined;
          } catch (err) {
            log.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "CES reconnection attempt failed",
            );
            await pm.stop().catch(() => {});
            return undefined;
          }
        });
      }
    }

    // Start the DaemonServer (conversation manager) before Qdrant so HTTP
    // routes can begin accepting requests while Qdrant initializes.
    log.info("Daemon startup: starting DaemonServer");
    const server = new DaemonServer();
    server.setCes(await cesStartupPromise);

    // Keep the server's CES client ref in sync after reconnection so that
    // secret routes and new conversations use the fresh client.
    onCesClientChanged((client) => server.updateCesClient(client));

    await server.start();
    log.info("Daemon startup: DaemonServer started");

    // Kick off the update bulletin background job AFTER `server.start()`
    // resolves. `server.start()` installs the default wake resolver (via
    // `registerDefaultWakeResolver()`), which the job depends on to actually
    // invoke the agent. Dispatching before that point races the resolver
    // registration and causes `wakeAgentForOpportunity()` to silently return
    // `{invoked: false}`, leaving an orphan background conversation and a
    // wasted LLM title-generation call every startup.
    //
    // Kept fire-and-forget (`void import(...).then(...).catch(...)`) so the
    // daemon never blocks startup on it.
    if (dbReady) {
      void import("../prompts/update-bulletin-job.js")
        .then((m) => m.runUpdateBulletinJobIfNeeded())
        .catch((err) =>
          log.warn({ err }, "Update bulletin job failed — continuing startup"),
        );
    }

    // Mutable refs for Qdrant, memory worker, and backup worker so background
    // init can assign them and the shutdown handler always sees the latest value.
    const bgRefs: {
      qdrantManager: QdrantManager | null;
      memoryWorker: { stop(): void } | null;
      backupWorker: BackupWorkerHandle | null;
    } = { qdrantManager: null, memoryWorker: null, backupWorker: null };

    // Initialize Qdrant vector store and memory worker in the background so the
    // RuntimeHttpServer can start accepting requests without waiting for Qdrant.
    async function initializeQdrantAndMemory(): Promise<void> {
      // Prefer QDRANT_HTTP_PORT (locally-spawned Qdrant on a specific port) over
      // QDRANT_URL (external Qdrant instance) so the CLI can set the port without
      // triggering QdrantManager's external mode which skips local process spawn.
      const qdrantHttpPort = getQdrantHttpPortEnv();
      const qdrantUrl = qdrantHttpPort
        ? `http://127.0.0.1:${qdrantHttpPort}`
        : getQdrantUrlEnv() || config.memory.qdrant.url;
      log.info({ qdrantUrl }, "Daemon startup: initializing Qdrant");
      const manager = new QdrantManager({ url: qdrantUrl });
      bgRefs.qdrantManager = manager;
      const QDRANT_START_MAX_ATTEMPTS = 3;
      let qdrantStarted = false;
      for (let attempt = 1; attempt <= QDRANT_START_MAX_ATTEMPTS; attempt++) {
        try {
          await manager.start();
          qdrantStarted = true;
          break;
        } catch (err) {
          if (attempt < QDRANT_START_MAX_ATTEMPTS) {
            const backoffMs = attempt * 5_000; // 5s, 10s
            log.warn(
              {
                err,
                attempt,
                maxAttempts: QDRANT_START_MAX_ATTEMPTS,
                backoffMs,
              },
              "Qdrant startup failed, retrying",
            );
            await Bun.sleep(backoffMs);
          } else {
            log.warn(
              { err },
              "Qdrant failed to start after all attempts — memory features will be unavailable",
            );
          }
        }
      }

      if (qdrantStarted) {
        try {
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
            log.info(
              "Qdrant collection was migrated — enqueued rebuild_index job",
            );
          }

          log.info("Qdrant vector store initialized");
        } catch (err) {
          log.warn(
            { err },
            "Qdrant client initialization failed — memory features will be degraded",
          );
        }

        // Reconcile the PKB Qdrant index against the on-disk tree. Kept
        // inside the `qdrantStarted` guard so we don't call
        // `getQdrantClient()` (which throws "not initialized") on every
        // startup when Qdrant is unavailable. Fire-and-forget so enqueued
        // re-index jobs drain in the background and first-turn latency
        // stays unaffected.
        void (async () => {
          try {
            const { reconcilePkbIndex } =
              await import("../memory/pkb/pkb-reconcile.js");
            const { PKB_WORKSPACE_SCOPE } =
              await import("../memory/pkb/types.js");
            const pkbRoot = join(getWorkspaceDir(), "pkb");
            await reconcilePkbIndex(pkbRoot, PKB_WORKSPACE_SCOPE);
          } catch (err) {
            log.warn(
              { err },
              "PKB index reconciliation failed — continuing startup",
            );
          }
        })();
      }

      log.info("Daemon startup: starting memory worker");
      bgRefs.memoryWorker = startMemoryJobsWorker();

      log.info("Daemon startup: starting backup worker");
      try {
        bgRefs.backupWorker = startBackupWorker();
      } catch (err) {
        log.warn(
          { err },
          "Backup worker failed to start — continuing without backups",
        );
      }

      // Seed capability graph nodes (new memory graph system)
      try {
        const {
          seedSkillGraphNodes,
          seedCliGraphNodes,
          seedUninstalledCatalogSkillMemories,
        } = await import("../memory/graph/capability-seed.js");
        seedSkillGraphNodes();
        await seedCliGraphNodes();
        void seedUninstalledCatalogSkillMemories().catch((err) =>
          log.warn(
            { err },
            "Uninstalled catalog skill memory seeding failed — continuing",
          ),
        );
      } catch (err) {
        log.warn({ err }, "Graph capability seeding failed — continuing");
      }

      // Auto-bootstrap: if the graph has no non-procedural nodes but historical
      // segments exist, enqueue a one-time graph_bootstrap job to populate the
      // graph from conversation history and journal files.
      try {
        const { maybeEnqueueGraphBootstrap, cleanupStaleItemVectors } =
          await import("../memory/graph/bootstrap.js");
        maybeEnqueueGraphBootstrap();
        // Fire-and-forget: clean up orphaned Qdrant vectors from dropped memory_items table
        void cleanupStaleItemVectors().catch((err) =>
          log.warn({ err }, "Stale item vector cleanup failed — continuing"),
        );
      } catch (err) {
        log.warn({ err }, "Graph bootstrap check failed — continuing");
      }
    }

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
          options
            ? {
                ...(options.trustClass
                  ? {
                      trustContext: {
                        sourceChannel: "vellum",
                        trustClass: options.trustClass,
                      },
                    }
                  : {}),
                ...(options.taskRunId ? { taskRunId: options.taskRunId } : {}),
              }
            : undefined,
        );
      },
      async (schedule) => {
        await emitNotificationSignal({
          sourceEventName: "schedule.notify",
          sourceChannel: "scheduler",
          sourceContextId: schedule.id,
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
          conversationMetadata: {
            groupId: "system:scheduled",
            scheduleJobId: schedule.id,
            source: "schedule",
          },
          dedupeKey: `schedule:notify:${schedule.id}:${Date.now()}`,
          throwOnError: true,
        });
      },
      (schedule) => {
        void emitNotificationSignal({
          sourceEventName: "schedule.complete",
          sourceChannel: "scheduler",
          sourceContextId: schedule.id,
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
          conversationMetadata: {
            groupId: "system:scheduled",
            scheduleJobId: schedule.id,
            source: "schedule",
          },
          dedupeKey: `schedule:complete:${schedule.id}:${Date.now()}`,
        });
      },
      (notification) => {
        void emitNotificationSignal({
          sourceEventName: "watcher.notification",
          sourceChannel: "watcher",
          sourceContextId: `watcher-${Date.now()}`,
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
          dedupeKey: `watcher:notification:${crypto.randomUUID()}`,
        });
      },
      (params) => {
        void emitNotificationSignal({
          sourceEventName: "watcher.escalation",
          sourceChannel: "watcher",
          sourceContextId: `watcher-escalation-${Date.now()}`,
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
          dedupeKey: `watcher:escalation:${crypto.randomUUID()}`,
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

    // Home activity feed scheduler — drives the assistant reflection
    // loop + the platform Gmail digest. Fire-and-forget; a startup
    // failure must never block the rest of daemon boot (CLAUDE.md).
    let feedScheduler: FeedSchedulerHandle | null = null;
    try {
      feedScheduler = startFeedScheduler();
    } catch (err) {
      log.warn(
        { err },
        "Failed to start home feed scheduler — continuing startup",
      );
    }

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
        getOrCreateConversation: (conversationId, options) =>
          server.getConversationForMessages(conversationId, options),
        assistantEventHub,
        resolveAttachments: (attachmentIds) => {
          const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds, {
            hydrateFileData: true,
          });
          const sourcePaths =
            attachmentsStore.getSourcePathsForAttachments(attachmentIds);
          return resolved.map((a) => ({
            id: a.id,
            filename: a.originalFilename,
            mimeType: a.mimeType,
            data: a.dataBase64,
            ...(sourcePaths.has(a.id)
              ? { filePath: sourcePaths.get(a.id) }
              : {}),
          }));
        },
      },
      findConversation: (conversationId) =>
        server.findConversation(conversationId),
      findConversationBySurfaceId: (surfaceId) =>
        server.findConversationBySurfaceId(surfaceId),
      getSkillContext: () => server.getSkillContext(),
      getModelSetContext: () => server.getHandlerContext(),
      conversationManagementDeps: {
        switchConversation: (conversationId) =>
          switchConversation(conversationId, server.getHandlerContext()),
        renameConversation: (conversationId, name) =>
          renameConversation(conversationId, name),
        clearAllConversations: () =>
          clearAllConversations(server.getHandlerContext()),
        cancelGeneration: (conversationId) =>
          cancelGeneration(conversationId, server.getHandlerContext()),
        destroyConversation: (conversationId) =>
          server.destroyConversation(conversationId),
        undoLastMessage: (conversationId) =>
          undoLastMessage(conversationId, server.getHandlerContext()),
        regenerateResponse: (conversationId) => {
          // Resolve conversation key up front so SSE events are tagged with
          // the internal conversation ID, not the raw client key.
          const resolvedId =
            resolveConversationId(conversationId) ?? conversationId;
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
            conversationId,
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
                conversationId: params.conversationId,
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
      onProviderCredentialsChanged: () =>
        server.refreshConversationsForProviderChange(),
      getHeartbeatService: () => server.getHeartbeatService(),
      getFilingService: () => server.getFilingService(),
    });

    // Fire-and-forget: Qdrant init and memory worker startup run concurrently
    // with the rest of daemon boot. Must run AFTER `new RuntimeHttpServer(...)`
    // so the analyze-deps singleton (populated inside `buildRouteTable()`) is
    // available before the memory worker can claim leftover
    // `conversation_analyze` jobs from a prior run. See the daemon-startup
    // ordering test in `assistant/src/daemon/__tests__/`.
    void initializeQdrantAndMemory().catch((err) =>
      log.warn({ err }, "Background Qdrant init failed"),
    );

    // Inject voice bridge deps BEFORE attempting to start the HTTP server.
    // The bridge must be available even when the HTTP server fails to bind.
    setVoiceBridgeDeps({
      getOrCreateConversation: (conversationId, _transport) =>
        server.getConversationForMessages(conversationId),
      resolveAttachments: (attachmentIds) => {
        const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds, {
          hydrateFileData: true,
        });
        const sourcePaths =
          attachmentsStore.getSourcePathsForAttachments(attachmentIds);
        return resolved.map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
          ...(sourcePaths.has(a.id) ? { filePath: sourcePaths.get(a.id) } : {}),
        }));
      },
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
          const conversation =
            await server.getConversationForMessages(conversationId);

          // Constrain pointer generation to a tool-disabled path so call-
          // status events cannot trigger unintended side-effect tools.
          // Incrementing toolsDisabledDepth causes the resolveTools callback
          // to return an empty tool list, preventing the LLM from seeing or
          // invoking any tools during the pointer agent loop.
          //
          // A depth counter (rather than a boolean) ensures that overlapping
          // pointer requests on the same conversation don't clear each other's
          // constraint — each caller increments on entry and decrements in
          // its own finally block.
          conversation.toolsDisabledDepth++;
          try {
            const messageId = await conversation.persistUserMessage(
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
                await conversation.loadFromDb();
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
            await conversation.runAgentLoop(instruction, messageId, (msg) => {
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
            conversation.toolsDisabledDepth--;
          }
        },
      );
      runtimeHttp.setPairingBroadcast((msg) =>
        server.broadcast(msg as ServerMessage),
      );
      initSlashPairingContext(runtimeHttp.getPairingStore());
      server.broadcastStatus();
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

    // Register built-in TTS providers so the provider abstraction can resolve
    // them by ID. Must happen before call controllers or routes are created.
    try {
      registerBuiltinTtsProviders();
    } catch (err) {
      log.warn(
        { err },
        "TTS provider registration failed — continuing with degraded TTS",
      );
    }

    // Initialize providers and tools after the HTTP server is listening so
    // health-check and pairing requests can be served immediately.  Wrapped in
    // its own try/catch so a failure here doesn't tear down the running HTTP
    // server (DaemonServer.start() already calls initializeProviders internally
    // and tools are resolved lazily at conversation creation time).
    try {
      log.info("Daemon startup: initializing providers and tools");
      await initializeProvidersAndTools(config);
    } catch (err) {
      log.warn(
        { err },
        "Provider/tool initialization failed — continuing with degraded functionality",
      );
    }

    writePid(process.pid);
    log.info({ pid: process.pid }, "Daemon started");

    // Install the `assistant` CLI symlink idempotently on every daemon start.
    // Non-blocking — failures are logged but don't affect startup.
    try {
      installAssistantSymlink();
    } catch (err) {
      log.warn({ err }, "Assistant symlink installation failed — continuing");
    }

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
          // Reset the sticky local-backend failure flag so auto mode retries
          // local embeddings without evicting a worker that may already be live.
          const { resetLocalEmbeddingFailureState } =
            await import("../memory/embedding-backend.js");
          resetLocalEmbeddingFailureState();
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

    // Prune trace events older than 7 days to keep the database lean.
    // Deferred so synchronous cleanup doesn't block the startup path.
    setTimeout(() => {
      try {
        const deletedTraceEvents = deleteOldTraceEvents(7);
        if (deletedTraceEvents > 0) {
          log.debug(
            { deletedTraceEvents },
            `Pruned ${deletedTraceEvents} trace event(s) older than 7 days`,
          );
        }
      } catch (err) {
        log.warn({ err }, "Trace event cleanup failed");
      }
    }, 0);

    const workspaceHeartbeat = new WorkspaceHeartbeatService();
    workspaceHeartbeat.start();

    const heartbeatConfig = config.heartbeat;
    const heartbeat = new HeartbeatService({
      processMessage: (conversationId, content, options) =>
        server.processMessage(conversationId, content, undefined, {
          trustContext: {
            sourceChannel: "vellum",
            trustClass: "guardian",
          },
          ...options,
        }),
      alerter: (alert) => server.broadcast(alert),
      onConversationCreated: (info) =>
        server.broadcast({
          type: "heartbeat_conversation_created",
          conversationId: info.conversationId,
          title: info.title,
        }),
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

    const filingConfig = config.filing;
    const filing = new FilingService({
      processMessage: (conversationId, content, options) =>
        server.processMessage(conversationId, content, undefined, {
          trustContext: {
            sourceChannel: "vellum",
            trustClass: "guardian",
          },
          ...options,
        }),
    });
    filing.start();
    server.setFilingService(filing);
    log.info(
      {
        enabled: filingConfig.enabled,
        intervalMs: filingConfig.intervalMs,
      },
      "Filing service configured",
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
      filing,
      hookManager,
      runtimeHttp,
      scheduler,
      feedScheduler,
      getMemoryWorker: () => bgRefs.memoryWorker,
      getBackupWorker: () => bgRefs.backupWorker,
      getQdrantManager: () => bgRefs.qdrantManager,
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
