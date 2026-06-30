import { join } from "node:path";

import { config as dotenvConfig } from "dotenv";

import { setPointerMessageProcessor } from "../calls/call-pointer-messages.js";
import { reconcileCallsOnStartup } from "../calls/call-recovery.js";
import { setRelayBroadcast } from "../calls/relay-server.js";
import { TwilioConversationRelayProvider } from "../calls/twilio-provider.js";
import { setVoiceBridgeDeps } from "../calls/voice-session-bridge.js";
import { initFeatureFlagOverrides } from "../config/assistant-feature-flags.js";
import { setIngressPublicBaseUrl, validateEnv } from "../config/env.js";
import { loadConfig, mergeDefaultWorkspaceConfig } from "../config/loader.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import { reconcileFlagGatedProfiles } from "../config/sync-gated-profiles.js";
import { expireAllPendingCanonicalRequests } from "../contacts/canonical-guardian-store.js";
import { startCes } from "../credential-execution/ces-runtime.js";
import { refreshManagedConnectionCache } from "../credential-execution/managed-catalog.js";
import { startHeartbeatService } from "../heartbeat/heartbeat-service.js";
import { backfillRelationshipStateIfMissing } from "../home/relationship-state-writer.js";
import { closeSentry, initSentry, setSentryDeviceId } from "../instrument.js";
import { startCliIpcServer } from "../ipc/assistant-server.js";
import { startGatewayFlagListener } from "../ipc/gateway-flag-listener.js";
import { registerMemoryJobHandlers } from "../jobs/register-job-handlers.js";
import { backfillManualTokenConnections } from "../oauth/manual-token-connection.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import {
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../persistence/attachments-store.js";
import {
  clearStaleProcessingFlags,
  deleteMessageById,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { selectEmbeddingBackend } from "../persistence/embeddings/embedding-backend.js";
import {
  initQdrantClient,
  resolveQdrantUrl,
} from "../persistence/embeddings/qdrant-client.js";
import { createQdrantManager } from "../persistence/embeddings/qdrant-manager.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
} from "../persistence/jobs-store.js";
import { startMemoryJobsWorker } from "../persistence/jobs-worker.js";
import { startConsentRefresh } from "../platform/consent-cache.js";
import { syncWorkspaceIdentityToPlatform } from "../platform/sync-identity.js";
import { sweepConceptPageFrontmatter } from "../plugins/defaults/memory/v2/frontmatter-sweep.js";
import {
  maybeRebuildMemoryV2Concepts,
  rebuildBm25CorpusStatsAndReseedSkills,
} from "../plugins/defaults/memory/v2/memory-v2-startup.js";
import { ensurePromptFiles } from "../prompts/system-prompt.js";
import { runProviderConnectionsBackfill } from "../providers/inference/backfill.js";
import { initializeProviders } from "../providers/registry.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import {
  initAuthSigningKey,
  resolveSigningKey,
} from "../runtime/auth/token-service.js";
import { startRuntimeHttpServer } from "../runtime/http-server.js";
import { warmLocalGuardianPrincipalCache } from "../runtime/local-actor-identity.js";
import { recoverInterruptedImport } from "../runtime/migrations/vbundle-streaming-importer.js";
import { publishConfigChanged } from "../runtime/sync/resource-sync-events.js";
import { recoverStaleSchedules } from "../schedule/schedule-recovery.js";
import { startScheduler } from "../schedule/scheduler.js";
import { startUsageTelemetryReporter } from "../telemetry/usage-telemetry-reporter.js";
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
import { startWorkspaceHeartbeatService } from "../workspace/heartbeat-service.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { runWorkspaceMigrations } from "../workspace/migrations/runner.js";
import { startAppSourceWatcher } from "./app-source-watcher.js";
import { startConfigWatcher } from "./config-watcher.js";
import { startConversationEvictor } from "./conversation-evictor.js";
import { getOrCreateConversation } from "./conversation-store.js";
import { writePid } from "./daemon-control.js";
import { setDbReady, setStartupComplete } from "./daemon-readiness.js";
import {
  evaluateDiskPressureNow,
  startDiskPressureGuard,
  stopDiskPressureGuard,
} from "./disk-pressure-guard.js";
import { reconcileEmbeddingIdentity } from "./embedding-reconcile.js";
import { startEventLoopWatchdog } from "./event-loop-watchdog.js";
import { initializePlugins } from "./external-plugins-bootstrap.js";
import { backfillSlackInjectionTemplates } from "./handlers/config-slack-channel.js";
import { installAssistantSymlink } from "./install-symlink.js";
import { startOrphanReaper } from "./orphan-reaper.js";
import { elevatePointerConversationToGuardian } from "./pointer-conversation-trust.js";
import { runProfilerSweep } from "./profiler-run-store.js";
import {
  initializeProvidersAndTools,
  registerMessagingProviders,
  registerWatcherProviders,
} from "./providers-setup.js";
import { installShutdownHandlers } from "./shutdown-handlers.js";
import { refreshSkillCapabilityMemories } from "./skill-memory-refresh.js";
import { broadcastDaemonStatus } from "./status.js";

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

// Entry point for the daemon process itself
export async function runDaemon(): Promise<void> {
  const startupStartedAt = Date.now();
  // dotenv loads before the first log call so the lazy root logger
  // initializes against the final VELLUM_WORKSPACE_DIR / log path, not
  // whatever was in the live environment at process spawn.
  loadDotEnv();
  validateEnv();
  log.info({ version: APP_VERSION }, "Daemon starting");

  // Initialize crash reporting eagerly so the Sentry client is ready before
  // early startup failures occur. Events are dropped (beforeSend) until the
  // consent gate below confirms share_diagnostics opt-in; dev mode and the
  // legacy local opt-out hard-disable via closeSentry().
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

  // Start the runtime HTTP server early so /healthz answers ASAP. A bind
  // failure is non-fatal — the daemon falls back to IPC-only operation.
  await startRuntimeHttpServer();

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
  // Then reconcile flag-gated managed profiles (OS Beta): `seedInferenceProfiles()`
  // runs synchronously earlier in boot before flags are available, so this lands
  // the profile on the same boot once the flag cache is populated. When this
  // reconcile is the call that mutates config (it raced ahead of the gateway
  // flag listener), publish the config invalidation so any client that already
  // fetched `GET /v1/config` refreshes its profile picker.
  // Profiles are reconciled only when flags actually loaded from the gateway:
  // a failed fetch leaves the cache unset and resolves `os-beta` to its
  // registry default `false`, which would remove the user's profile and reset
  // their selection. Tool sync tolerates the default and stays unconditional.
  void initFeatureFlagOverrides()
    .then(async (loaded) => {
      await syncFlagGatedTools();
      if (loaded && reconcileFlagGatedProfiles()) {
        publishConfigChanged();
      }
    })
    .catch((err) => log.warn({ err }, "Background feature flag init failed"));

  startGatewayFlagListener();

  log.info("Daemon startup: initializing DB");
  ensurePromptFiles();

  // DB must be initialized before workspace migrations because some
  // workspace migrations (e.g. 009-backfill-conversation-disk-view)
  // depend on DB migrations having run (e.g. the inline-attachment-to-disk
  // backfill that populates attachment filePaths).
  //
  // The daemon continues in a degraded state on either DB failure mode:
  // (a) initializeDb() throws (e.g. the DB can't be opened), or (b) the DB
  // opens but one or more migrations failed (initializeDb resolves with
  // migrationsOk:false rather than throwing, per the daemon-never-blocks
  // philosophy). In both cases DB-dependent features won't work, but the
  // HTTP server and config-based subsystems still start so the process
  // remains reachable for diagnostics. The trivial /healthz and detailed
  // /v1/health(z) endpoints still answer 200, but setDbReady(true) runs only
  // when migrations all applied, so the readiness latch stays unset and
  // /readyz reports not-ready (503) for the rest of the process lifetime.
  // That 503 is intentional: a DB-broken daemon should fail readiness so it
  // is not routed user traffic.
  //
  // The local `dbReady` and the module-level readiness latch intentionally
  // diverge on the migration-failure path: `dbReady` stays true to allow the
  // downstream best-effort seeding / workspace migrations, while the latch
  // stays unset to keep /readyz 503.
  let dbReady = false;
  try {
    const { migrationsOk } = await initializeDb();
    dbReady = true;
    if (migrationsOk) {
      setDbReady(true);
      log.info("Daemon startup: DB initialized");
    } else {
      log.error(
        "Daemon startup: DB opened but one or more migrations failed — /readyz will remain unready (degraded mode)",
      );
    }
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
    const migrationSummary = await runWorkspaceMigrations(
      getWorkspaceDir(),
      WORKSPACE_MIGRATIONS,
    );
    log.info(migrationSummary, "Daemon startup: workspace migrations complete");

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
      log.warn({ err }, "Profiler retention sweep failed — continuing startup");
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
    log.warn({ err }, "Inference profile seeding failed — continuing startup");
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

  // Reconcile conversations left mid-turn by the previous shutdown. Their
  // `processing_started_at` is still set even though the in-memory agent loop
  // that owned the turn is gone.
  if (dbReady) {
    if (config.conversations.resumeProcessingOnStartup) {
      // TODO: automatically resume the interrupted turn for each conversation
      // whose processing flag is still set instead of clearing it.
    } else {
      try {
        const cleared = clearStaleProcessingFlags();
        if (cleared > 0) {
          log.info(
            { count: cleared },
            "Cleared stale conversation processing flags from previous process",
          );
        }
      } catch (err) {
        log.warn(
          { err },
          "Failed to clear stale conversation processing flags — continuing startup",
        );
      }
    }
  }

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

  // Privacy gating: Sentry crash/error reporting follows the platform owner's
  // share_diagnostics consent; the usage telemetry reporter re-checks
  // share_analytics on every flush. Both are disabled in dev mode. Sentry was
  // initialized early, but beforeSend re-reads getCachedShareDiagnostics() on
  // every event, so it drops events until consent confirms opt-in and honors a
  // later revocation within one refresh cycle (the cache is refreshed by
  // startConsentRefresh() below, mirroring the share_analytics posture).
  const isDevMode = process.env.VELLUM_DEV === "1";
  if (isDevMode || config.legacyDiagnosticsOptOut === true) {
    // Dev mode and a preserved legacy local opt-out both disable Sentry
    // unconditionally, without waiting on platform consent.
    await closeSentry();
  }

  // Refresh the consent cache regardless of dev mode so record-time telemetry
  // writes (gated on getCachedShareAnalytics()) work in dev too. The reporter
  // flush stays dev-gated above, so dev still never sends telemetry to the
  // platform. Fire-and-forget: startConsentRefresh() runs an immediate
  // non-blocking refresh, so the startup hot path is never blocked.
  startConsentRefresh();

  // Bring up the daemon's CES connection (process + handshake + reconnect
  // wiring). Blocks up to a 20s timeout so credential reads route through CES
  // before provider init; non-fatal — falls back to the direct credential store
  // on failure. The sidecar accepts exactly one bootstrap connection, so this
  // happens at the process level.
  await startCes(config);

  // Bring up the plugin layer: install the runtime bridge, register the
  // first-party defaults, load user plugins, and run every plugin's
  // `init()`. Ordering is load-bearing (defaults register ahead of user
  // plugins so they compose innermost) and plugin failures are contained so
  // they can't block daemon startup.
  await initializePlugins();

  // Initialize providers before Qdrant so HTTP routes can begin accepting
  // requests while Qdrant initializes, then best-effort sync the workspace
  // identity name to the platform record.
  await initializeProviders(config);
  syncWorkspaceIdentityToPlatform();

  // Start the idle/LRU/memory-pressure sweep over the in-memory conversation
  // pool.
  startConversationEvictor();

  // Watch workspace files (config, prompts, skills, sounds, avatar) and react
  // to changes: evict conversations so the next turn rebuilds against the new
  // config, and broadcast the relevant resource-changed events to clients.
  startConfigWatcher();

  // Watch app source directories so edits recompile + refresh surfaces across
  // all conversations.
  startAppSourceWatcher();

  // Start the CLI IPC server. Throws on EADDRINUSE to abort startup when another
  // daemon already holds the socket, so this process never runs background jobs
  // against the shared database as an unmanageable duplicate.
  await startCliIpcServer();

  // Warm the gateway guardian-delivery cache so the SSE eager-subscribe path
  // (sync, IO-free) resolves the local actor principal on the FIRST client
  // registration. Without this, a cold cache regresses host-proxy same-user
  // targeting until a later reconnect. Non-blocking: failures aren't cached
  // and the async hot paths re-warm on their next read.
  void warmLocalGuardianPrincipalCache().catch((err) =>
    log.warn({ err }, "Guardian principal cache warm failed — continuing"),
  );

  startUsageTelemetryReporter();
  startDiskPressureGuardForLifecycle();
  startOrphanReaper();
  startEventLoopWatchdog();

  // Initialize Qdrant vector store and memory worker in the background so the
  // RuntimeHttpServer can start accepting requests without waiting for Qdrant.
  async function initializeQdrantAndMemory(): Promise<void> {
    const qdrantUrl = resolveQdrantUrl(config);
    log.info({ qdrantUrl }, "Daemon startup: initializing Qdrant");
    const manager = createQdrantManager({ url: qdrantUrl });
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

      // Reconcile the committed embedding-collection dimension against a live
      // backend probe (confirm-before-destroy) before the v2 rebuild and the
      // worker drain, so `memory.qdrant.vectorSize` is settled first. Its own
      // try/catch keeps an unreachable backend or reconcile failure from
      // blocking startup.
      try {
        await reconcileEmbeddingIdentity(config);
      } catch (err) {
        log.warn(
          { err },
          "Embedding-identity reconcile threw — continuing startup",
        );
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
              await import("../plugins/defaults/memory/pkb/pkb-reconcile.js");
            const { PKB_WORKSPACE_SCOPE } =
              await import("../plugins/defaults/memory/pkb/types.js");
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

    // `startMemoryJobsWorker` starts the in-process supervisor (which owns
    // the synchronous runner and stands down when an out-of-process worker is
    // live) and spawns the out-of-process worker at boot when
    // `memory.worker.enabled` is set. Shutdown stops whichever worker is
    // actually running — see shutdown-handlers.ts.
    log.info("Daemon startup: starting memory worker");
    registerMemoryJobHandlers();
    startMemoryJobsWorker();

    // Seed capability graph nodes (new memory graph system)
    try {
      const { seedCliGraphNodes } =
        await import("../plugins/defaults/memory/graph/capability-seed.js");
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
        await import("../plugins/defaults/memory/graph/bootstrap.js");
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
    await recoverStaleSchedules();
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

  startScheduler();

  // Fire-and-forget: Qdrant init and memory worker startup run concurrently
  // with the rest of daemon boot. Must run AFTER `startRuntimeHttpServer()`
  // so the analyze-deps singleton (populated inside `buildRouteTable()`) is
  // available before the memory worker can claim leftover
  // `conversation_analyze` jobs from a prior run. See the daemon-startup
  // ordering test in `assistant/src/daemon/__tests__/`.
  void initializeQdrantAndMemory().catch((err) =>
    log.warn({ err }, "Background Qdrant init failed"),
  );

  // Inject voice bridge deps so the relay pipeline can resolve attachments
  // once a call lands. Module-level state, so available even when the HTTP
  // server failed to bind.
  setVoiceBridgeDeps({
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
        const conversation = await getOrCreateConversation(conversationId);

        // Pointer turns are guardian-gated owner self-maintenance: elevate to
        // the internal guardian context and rehydrate history so a cold
        // (evicted) load doesn't filter guardian history to empty and ship a
        // cache-missing turn. `restoreTrustContext` undoes the elevation after
        // the turn. See pointer-conversation-trust.ts for the full rationale.
        const restoreTrustContext =
          await elevatePointerConversationToGuardian(conversation);

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
              throw new Error("Generated pointer text failed fact validation");
            }
          }
        } finally {
          // Restore tool availability so subsequent turns aren't affected.
          conversation.toolsDisabledDepth--;
          // Undo the temporary guardian elevation installed above.
          restoreTrustContext();
        }
      },
    );
    broadcastDaemonStatus();
  } catch (err) {
    log.warn(
      { err },
      "Failed to wire runtime HTTP server deps, continuing without them",
    );
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
  // server (providers were already initialized earlier in startup and tools
  // are resolved lazily at conversation creation time).
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

  // Download embedding runtime in background (non-blocking).
  // If download fails, local embeddings gracefully fall back to cloud backends.
  void (async () => {
    try {
      const { EmbeddingRuntimeManager } =
        await import("../persistence/embeddings/embedding-runtime-manager.js");
      const runtimeManager = new EmbeddingRuntimeManager();
      if (!runtimeManager.isReady()) {
        log.info("Downloading embedding runtime in background...");
        await runtimeManager.ensureInstalled();
        // Reset the sticky local-backend failure flag so auto mode retries
        // local embeddings without evicting a worker that may already be live.
        const { resetLocalEmbeddingFailureState } =
          await import("../persistence/embeddings/embedding-backend.js");
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

  startWorkspaceHeartbeatService();

  startHeartbeatService();

  installShutdownHandlers();

  // The critical startup await-chain has completed and the daemon can serve
  // requests, so latch readiness before logging "Daemon started". Any fatal
  // failure earlier in startup propagates out of runDaemon before this line,
  // so the latch is never set on a failed start.
  setStartupComplete();

  log.info(
    {
      durationMs: Date.now() - startupStartedAt,
      pid: process.pid,
    },
    "Daemon started",
  );
}
