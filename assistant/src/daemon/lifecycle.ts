import { config as dotenvConfig } from "dotenv";

import { reconcileCallsOnStartup } from "../calls/call-recovery.js";
import { TwilioVoiceProvider } from "../calls/twilio-provider.js";
import { expireInteractionBoundGuardianRequests } from "../channels/gateway-guardian-requests.js";
import { initFeatureFlagOverrides } from "../config/assistant-feature-flags.js";
import { setIngressPublicBaseUrl, validateEnv } from "../config/env.js";
import {
  hasPendingDefaultWorkspaceConfig,
  loadConfig,
  mergeDefaultWorkspaceConfig,
} from "../config/loader.js";
import { maybeDefaultSpeechToManaged } from "../config/managed-speech-defaults.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import { reconcileFlagGatedProfiles } from "../config/sync-gated-profiles.js";
import { startCes } from "../credential-execution/ces-runtime.js";
import { refreshManagedConnectionCache } from "../credential-execution/managed-catalog.js";
import { startHeartbeatService } from "../heartbeat/heartbeat-service.js";
import { backfillRelationshipStateIfMissing } from "../home/relationship-state-writer.js";
import { startCliIpcServer } from "../ipc/assistant-server.js";
import { startGatewayFlagListener } from "../ipc/gateway-flag-listener.js";
import { startMonitoring } from "../monitoring/control.js";
import { backfillManualTokenConnections } from "../oauth/manual-token-connection.js";
import { seedOAuthProviders } from "../oauth/seed-providers.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { startEmbeddingRuntimeManager } from "../persistence/embeddings/embedding-backend.js";
import { maybeEnqueueLexicalBackfillOnUpgrade } from "../persistence/job-handlers/message-lexical-backfill.js";
import { startConsentRefresh } from "../platform/consent-cache.js";
import { syncWorkspaceIdentityToPlatform } from "../platform/sync-identity.js";
import { ensurePromptFiles } from "../prompts/system-prompt.js";
import { runProviderConnectionsBackfill } from "../providers/inference/backfill.js";
import { initializeProviders } from "../providers/registry.js";
import {
  initAuthSigningKey,
  resolveSigningKey,
} from "../runtime/auth/token-service.js";
import {
  startRuntimeHttpServer,
  startRuntimeHttpServerBackgroundSweeps,
} from "../runtime/http-server.js";
import { warmLocalGuardianPrincipalCache } from "../runtime/local-actor-identity.js";
import { recoverInterruptedImport } from "../runtime/migrations/vbundle-streaming-importer.js";
import { publishConfigChanged } from "../runtime/sync/resource-sync-events.js";
import { recoverStaleSchedules } from "../schedule/schedule-recovery.js";
import { startScheduler } from "../schedule/scheduler.js";
import { getSubagentManager } from "../subagent/index.js";
import { startUsageTelemetryReporter } from "../telemetry/usage-telemetry-reporter.js";
import { getLogger, initLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getDotEnvPath,
  getWorkspaceDir,
} from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import { getWorkflowRunManager } from "../workflows/run-manager.js";
import { repairAdaptiveThinkingOnManagedProfiles } from "../workspace/adaptive-thinking-repair.js";
import { ensureCompleteCustomProfiles } from "../workspace/custom-profile-ensure.js";
import { ensureDefaultProvider } from "../workspace/default-provider-ensure.js";
import { startWorkspaceHeartbeatService } from "../workspace/heartbeat-service.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { runWorkspaceMigrations } from "../workspace/migrations/runner.js";
import { startAppSourceWatcher } from "./app-source-watcher.js";
import { startConfigWatcher } from "./config-watcher.js";
import { startConversationEvictor } from "./conversation-evictor.js";
import { writePid } from "./daemon-control.js";
import {
  setDbMigrating,
  setDbMigrationFailed,
  setDbReady,
  setStartupComplete,
} from "./daemon-readiness.js";
import { startDiskPressureGuardForLifecycle } from "./disk-pressure-guard-lifecycle.js";
import { startEventLoopWatchdog } from "./event-loop-watchdog.js";
import { initializePlugins } from "./external-plugins-bootstrap.js";
import { backfillSlackInjectionTemplates } from "./handlers/config-slack-channel.js";
import { installAssistantSymlink } from "./install-symlink.js";
import {
  MAX_RESUME_ATTEMPTS,
  reconcileInterruptedConversations,
  resumeInterruptedConversations,
} from "./interrupted-turn-reconciler.js";
import { startOrphanReaper } from "./orphan-reaper.js";
import { runProfilerSweep } from "./profiler-run-store.js";
import {
  initializeProvidersAndTools,
  registerMessagingProviders,
  registerWatcherProviders,
} from "./providers-setup.js";
import { installShutdownHandlers } from "./shutdown-handlers.js";
import { broadcastDaemonStatus } from "./status.js";

const log = getLogger("lifecycle");

function loadDotEnv(): void {
  dotenvConfig({ path: getDotEnvPath(), quiet: true });
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

  // Signal handlers install before any blocking startup work — a boot that
  // inherits a large WAL can spend minutes inside `initializeDb()`, and
  // without handlers a SIGTERM in that window is the default hard kill.
  // Handlers run a minimal exit path until `setStartupComplete()` below
  // switches them to the full graceful shutdown.
  installShutdownHandlers();

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

  setDbMigrating();

  // Materialize partial custom profiles BEFORE any transport binds: routes
  // are gated on DB readiness, not on the config-shaping steps further down,
  // so a fast-reconnecting client could otherwise resolve a turn against a
  // partial profile in the window between readiness and the post-overlay
  // ensure call below. Sync, DB-free, and idempotent. Skipped when an
  // unconsumed onboarding overlay is pending: the overlay can rewrite
  // llm.default later this boot, and baking against the pre-overlay default
  // would pin the wrong baseline — on that single boot (a fresh hatch, with
  // no established clients to race the window) the post-overlay pass owns
  // materialization; the overlay file is consumed on merge, so every
  // subsequent boot takes this early pass.
  if (!hasPendingDefaultWorkspaceConfig()) {
    try {
      ensureCompleteCustomProfiles(getWorkspaceDir());
    } catch (err) {
      log.warn(
        { err },
        "Pre-transport custom profile materialization failed — continuing startup",
      );
    }
  }

  // Start the runtime HTTP server early so /healthz answers ASAP. A bind
  // failure is non-fatal — the daemon falls back to IPC-only operation.
  await startRuntimeHttpServer();

  // Pre-populate feature flag overrides so subsequent sync
  // isAssistantFeatureFlagEnabled() calls have data. Fired non-blocking
  // so a slow or unreachable gateway doesn't delay daemon startup (the
  // IPC call has a 3s connect + 5s call timeout that would otherwise
  // stall the critical path).
  // After the async fetch resolves, reconcile flag-gated managed profiles
  // (OS Beta): `seedInferenceProfiles()` runs synchronously earlier in boot
  // before flags are available, so this lands the profile on the same boot once
  // the flag cache is populated. When this reconcile is the call that mutates
  // config (it raced ahead of the gateway flag listener), publish the config
  // invalidation so any client that already fetched `GET /v1/config` refreshes
  // its profile picker.
  // Profiles are reconciled only when flags actually loaded from the gateway:
  // a failed fetch leaves the cache unset and resolves `os-beta` to its
  // registry default `false`, which would remove the user's profile and reset
  // their selection.
  void initFeatureFlagOverrides()
    .then((loaded) => {
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
  // HTTP server and config-based subsystems still start so the process remains
  // reachable for diagnostics. The trivial /healthz probe stays green while
  // detailed health reports the migration state, and /readyz fails only when
  // migrations fail.
  //
  // The local `dbReady` and the module-level readiness latch intentionally
  // diverge on the migration-failure path: `dbReady` stays true to allow the
  // downstream best-effort seeding / workspace migrations, while readiness
  // records the failed migration state so /readyz returns 503.
  let dbReady = false;
  try {
    const { migrationsOk } = await initializeDb();
    dbReady = true;
    if (migrationsOk) {
      setDbReady(true);
      log.info("Daemon startup: DB initialized");
    } else {
      setDbMigrationFailed();
      log.error(
        "Daemon startup: DB opened but one or more migrations failed — /readyz will remain unready",
      );
    }
    // Migrations have settled (successfully or in the failed degraded mode),
    // so start the HTTP server's ORM-touching background sweeps. The server
    // binds earlier, before migrations run, so these are deferred to here to
    // avoid racing async migrations into a missing table. They run in degraded
    // mode too: the DB is open, and guardian approval/action expiry is
    // security-relevant maintenance on tables that predate whatever migration
    // failed. The retry sweep skips its cycles while readiness is unready (see
    // startBackgroundSweeps) so refused replays can't burn dead-letter budget.
    startRuntimeHttpServerBackgroundSweeps();
  } catch (err) {
    // Sweeps intentionally NOT started on this path: initializeDb() threw, so
    // the DB never opened and every sweep cycle would just error against it.
    setDbMigrationFailed(err);
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

    // Expire stale pending guardian requests left over from before this
    // process started. Daemon-keyed by design: interaction-bound kinds die
    // with THIS process's in-memory pendingInteractions map, so the daemon
    // triggers the gateway op at its own boot — the gateway never runs it
    // on its own restart. Two categories are cleaned up:
    //
    // 1. Interaction-bound kinds (tool_approval, pending_question) — their
    //    in-memory pending-interaction session references are gone, so they
    //    can never be completed.
    // 2. Any pending request whose expiresAt has already passed — persistent
    //    kinds (access_request, tool_grant_request) that expired while the
    //    daemon was stopped are transitioned so dedup logic doesn't return
    //    stale rows.
    //
    // Startup must not block on the gateway (daemon startup philosophy):
    // on failure the periodic sweep still reaps time-expired rows, and
    // decide paths reject interaction-bound strays via pendingInteractions.
    try {
      const expiredCount = await expireInteractionBoundGuardianRequests();
      if (expiredCount > 0) {
        log.info(
          { event: "startup_expired_stale_requests", expiredCount },
          `Expired ${expiredCount} stale guardian request(s) from previous process`,
        );
      }
    } catch (err) {
      log.warn(
        { err },
        "Startup guardian-request expiry failed — continuing in degraded mode",
      );
    }

    try {
      const twilioProvider = new TwilioVoiceProvider();
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

  // Runs on every boot (unlike the repair above, not gated on hadOverlay) so
  // it also covers hand-deleted fields and configs restored from backups
  // that predate the field. See workspace/default-provider-ensure.ts for the
  // full rationale.
  try {
    await ensureDefaultProvider(getWorkspaceDir());
    log.info("Default provider ensure pass complete");
  } catch (err) {
    log.warn(
      { err },
      "Default provider ensure pass failed — continuing startup",
    );
  }

  // Runs on every boot, after the overlay merge and profile seeding and
  // before the first loadConfig(), so no resolution ever sees a partial
  // custom profile. See workspace/custom-profile-ensure.ts for why this is
  // an ensure pass rather than a workspace migration.
  try {
    ensureCompleteCustomProfiles(getWorkspaceDir());
    log.info("Custom profile materialization ensure pass complete");
  } catch (err) {
    log.warn(
      { err },
      "Custom profile materialization ensure pass failed — continuing startup",
    );
  }

  log.info("Daemon startup: loading config");
  const config = loadConfig();

  // Reconcile conversations left mid-turn by the previous shutdown. Their
  // `processing_started_at` is still set even though the in-memory agent loop
  // that owned the turn is gone. Stale flags are always cleared so no
  // conversation stays visibly stuck "processing"; when
  // `conversations.resumeProcessingOnStartup` is enabled the reconciler also
  // selects conversations to resume once startup completes (the wakes need
  // providers/CES, so they are kicked off next to `setStartupComplete()`).
  let conversationsToResume: string[] = [];
  if (dbReady) {
    try {
      const reconciled = reconcileInterruptedConversations(
        config.conversations.resumeProcessingOnStartup,
      );
      conversationsToResume = reconciled.resume;
      if (reconciled.cleared > 0) {
        log.info(
          {
            count: reconciled.cleared,
            resuming: reconciled.resume.length,
          },
          "Cleared stale conversation processing flags from previous process",
        );
      }
      if (reconciled.capped.length > 0) {
        log.warn(
          {
            conversationIds: reconciled.capped,
            maxAttempts: MAX_RESUME_ATTEMPTS,
          },
          "Left interrupted conversations un-resumed after repeated interruptions",
        );
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to reconcile interrupted conversations — continuing startup",
      );
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

  // Refresh the consent cache regardless of dev mode so record-time telemetry
  // writes (gated on getCachedShareAnalytics()) work in dev too. The usage
  // telemetry reporter re-checks share_analytics on every flush, so dev still
  // never sends telemetry to the platform. Fire-and-forget: startConsentRefresh()
  // runs an immediate non-blocking refresh, so the startup hot path is never
  // blocked.
  startConsentRefresh();

  // Bring up the daemon's CES connection (process + handshake + reconnect
  // wiring). Blocks up to a 20s timeout so credential reads route through CES
  // before provider init; non-fatal — falls back to the direct credential store
  // on failure. The sidecar accepts exactly one bootstrap connection, so this
  // happens at the process level.
  await startCes(config);

  // Speech-mode defaulting follows the platform connection (logged in ⇒
  // managed, explicit modes always win). Placed after startCes so the
  // credential store — where the platform connection lives in Docker/managed
  // mode — is readable; runs every boot so installs that connected before this
  // defaulting existed converge. Detached — must not block startup.
  void maybeDefaultSpeechToManaged();

  // Bring up the plugin layer: install the runtime bridge, register the
  // first-party defaults, load user plugins, and run every plugin's
  // `init()`. Ordering is load-bearing (defaults register ahead of user
  // plugins so they compose innermost) and plugin failures are contained so
  // they can't block daemon startup. The memory plugin's `init` hook registers
  // the job handlers (its own plus the host's non-plugin domain handlers) and
  // starts the jobs worker here.
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

  // Rehydrate subagent records persisted by a prior run: load terminal
  // subagents so `subagent_read`/`getState` keep working post-restart, and mark
  // any that were still in flight when the process died as `interrupted` (we do
  // not auto-resume). Mirrors the workflow-run reconciliation above; never
  // blocks startup, and runs before the scheduler so no new spawn races it.
  try {
    const { rehydrated, interrupted } = getSubagentManager().rehydrateFromDb();
    if (rehydrated > 0) {
      log.info(
        { rehydrated, interrupted },
        "Rehydrated subagent records from a prior run",
      );
    }
  } catch (err) {
    log.error({ err }, "Subagent rehydration failed — continuing startup");
  }

  startScheduler();

  // One-time, self-healing backfill of existing messages into the Qdrant
  // lexical index (`messages_lexical`) on upgrade, so message-content search
  // never opens onto an empty index. Enqueue-only and checkpoint-guarded — the
  // indexing runs off the event loop via the background job worker; see the
  // function's docstring for the guards and the deliberate exception it makes
  // to the "no work at daemon startup" rule.
  maybeEnqueueLexicalBackfillOnUpgrade();

  // Spawn the resource monitor as a child of the daemon when enabled, off the
  // main event loop.
  startMonitoring();

  // The runtime HTTP server is up; broadcast the fresh daemon status so
  // connected clients pick up the transition.
  broadcastDaemonStatus();

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
  // Best-effort and self-contained: every step swallows its own errors, so a
  // failure never affects startup.
  installAssistantSymlink();

  void startEmbeddingRuntimeManager();

  startWorkspaceHeartbeatService();

  startHeartbeatService();

  // The critical startup await-chain has completed and the daemon can serve
  // requests, so latch readiness before logging "Daemon started". Any fatal
  // failure earlier in startup propagates out of runDaemon before this line,
  // so the latch is never set on a failed start. The latch also switches the
  // signal handlers installed at the top of startup from their minimal
  // early-exit mode to the full graceful shutdown.
  setStartupComplete();

  // Resume conversations whose turn the previous process interrupted. Kicked
  // off only now — the wakes run full agent-loop turns and need providers and
  // CES, which the startup sequence above just brought up. Fire-and-forget:
  // the resumes run sequentially in the background while the daemon serves
  // requests; per-conversation failures are logged inside.
  if (conversationsToResume.length > 0) {
    log.info(
      { count: conversationsToResume.length },
      "Resuming conversations interrupted by the previous process",
    );
    void resumeInterruptedConversations(conversationsToResume);
  }

  log.info(
    {
      durationMs: Date.now() - startupStartedAt,
      pid: process.pid,
    },
    "Daemon started",
  );
}
