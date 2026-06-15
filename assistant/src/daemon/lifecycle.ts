import { join } from "node:path";

import { config as dotenvConfig } from "dotenv";

import { refreshBackgroundWakeIntent } from "../background-wake/publisher.js";
import { registerBackgroundWakeRuntime } from "../background-wake/runtime-registry.js";
import { setPointerMessageProcessor } from "../calls/call-pointer-messages.js";
import { reconcileCallsOnStartup } from "../calls/call-recovery.js";
import { setRelayBroadcast } from "../calls/relay-server.js";
import { TwilioConversationRelayProvider } from "../calls/twilio-provider.js";
import { setVoiceBridgeDeps } from "../calls/voice-session-bridge.js";
import { initFeatureFlagOverrides } from "../config/assistant-feature-flags.js";
import {
  getPlatformAssistantId,
  getRuntimeHttpHost,
  getRuntimeHttpPort,
  setIngressPublicBaseUrl,
  validateEnv,
} from "../config/env.js";
import { loadConfig, mergeDefaultWorkspaceConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import type { CesClient } from "../credential-execution/client.js";
import { createCesClient } from "../credential-execution/client.js";
import { refreshManagedConnectionCache } from "../credential-execution/managed-catalog.js";
import {
  type CesProcessManager,
  CesUnavailableError,
  createCesProcessManager,
} from "../credential-execution/process-manager.js";
import {
  awaitCesClientWithTimeout,
  DEFAULT_CES_STARTUP_TIMEOUT_MS,
  injectCesClientWhenReady,
} from "../credential-execution/startup-timeout.js";
import { FilingService } from "../filing/filing-service.js";
import { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import { backfillRelationshipStateIfMissing } from "../home/relationship-state-writer.js";
import { closeSentry, initSentry, setSentryDeviceId } from "../instrument.js";
import {
  startGatewayFlagListener,
  stopGatewayFlagListener,
} from "../ipc/gateway-flag-listener.js";
import { getMcpServerManager } from "../mcp/manager.js";
import {
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../memory/attachments-store.js";
import { expireAllPendingCanonicalRequests } from "../memory/canonical-guardian-store.js";
import { deleteMessageById, getMessages } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { selectEmbeddingBackend } from "../memory/embedding-backend.js";
import { enqueueMemoryJob, isMemoryEnabled } from "../memory/jobs-store.js";
import { startMemoryJobsWorker } from "../memory/jobs-worker.js";
import { initQdrantClient, resolveQdrantUrl } from "../memory/qdrant-client.js";
import { QdrantManager } from "../memory/qdrant-manager.js";
import { rotateToolInvocations } from "../memory/tool-usage-store.js";
import { sweepConceptPageFrontmatter } from "../memory/v2/frontmatter-sweep.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { backfillManualTokenConnections } from "../oauth/manual-token-connection.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import { ensurePromptFiles } from "../prompts/system-prompt.js";
import { runProviderConnectionsBackfill } from "../providers/inference/backfill.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import {
  initAuthSigningKey,
  resolveSigningKey,
} from "../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { recoverInterruptedImport } from "../runtime/migrations/vbundle-streaming-importer.js";
import { registerSecretsDeps } from "../runtime/routes/secrets-deps.js";
import { publishConversationListChanged } from "../runtime/sync/resource-sync-events.js";
import { recoverStaleSchedules } from "../schedule/schedule-recovery.js";
import { startScheduler } from "../schedule/scheduler.js";
import {
  getCesClient,
  onCesClientChanged,
  setCesClient,
  setCesReconnect,
} from "../security/secure-keys.js";
import {
  setUsageTelemetryReporter,
  UsageTelemetryReporter,
} from "../telemetry/usage-telemetry-reporter.js";
import { syncFlagGatedTools } from "../tools/registry.js";
import { registerBuiltinTtsProviders } from "../tts/providers/register-builtins.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger, initLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getDotEnvPath,
  getWorkspaceDir,
} from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import {
  listWorkItems,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import { getWorkflowRunManager } from "../workflows/run-manager.js";
import { repairAdaptiveThinkingOnManagedProfiles } from "../workspace/adaptive-thinking-repair.js";
import { WorkspaceHeartbeatService } from "../workspace/heartbeat-service.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { runWorkspaceMigrations } from "../workspace/migrations/runner.js";
import {
  cleanupPidFile,
  cleanupPidFileIfOwner,
  writePid,
} from "./daemon-control.js";
import {
  evaluateDiskPressureNow,
  startDiskPressureGuard,
  stopDiskPressureGuard,
} from "./disk-pressure-guard.js";
import { initializePlugins } from "./external-plugins-bootstrap.js";
import { backfillSlackInjectionTemplates } from "./handlers/config-slack-channel.js";
import { installAssistantSymlink } from "./install-symlink.js";
import {
  maybeRebuildMemoryV2Concepts,
  rebuildBm25CorpusStatsAndReseedSkills,
} from "./memory-v2-startup.js";
import { startOrphanReaper, stopOrphanReaper } from "./orphan-reaper.js";
import { processMessage } from "./process-message.js";
import { runProfilerSweep } from "./profiler-run-store.js";
import {
  initializeProvidersAndTools,
  registerMessagingProviders,
  registerWatcherProviders,
} from "./providers-setup.js";
import { DaemonServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown-handlers.js";
import { refreshSkillCapabilityMemories } from "./skill-memory-refresh.js";

const log = getLogger("lifecycle");
let diskPressureStartupSampleTimer: ReturnType<typeof setTimeout> | null = null;

function loadDotEnv(): void {
  dotenvConfig({ path: getDotEnvPath(), quiet: true });
}

function runDeferredDiskPressureStartupSample(): void {
  diskPressureStartupSampleTimer = null;
  try {
    const status = evaluateDiskPressureNow();
    if (status.error) {
      log.warn(
        { error: status.error },
        "Disk pressure guard sample failed during startup — continuing unlocked",
      );
    }
  } catch (err) {
    log.warn(
      { err },
      "Disk pressure guard failed during startup — continuing unlocked",
    );
  }
}

export function startDiskPressureGuardForLifecycle(): void {
  try {
    const startedStatus = startDiskPressureGuard();
    if (!startedStatus.enabled) return;
    if (!diskPressureStartupSampleTimer) {
      diskPressureStartupSampleTimer = setTimeout(
        runDeferredDiskPressureStartupSample,
        0,
      );
      (diskPressureStartupSampleTimer as { unref?: () => void }).unref?.();
    }
  } catch (err) {
    log.warn(
      { err },
      "Disk pressure guard failed during startup — continuing unlocked",
    );
  }
}

export function stopDiskPressureGuardForLifecycle(): void {
  if (diskPressureStartupSampleTimer) {
    clearTimeout(diskPressureStartupSampleTimer);
    diskPressureStartupSampleTimer = null;
  }
  stopDiskPressureGuard();
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
async function startCesProcess(
  config: AssistantConfig,
): Promise<CesStartupResult> {
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
  const startupStartedAt = Date.now();
  // dotenv loads before the first log call so the lazy root logger
  // initializes against the final VELLUM_WORKSPACE_DIR / log path, not
  // whatever was in the live environment at process spawn.
  loadDotEnv();
  validateEnv();
  log.info({ version: APP_VERSION }, "Daemon starting");

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

    // Start the runtime HTTP server early so /healthz answers ASAP.
    let runtimeHttp: RuntimeHttpServer | null = null;
    const httpPort = getRuntimeHttpPort();
    const httpHostname = getRuntimeHttpHost();
    log.info({ httpPort }, "Daemon startup: starting runtime HTTP server");

    runtimeHttp = new RuntimeHttpServer({
      port: httpPort,
      hostname: httpHostname,
    });

    // Isolated try/catch around start() — a bind failure (port in use,
    // permission denied, fd exhaustion) must not tear down the rest of
    // daemon startup. The daemon falls back to IPC-only operation when
    // runtimeHttp is null.
    try {
      await runtimeHttp.start();
      log.info(
        { port: httpPort, hostname: httpHostname },
        "Daemon startup: runtime HTTP server listening",
      );
    } catch (err) {
      log.warn(
        { err, port: httpPort },
        "Failed to start runtime HTTP server, continuing without it",
      );
      runtimeHttp = null;
    }

    // Pre-populate feature flag overrides so subsequent sync
    // isAssistantFeatureFlagEnabled() calls have data. Fired non-blocking
    // so a slow or unreachable gateway doesn't delay daemon startup (the
    // IPC call has a 3s connect + 5s call timeout that would otherwise
    // stall the critical path).
    // After the async fetch resolves, (re)register any flag-gated tools
    // (`workflows`, `ces-tools`): `initializeTools()` runs during startup before
    // this fetch completes, so without this follow-up sync a flag-enabled
    // assistant would not expose the gated tools until a restart (which can lose
    // the same race). Enable-direction only; chained so it sees the fresh cache.
    void initFeatureFlagOverrides()
      .then(() => syncFlagGatedTools())
      .catch((err) => log.warn({ err }, "Background feature flag init failed"));

    startGatewayFlagListener();

    log.info("Daemon startup: initializing DB");
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

      // Seed canonical inference provider_connections and backfill any legacy
      // profiles that pre-date the connection field. Runs after workspace
      // migrations so migration 076 has already stripped services.inference.mode
      // before backfill reads config. Idempotent — runs every boot so new
      // canonicals propagate and manual config.json edits self-heal.
      try {
        runProviderConnectionsBackfill(getDb());
      } catch (err) {
        log.warn(
          { err },
          "provider_connections backfill failed — continuing startup",
        );
      }

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

    // Populate the managed-connection cache so the `14-connected-services`
    // bundled section (rendered by `renderConnectedServices()` in
    // system-sections.ts) can include platform-managed OAuth connections
    // (e.g. Twitter) in the system prompt from the first turn.  This is
    // an HTTP-only call with no DB dependency, so it runs regardless of
    // dbReady.  A periodic refresh keeps the cache current when users
    // connect/disconnect managed providers while the assistant is running.
    void refreshManagedConnectionCache().catch((err) =>
      log.warn(
        { err },
        "Managed connection cache refresh failed — continuing startup",
      ),
    );
    const MANAGED_CONNECTION_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    setInterval(() => {
      void refreshManagedConnectionCache().catch((err) =>
        log.warn({ err }, "Periodic managed connection cache refresh failed"),
      );
    }, MANAGED_CONNECTION_REFRESH_INTERVAL_MS);

    // Merge CLI-provided default config (from VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH)
    // into the workspace config file before profile seeding and the first
    // loadConfig() call so onboarding/platform preferences are visible to the
    // seeder and persisted alongside schema defaults.
    const defaultConfigMerge = mergeDefaultWorkspaceConfig();

    // Seed inference profiles into the workspace config. Managed Anthropic
    // profiles are overwritten on every boot so Vellum can push updates.
    // Off-platform hatches additionally create user profiles + a personal
    // provider connection for the hatch provider.
    try {
      seedInferenceProfiles({
        preserveProfileNames: defaultConfigMerge.providedLlmProfileNames,
        preserveActiveProfile: defaultConfigMerge.providedLlmActiveProfile,
        isHatch: defaultConfigMerge.hadOverlay,
        db: dbReady ? getDb() : undefined,
      });
      log.info("Inference profile seeding complete");
    } catch (err) {
      log.warn(
        { err },
        "Inference profile seeding failed — continuing startup",
      );
    }

    // Re-run the adaptive thinking repair after overlay merge + profile seeding.
    // Workspace migration 097 enables adaptive thinking on managed profiles, but
    // it runs before mergeDefaultWorkspaceConfig() which can overwrite the fix
    // with overlay profiles that have thinking disabled or absent. On-platform
    // instances where the overlay supplies "balanced" / "quality-optimized"
    // profiles without thinking enabled would be stuck permanently because the
    // migration is already checkpointed as completed. This idempotent repair
    // ensures thinking is enabled regardless of overlay ordering.
    if (defaultConfigMerge.hadOverlay) {
      try {
        repairAdaptiveThinkingOnManagedProfiles(getWorkspaceDir());
        log.info("Post-overlay adaptive thinking repair complete");
      } catch (err) {
        log.warn(
          { err },
          "Post-overlay adaptive thinking repair failed — continuing startup",
        );
      }
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

    // Privacy gating: Sentry crash/error reporting is gated by sendDiagnostics,
    // while the usage telemetry reporter re-checks collectUsageData on every
    // flush. Both are disabled in dev mode. Early-startup crashes before this
    // point are still captured.
    const isDevMode = process.env.VELLUM_DEV === "1";
    const sendDiagnostics = !isDevMode && config.sendDiagnostics;
    if (!sendDiagnostics) {
      await closeSentry();
    }

    // Construct and start the reporter even when usage collection is disabled:
    // flush() re-checks collectUsageData each cycle and, when opted out, sends
    // nothing but advances all watermarks (including the final flush in
    // stop()). New opted-out tool_invocations rows are already unreportable by
    // construction — the audit listener persists NULL telemetry columns for
    // them, which the tool_executed projection filters out — so the opted-out
    // flushes are defense in depth there (covering rows recorded under builds
    // that predate that write-time gate) and remain the primary guard for the
    // always-on tables without a write-time gate (llm_usage, turn events).
    // Deliberately NOT gated on dbReady: getDb()
    // can still work when initializeDb() failed mid-migration, in which case
    // the audit listener keeps writing rows that the opt-out branch must keep
    // covered. The reporter is degraded-mode safe — its constructor and
    // flush() treat DB errors as non-fatal.
    let telemetryReporter: UsageTelemetryReporter | null = null;
    if (!isDevMode) {
      telemetryReporter = new UsageTelemetryReporter();
      setUsageTelemetryReporter(telemetryReporter);
      telemetryReporter.start();
      log.info(
        { collectUsageData: config.collectUsageData },
        "Usage telemetry reporter started",
      );
    }

    // CES lifecycle — kick off early so CES handshake runs concurrently with
    // provider/tool initialization. The CES sidecar accepts exactly one
    // bootstrap connection, so startup must happen at the process level.
    const cesStartupPromise = startCesProcess(config);

    // CES startup must complete BEFORE provider initialization so credential
    // reads can go through CES. Block with a 20-second timeout — fall back to
    // direct credential store on timeout.
    const cesResult = await cesStartupPromise;
    // startCesProcess() returns immediately — the actual handshake runs
    // inside clientPromise. Await it (with a 20s timeout) so the CES client
    // is available before provider initialization.
    if (cesResult.clientPromise) {
      const client = await awaitCesClientWithTimeout(cesResult.clientPromise, {
        timeoutMs: DEFAULT_CES_STARTUP_TIMEOUT_MS,
        onTimeout: () => {
          log.warn(
            "CES handshake timed out after 20s — falling back to direct credential store",
          );
        },
      });
      if (client) {
        setCesClient(client);
      } else {
        // The handshake lost the startup race, so provider init proceeds on
        // the direct credential store. Still inject the CES client into the
        // resolver once the handshake completes, so CES tools and the
        // approval bridge route through CES rather than reporting it
        // unavailable for the rest of the process.
        injectCesClientWhenReady(cesResult.clientPromise, {
          getCesClient,
          setCesClient,
        });
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
            ...(startupAssistantId ? { assistantId: startupAssistantId } : {}),
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

    // Bring up the plugin layer: install the runtime bridge, register the
    // first-party defaults, load user plugins, and run every plugin's
    // `init()`. Ordering is load-bearing (defaults register ahead of user
    // plugins so they compose innermost) and plugin failures are contained so
    // they can't block daemon startup.
    await initializePlugins();

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
    startDiskPressureGuardForLifecycle();
    startOrphanReaper();

    // Mutable refs for Qdrant and memory worker so background
    // init can assign them and the shutdown handler always sees the latest value.
    const bgRefs: {
      qdrantManager: QdrantManager | null;
      memoryWorker: { stop(): void } | null;
    } = { qdrantManager: null, memoryWorker: null };

    // Initialize Qdrant vector store and memory worker in the background so the
    // RuntimeHttpServer can start accepting requests without waiting for Qdrant.
    async function initializeQdrantAndMemory(): Promise<void> {
      const qdrantUrl = resolveQdrantUrl(config);
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
        // Skip the v1 Qdrant collection lifecycle when memory v2 is active —
        // the v1 collection has no writers (handleRemember returns early) or
        // readers (graph search is bypassed) under v2, so ensuring/migrating
        // it just maintains a dead-on-arrival collection. Existing on-disk
        // collections are left intact so flipping v2 off restores v1 cleanly.
        if (!config.memory.v2.enabled) {
          try {
            const embeddingSelection = await selectEmbeddingBackend(config);
            // Sentinel only encodes the dense provider+model identity; sparse
            // encoder changes never require collection recreation, so they
            // intentionally do not contribute to the v1 collection identity.
            const embeddingModel = embeddingSelection.backend
              ? `${embeddingSelection.backend.provider}:${embeddingSelection.backend.model}`
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
            if (migrated && isMemoryEnabled()) {
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
        }

        // Detect schema drift on the v2 concept-page collection (e.g.
        // pre-#29823 collections lacking summary_dense / summary_sparse) and
        // recreate + enqueue a reembed when needed. Awaited inline so the
        // reembed enqueue happens before the memory worker drains its first
        // batch; the call's own try/catch keeps any v2-side failure from
        // blocking the v1 PKB reconcile or BM25 build below.
        try {
          await maybeRebuildMemoryV2Concepts(config);
        } catch (err) {
          log.warn(
            { err },
            "Memory v2 collection schema check threw — continuing startup",
          );
        }

        // Reconcile the PKB Qdrant index against the on-disk tree. Gated on
        // !v2 because PKB is the v1 storage layer; under v2 the v1 collection
        // is not initialized, so calling `getQdrantClient()` here would throw.
        // Fire-and-forget so enqueued re-index jobs drain in the background
        // and first-turn latency stays unaffected.
        if (!config.memory.v2.enabled) {
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

        void rebuildBm25CorpusStatsAndReseedSkills(config);

        try {
          await sweepConceptPageFrontmatter(config, getWorkspaceDir());
        } catch (err) {
          log.warn(
            { err },
            "Concept page frontmatter sweep threw — continuing startup",
          );
        }
      }

      log.info("Daemon startup: starting memory worker");
      bgRefs.memoryWorker = startMemoryJobsWorker();

      // Seed capability graph nodes (new memory graph system)
      try {
        const { seedCliGraphNodes } =
          await import("../memory/graph/capability-seed.js");
        refreshSkillCapabilityMemories(config);
        await seedCliGraphNodes();
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

    try {
      recoverStaleSchedules();
    } catch (err) {
      log.error({ err }, "Schedule recovery failed — continuing startup");
    }

    // Reconcile workflow runs orphaned by a crash: any row still `running` was
    // in flight when the process died (the engine always finishes its row on
    // exit), so flip it to `interrupted` to make it eligible for an explicit
    // resume. Status only — accounting counters are preserved. Never blocks
    // startup on failure.
    try {
      const reconciled = getWorkflowRunManager().reconcileOrphanedRuns();
      if (reconciled > 0) {
        log.info(
          { reconciled },
          "Reconciled orphaned workflow runs to interrupted",
        );
      }
    } catch (err) {
      log.error(
        { err },
        "Workflow run reconciliation failed — continuing startup",
      );
    }

    const scheduler = startScheduler(
      async (conversationId, message, options) => {
        await processMessage(
          conversationId,
          message,
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
                ...(options.overrideProfile
                  ? { overrideProfile: options.overrideProfile }
                  : {}),
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
      (info) => {
        broadcastMessage({
          type: "schedule_conversation_created",
          conversationId: info.conversationId,
          scheduleJobId: info.scheduleJobId,
          title: info.title,
        });
        publishConversationListChanged("created");
      },
    );

    // Wire up the runtime HTTP server's deferred dependencies. The server
    // itself was bound early in runDaemon (right after the auth signing key
    // was loaded) so /healthz and /readyz already answer 200 OK; these
    // registrations attach the live DaemonServer / CES / relay handlers to
    // the running routes. They're module-level state, so they're effective
    // even when the HTTP server failed to bind (IPC clients still work).
    registerSecretsDeps({
      getCesClient: () => server.getCesClient(),
      onProviderCredentialsChanged: () =>
        server.refreshConversationsForProviderChange(),
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

    // Inject voice bridge deps so route handlers + the relay pipeline can
    // resolve a conversation by ID once a call lands. Module-level state,
    // so available even when the HTTP server failed to bind.
    setVoiceBridgeDeps({
      getOrCreateConversation: (conversationId, _transport) =>
        server.getConversationForMessages(conversationId),
      resolveAttachments: (attachmentIds) => {
        const resolved = getAttachmentsByIds(attachmentIds, {
          hydrateFileData: true,
        });
        const sourcePaths = getSourcePathsForAttachments(attachmentIds);
        return resolved.map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
          ...(sourcePaths.has(a.id) ? { filePath: sourcePaths.get(a.id) } : {}),
        }));
      },
    });
    try {
      setRelayBroadcast((msg) => broadcastMessage(msg));
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
            const { id: messageId } = await conversation.persistUserMessage({
              content: instruction,
              metadata: { pointerInstruction: true },
              displayContent: "[Call status event]",
            });

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
            await conversation.runAgentLoop(instruction, messageId, {
              onEvent: (msg) => {
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
              },
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
      server.broadcastStatus();
    } catch (err) {
      log.warn(
        { err },
        "Failed to wire runtime HTTP server deps, continuing without them",
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

    // Install the `assistant` CLI symlink idempotently on every daemon start.
    // Non-blocking — failures are logged but don't affect startup.
    try {
      installAssistantSymlink();
    } catch (err) {
      log.warn({ err }, "Assistant symlink installation failed — continuing");
    }

    // Seed preloaded apps (personal landing page) in background (non-blocking).
    void import("../memory/preloaded-apps.js")
      .then(({ seedPreloadedApps }) => seedPreloadedApps(config))
      .catch((err) =>
        log.warn({ err }, "Preloaded app seeding failed — continuing"),
      );

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
      void rotateToolInvocations(config.auditLog.retentionDays).catch((err) => {
        log.warn({ err }, "Audit log rotation failed");
      });
    }

    const workspaceHeartbeat = new WorkspaceHeartbeatService();
    workspaceHeartbeat.start();

    const heartbeatConfig = config.heartbeat;
    const heartbeat = new HeartbeatService({
      alerter: (alert) => broadcastMessage(alert),
      onConversationCreated: (info) =>
        broadcastMessage({
          type: "heartbeat_conversation_created",
          conversationId: info.conversationId,
          title: info.title,
        }),
    });
    heartbeat.start();
    registerBackgroundWakeRuntime({ scheduler, heartbeat });
    refreshBackgroundWakeIntent("daemon-startup");
    log.info(
      {
        enabled: heartbeatConfig.enabled,
        intervalMs: heartbeatConfig.intervalMs,
      },
      "Heartbeat service configured",
    );

    // Filing yields to the memory v2 consolidation job when v2 is enabled —
    // both serve the same role (periodic background memory processing) and
    // running both is redundant. The consolidation job runs through the
    // memory jobs worker (see `maybeEnqueueGraphMaintenanceJobs`).
    const memoryV2Enabled = config.memory.v2.enabled;
    let filing: FilingService | null = null;
    if (!memoryV2Enabled) {
      const filingConfig = config.filing;
      filing = new FilingService();
      filing.start();
      log.info(
        {
          enabled: filingConfig.enabled,
          intervalMs: filingConfig.intervalMs,
        },
        "Filing service configured",
      );
    } else {
      log.info(
        "Filing service skipped — memory v2 consolidation is the active background memory job",
      );
    }

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
      runtimeHttp,
      scheduler,
      getMemoryWorker: () => bgRefs.memoryWorker,
      getQdrantManager: () => bgRefs.qdrantManager,
      mcpManager,
      telemetryReporter,
      cleanupPidFile: () => {
        stopGatewayFlagListener();
        stopDiskPressureGuardForLifecycle();
        stopOrphanReaper();
        cleanupPidFile();
      },
    });

    log.info(
      {
        durationMs: Date.now() - startupStartedAt,
        pid: process.pid,
      },
      "Daemon started",
    );
  } catch (err) {
    log.error({ err }, "Daemon startup failed — cleaning up");
    stopDiskPressureGuardForLifecycle();
    stopOrphanReaper();
    cleanupPidFileIfOwner(process.pid);
    throw err;
  }
}
