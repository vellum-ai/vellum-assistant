process.title = "vellum-gateway";

import { randomBytes } from "node:crypto";

import {
  TWILIO_MEDIA_STREAM_WEBHOOK_PATH,
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@vellumai/service-contracts/twilio-ingress";

import { AuthRateLimiter } from "./auth-rate-limiter.js";
import {
  loadOrCreateSigningKey,
  initSigningKey,
} from "./auth/token-service.js";
import { validateEdgeToken, mintServiceToken } from "./auth/token-exchange.js";
import { findGuardianForChannelActor } from "./auth/guardian-bootstrap.js";
import { AuthFallbackReporter } from "./auth-fallback-reporter.js";
import { loopbackFallbackCountTracker } from "./http/middleware/auth.js";
import { ConfigFileCache } from "./config-file-cache.js";
import { ConfigFileWatcher } from "./config-file-watcher.js";
import { FeatureFlagWatcher } from "./feature-flag-watcher.js";
import { readPersistedFeatureFlags } from "./feature-flag-store.js";
import { readRemoteFeatureFlags } from "./feature-flag-remote-store.js";
import { RemoteFeatureFlagSync } from "./remote-feature-flag-sync.js";
import { loadConfig } from "./config.js";
import { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";
import {
  CredentialWatcher,
  type CredentialChangeEvent,
} from "./credential-watcher.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import { hasRemoteWebRefreshCookie } from "./http/browser-auth-cookies.js";
import { handleGuardianRefresh } from "./http/routes/guardian-refresh.js";

import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { createAudioProxyHandler } from "./http/routes/audio-proxy.js";
import { createTwilioVoiceWebhookHandler } from "./http/routes/twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./http/routes/twilio-status-webhook.js";
import { createTwilioVoiceVerifyCallbackHandler } from "./http/routes/twilio-voice-verify-callback.js";
import {
  createTwilioMediaWebsocketHandler,
  getMediaStreamWebsocketHandlers,
  type MediaStreamSocketData,
} from "./http/routes/twilio-media-websocket.js";
import {
  createSttStreamWebsocketHandler,
  getSttStreamWebsocketHandlers,
  type SttStreamSocketData,
} from "./http/routes/stt-stream-websocket.js";
import {
  createLiveVoiceWebsocketHandler,
  getLiveVoiceWebsocketHandlers,
  type LiveVoiceSocketData,
} from "./http/routes/live-voice-websocket.js";
import { createWhatsAppWebhookHandler } from "./http/routes/whatsapp-webhook.js";

import { createEmailWebhookHandler } from "./http/routes/email-webhook.js";
import { createGuardianChannelHandler } from "./http/routes/guardian-channel-create.js";
import { createInboundRegisterHandler } from "./http/routes/inbound-register.js";
import { createMailgunWebhookHandler } from "./http/routes/mailgun-webhook.js";
import { createResendWebhookHandler } from "./http/routes/resend-webhook.js";

import { createOAuthCallbackHandler } from "./http/routes/oauth-callback.js";
import {
  createFeatureFlagsGetHandler,
  createFeatureFlagsPatchHandler,
} from "./http/routes/feature-flags.js";
import {
  createGlobalThresholdGetHandler,
  createGlobalThresholdPutHandler,
  createConversationThresholdGetHandler,
  createConversationThresholdPutHandler,
  createConversationThresholdDeleteHandler,
} from "./http/routes/auto-approve-thresholds.js";
import { createChannelVerificationSessionProxyHandler } from "./http/routes/channel-verification-session-proxy.js";
import { createTelegramControlPlaneProxyHandler } from "./http/routes/telegram-control-plane-proxy.js";
import { createTwilioControlPlaneProxyHandler } from "./http/routes/twilio-control-plane-proxy.js";
import { createVercelControlPlaneProxyHandler } from "./http/routes/vercel-control-plane-proxy.js";
import { createContactsControlPlaneProxyHandler } from "./http/routes/contacts-control-plane-proxy.js";
import { handleContactPromptSubmit } from "./http/routes/contact-prompt.js";
import {
  handleListDevices,
  handleRevokeDevice,
} from "./http/routes/devices.js";
import { handlePair } from "./http/routes/pair.js";
import { handleCredentialEntryPage } from "./http/routes/credential-entry-page.js";
import {
  handleCredentialRequestPeek,
  handleCredentialRequestSubmit,
} from "./http/routes/credential-requests.js";
import { handleCreateRemoteWebPairingChallenge } from "./http/routes/remote-web-pairing-challenge.js";
import { handleRemoteWebPairingToken } from "./http/routes/remote-web-pairing-token.js";
import { handleVerifyRemoteWebPairingChallenge } from "./http/routes/remote-web-pairing-verification.js";
import { createSlackControlPlaneProxyHandler } from "./http/routes/slack-control-plane-proxy.js";
import { createOAuthAppsProxyHandler } from "./http/routes/oauth-apps-proxy.js";
import { createOAuthProvidersProxyHandler } from "./http/routes/oauth-providers-proxy.js";
import { createChannelReadinessProxyHandler } from "./http/routes/channel-readiness-proxy.js";
import { createPsHandler } from "./http/routes/ps.js";
import { createRuntimeHealthProxyHandler } from "./http/routes/runtime-health-proxy.js";
import { createUpgradeBroadcastProxyHandler } from "./http/routes/upgrade-broadcast-proxy.js";
import {
  createMigrationExportProxyHandler,
  createMigrationExportToGcsProxyHandler,
  createMigrationImportFromGcsProxyHandler,
  createMigrationImportProxyHandler,
  createMigrationImportStatusProxyHandler,
  createMigrationJobStatusProxyHandler,
} from "./http/routes/migration-proxy.js";
import { createMigrationRollbackProxyHandler } from "./http/routes/migration-rollback-proxy.js";
import {
  createListBackupsHandler,
  createBackupSnapshotHandler,
} from "./backup/backup-routes.js";
import { startBackupWorker } from "./backup/backup-worker.js";
import { createWorkspaceCommitProxyHandler } from "./http/routes/workspace-commit-proxy.js";
import { createBrainGraphProxyHandler } from "./http/routes/brain-graph-proxy.js";
import { createLogExportHandler } from "./http/routes/log-export.js";
import { createLogTailHandler } from "./http/routes/log-tail.js";
import {
  createAgentCardHandler,
  A2A_AGENT_CARD_PATH,
} from "./http/routes/a2a-routes.js";
import {
  createTrustRulesListHandler,
  createTrustRulesCreateHandler,
  createTrustRulesUpdateHandler,
  createTrustRulesDeleteHandler,
  createTrustRulesResetHandler,
  createTrustRulesSuggestHandler,
} from "./http/routes/trust-rules.js";
import { initTrustRuleCache } from "./risk/trust-rule-cache.js";
import { initAdmissionPolicyCache } from "./risk/admission-policy-cache.js";
import {
  createChannelAdmissionPolicyListHandler,
  createChannelAdmissionPolicySetHandler,
  createChannelAdmissionPolicyDeleteHandler,
} from "./http/routes/channel-admission-policy.js";
import {
  createChannelPermissionOverridesListHandler,
  createChannelPermissionOverrideSetHandler,
  createChannelPermissionOverrideDeleteHandler,
  createChannelPermissionResolveHandler,
} from "./http/routes/channel-permission-overrides.js";
import { getLogger, initLogger } from "./logger.js";
import { getPlatformBaseUrl } from "./platform-url.js";
import {
  AttachmentValidationError,
  CircuitBreakerOpenError,
  uploadAttachment,
} from "./runtime/client.js";
import { buildSchema } from "./schema.js";
import {
  createSlackSocketModeClient,
  type SlackSocketModeClient,
} from "./slack/socket-mode.js";
import { downloadSlackFile } from "./slack/download.js";
import { slackBotContactNote } from "./slack/normalize.js";
import { handleInbound } from "./handlers/handle-inbound.js";
import { upsertContactChannel } from "./verification/contact-helpers.js";
import { checkAuthRateLimit } from "./http/middleware/rate-limit.js";
import { logAuthBypassState } from "./http/middleware/auth.js";
import {
  resolveExtensionOrigin,
  handleExtensionPreflight,
  withExtensionCorsHeaders,
  resolveWebviewOrigin,
  handlePreflight,
  withCorsHeaders,
} from "./http/middleware/cors.js";
import { handleCreateToken } from "./http/routes/auth-token.js";
import {
  createRouter,
  type RouteDefinition,
  type GetClientIp,
} from "./http/router.js";
import { SleepWakeDetector } from "./sleep-wake-detector.js";
import { callTelegramApi } from "./telegram/api.js";
import { fetchImpl } from "./fetch.js";
import { arePlatformFeaturesEnabled } from "./feature-flag-resolver.js";
import { isNewCommand, handleNewCommand } from "./webhook-pipeline.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";
import { registerEmailCallbackRoute } from "./email/register-callback.js";
import { hasTwilioSetupStarted } from "./twilio/setup-state.js";
import { syncConfiguredTwilioPhoneNumberWebhooks } from "./twilio/webhook-sync.js";
import {
  isOnlyVelayPublicBaseUrlChange,
  shouldSyncTwilioPhoneWebhooksAfterConfigChange,
} from "./twilio/webhook-sync-trigger.js";
import { GatewayIpcServer } from "./ipc/server.js";
import { contactRoutes } from "./ipc/contact-handlers.js";
import { inviteRoutes } from "./ipc/invite-handlers.js";
import { verificationSessionRoutes } from "./ipc/verification-session-handlers.js";
import { featureFlagRoutes } from "./ipc/feature-flag-handlers.js";
import { admissionPolicyRoutes } from "./ipc/admission-policy-handlers.js";
import { channelPermissionRoutes } from "./ipc/channel-permission-handlers.js";
import { trustVerdictRoutes } from "./ipc/trust-verdict-handlers.js";
import { guardianDeliveryRoutes } from "./ipc/guardian-delivery-handlers.js";
import { createLogTailRoutes } from "./ipc/log-tail-handlers.js";
import { createCredentialRequestIpcRoutes } from "./ipc/credential-request-handlers.js";
import { slackThreadRoutes } from "./ipc/slack-thread-handlers.js";
import { thresholdRoutes } from "./ipc/threshold-handlers.js";
import { trustRulesRoutes } from "./ipc/trust-rules-handlers.js";

import { riskClassificationRoutes } from "./ipc/risk-classification-handlers.js";
import { createVelayRoutes } from "./ipc/velay-handlers.js";
import { refreshRouteSchema } from "./ipc/route-schema-cache.js";
import { AvatarChannelSyncer } from "./avatar-sync/avatar-channel-syncer.js";
import { AvatarSyncWatcher } from "./avatar-sync/avatar-sync-watcher.js";
import { SlackAvatarSyncer } from "./avatar-sync/slack-avatar-syncer.js";
import { initGatewayDb } from "./db/connection.js";
import { runPostAssistantReady } from "./post-assistant-ready.js";
import {
  clearManagedPublicBaseUrl,
  createVelayTunnelClient,
  enablePublicIngress,
} from "./velay/client.js";
import { VERSION_HEADER_NAME, VERSION_HEADER_VALUE } from "./version.js";

const log = getLogger("main");

function generateTraceId(): string {
  return randomBytes(8).toString("hex");
}

let draining = false;
let postAssistantReadyComplete = false;

/**
 * Detect which services had credential changes and log them.
 * Returns the set of service names that changed so callers can
 * trigger side effects (e.g. Telegram webhook reconciliation,
 * Slack socket restart).
 */
const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  telegram: "Telegram",
  twilio: "Twilio",
  whatsapp: "WhatsApp",
  slack_channel: "Slack channel",
};

function detectCredentialChanges(
  event: CredentialChangeEvent,
  logTarget: { info: (msg: string) => void },
): Set<string> {
  const changed = new Set<string>();
  for (const service of event.changedServices) {
    const displayName = SERVICE_DISPLAY_NAMES[service] ?? service;
    const creds = event.credentials.get(service);
    logTarget.info(
      creds
        ? `${displayName} credentials loaded from credential vault`
        : `${displayName} credentials cleared`,
    );
    changed.add(service);
  }
  return changed;
}

// Shared rate limiter for auth failures and unauthenticated endpoints
const authRateLimiter = new AuthRateLimiter();

function isMediaStreamSocketData(data: unknown): data is MediaStreamSocketData {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { wsType?: unknown }).wsType === "twilio-media-stream"
  );
}

function isSttStreamSocketData(data: unknown): data is SttStreamSocketData {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { wsType?: unknown }).wsType === "stt-stream"
  );
}

function isLiveVoiceSocketData(data: unknown): data is LiveVoiceSocketData {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { wsType?: unknown }).wsType === "live-voice"
  );
}

/** Log-safe socket-type discriminant for unknown-socket diagnostics. */
function extractWsType(data: unknown): unknown {
  return data && typeof data === "object"
    ? (data as { wsType?: unknown }).wsType
    : undefined;
}

function closeUnknownSocket(
  ws: { data: unknown; close(code?: number, reason?: string): void },
  event: "open" | "message",
): void {
  log.error(
    { event, wsType: extractWsType(ws.data) },
    "WebSocket event for unknown socket type — closing",
  );
  ws.close(1011, "Unknown socket type");
}

function getClientIp(
  req: Request,
  server: ReturnType<typeof Bun.serve>,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }
  }
  const addr = server.requestIP(req);
  return addr?.address ?? "unknown";
}

async function main() {
  const config = loadConfig();
  initLogger(config.logFile);

  log.info("Starting Vellum Gateway...");

  // Initialize the JWT signing key shared with the daemon.
  // This must happen before any request handling.
  const signingKey = loadOrCreateSigningKey();
  initSigningKey(signingKey);
  log.info("JWT signing key initialized");

  await initGatewayDb();
  initTrustRuleCache();
  initAdmissionPolicyCache();

  // ── TTL caches ──
  // Instantiate caches for credential and config file reads.
  // Handlers read dynamic credentials and config.json values from these
  // caches at call time, with automatic TTL refresh.
  const credentialCache = new CredentialCache();
  const configFileCache = new ConfigFileCache();
  const velayTunnelClient = createVelayTunnelClient(config, {
    credentials: credentialCache,
    configFile: configFileCache,
  });

  // ── Avatar sync ──
  const avatarChannelSyncer = new AvatarChannelSyncer();
  const avatarSyncWatcher = new AvatarSyncWatcher(avatarChannelSyncer);

  // ── Integration readiness flags ──
  // Track whether each integration has valid credentials so route
  // preconditions can gate requests synchronously. Updated by the
  // credential watcher callback whenever credentials change.
  let telegramReady = false;
  let whatsappReady = false;
  let slackReady = false;
  let vellumReady = false;
  let velayStartRequested = false;

  function maybeStartVelayTunnelForTwilio(
    reason: string,
    twilioCredentials?: Record<string, string> | null,
  ): boolean {
    if (velayStartRequested || !velayTunnelClient) {
      return velayStartRequested;
    }
    if (!hasTwilioSetupStarted(configFileCache, twilioCredentials)) {
      return false;
    }

    velayStartRequested = true;
    log.info({ reason }, "Starting Velay tunnel after Twilio setup detected");
    velayTunnelClient.start();
    return true;
  }

  /**
   * Whether web live voice is enabled for this assistant. The browser only
   * opens the live-voice channel when the `voice-mode` assistant flag is on, so
   * we mirror that signal here (persisted local override OR platform-synced
   * remote value). Used to bring up the Velay tunnel, which is the browser's
   * ingress for live voice.
   */
  function isLiveVoiceEnabled(): boolean {
    return (
      readPersistedFeatureFlags()["voice-mode"] === true ||
      readRemoteFeatureFlags()["voice-mode"] === true
    );
  }

  /**
   * Start the Velay tunnel when web live voice is enabled.
   *
   * Velay is the browser's ingress for the live-voice WebSocket, but the tunnel
   * was historically only started for Twilio (see
   * {@link maybeStartVelayTunnelForTwilio}). Without this, a `voice-mode`
   * assistant with no Twilio setup never registers a Velay tunnel, so the
   * browser's `/v1/live-voice` upgrade fails with "assistant tunnel is not
   * connected". Shares the `velayStartRequested` latch with the Twilio path —
   * one tunnel serves both — and `velayTunnelClient.start()` is idempotent.
   */
  function maybeStartVelayTunnelForLiveVoice(reason: string): boolean {
    if (velayStartRequested || !velayTunnelClient) {
      return velayStartRequested;
    }
    if (!isLiveVoiceEnabled()) {
      return false;
    }

    velayStartRequested = true;
    log.info({ reason }, "Starting Velay tunnel after live voice enabled");
    velayTunnelClient.start();
    return true;
  }

  /**
   * Start the Velay tunnel when a credential link is minted. Unlike the Twilio
   * and live-voice paths this has no precondition: creating a one-time
   * credential link is itself the request to expose public ingress, and the
   * tunnel is the browser's route to the credential-entry page. Shares the
   * `velayStartRequested` latch — one tunnel serves every ingress consumer —
   * and `velayTunnelClient.start()` is idempotent.
   */
  function maybeStartVelayTunnelForCredentialLink(reason: string): boolean {
    if (velayStartRequested || !velayTunnelClient) {
      return velayStartRequested;
    }
    velayStartRequested = true;
    log.info({ reason }, "Starting Velay tunnel after credential link minted");
    velayTunnelClient.start();
    return true;
  }

  /**
   * Make public ingress live for a freshly minted credential link: enable it
   * when explicitly disabled (only an explicit `false` — a default `undefined`
   * already means enabled on platform) and start the Velay tunnel so the link
   * is actually reachable.
   */
  async function ensurePublicIngressLiveForCredentialLink(): Promise<void> {
    if (
      configFileCache.getBoolean("ingress", "enabled", { force: true }) ===
      false
    ) {
      await enablePublicIngress(configFileCache);
      log.info("Auto-enabled public ingress for credential link creation");
    }
    maybeStartVelayTunnelForCredentialLink("credential link minted");
  }

  async function readTwilioCredentialsForVelayStartup(): Promise<Record<
    string,
    string
  > | null> {
    try {
      const [accountSid, authToken] = await Promise.all([
        credentialCache.get(credentialKey("twilio", "account_sid")),
        credentialCache.get(credentialKey("twilio", "auth_token")),
      ]);
      if (!accountSid?.trim() || !authToken?.trim()) {
        return null;
      }
      return { account_sid: accountSid, auth_token: authToken };
    } catch (err) {
      log.warn(
        { err },
        "Failed to read Twilio credentials before Velay startup gate",
      );
      return null;
    }
  }

  const twilioValidationCaches = {
    credentials: credentialCache,
    configFile: configFileCache,
  };

  const { handler: handleTelegramWebhook, dedupCache: telegramDedupCache } =
    createTelegramWebhookHandler(config, {
      credentials: credentialCache,
      configFile: configFileCache,
    });
  const isTelegramConfigured = () => telegramReady;
  const isWhatsAppConfigured = () => whatsappReady;

  const handleTwilioVoiceWebhook = createTwilioVoiceWebhookHandler(
    config,
    twilioValidationCaches,
  );
  const handleTwilioStatusWebhook = createTwilioStatusWebhookHandler(
    config,
    twilioValidationCaches,
  );
  const handleTwilioVoiceVerifyCallback =
    createTwilioVoiceVerifyCallbackHandler(config, twilioValidationCaches);
  const handleTwilioMediaWs = createTwilioMediaWebsocketHandler(config, {
    configFile: configFileCache,
  });
  const handleSttStreamWs = createSttStreamWebsocketHandler(config);
  const handleLiveVoiceWs = createLiveVoiceWebsocketHandler(config);
  const twilioMediaStreamWebsocketHandlers = getMediaStreamWebsocketHandlers();
  const sttStreamWebsocketHandlers = getSttStreamWebsocketHandlers();
  const liveVoiceWebsocketHandlers = getLiveVoiceWebsocketHandlers();
  const { handler: handleWhatsAppWebhook, dedupCache: whatsappDedupCache } =
    createWhatsAppWebhookHandler(config, {
      credentials: credentialCache,
      configFile: configFileCache,
    });
  const { handler: handleEmailWebhook, dedupCache: emailDedupCache } =
    createEmailWebhookHandler(config, {
      credentials: credentialCache,
      configFile: configFileCache,
    });
  const { handler: handleResendWebhook } = createResendWebhookHandler(config, {
    credentials: credentialCache,
    configFile: configFileCache,
  });
  const { handler: handleMailgunWebhook } = createMailgunWebhookHandler(
    config,
    {
      credentials: credentialCache,
      configFile: configFileCache,
    },
  );
  const handleInboundRegister = createInboundRegisterHandler(
    config,
    credentialCache,
  );
  const handleGuardianChannelCreate = createGuardianChannelHandler();
  const handleOAuthCallback = createOAuthCallbackHandler(config);
  const channelVerificationSessionProxy =
    createChannelVerificationSessionProxyHandler(config);
  const telegramControlPlaneProxy =
    createTelegramControlPlaneProxyHandler(config);
  const vercelControlPlaneProxy = createVercelControlPlaneProxyHandler(config);
  const contactsControlPlaneProxy =
    createContactsControlPlaneProxyHandler(config);
  const twilioControlPlaneProxy = createTwilioControlPlaneProxyHandler(config);
  const slackControlPlaneProxy = createSlackControlPlaneProxyHandler(config);
  const oauthAppsProxy = createOAuthAppsProxyHandler(config);
  const oauthProvidersProxy = createOAuthProvidersProxyHandler(config);
  const channelReadinessProxy = createChannelReadinessProxyHandler(config);
  const psHandler = createPsHandler(config);
  const runtimeHealthProxy = createRuntimeHealthProxyHandler(config);
  const upgradeBroadcastProxy = createUpgradeBroadcastProxyHandler(config);
  const migrationExportProxy = createMigrationExportProxyHandler(config);
  const migrationImportProxy = createMigrationImportProxyHandler(config);
  const migrationImportStatusProxy =
    createMigrationImportStatusProxyHandler(config);
  const migrationExportToGcsProxy =
    createMigrationExportToGcsProxyHandler(config);
  const migrationImportFromGcsProxy =
    createMigrationImportFromGcsProxyHandler(config);
  const migrationJobStatusProxy = createMigrationJobStatusProxyHandler(config);
  const migrationRollbackProxy = createMigrationRollbackProxyHandler(config);
  const workspaceCommitProxy = createWorkspaceCommitProxyHandler(config);
  const brainGraphProxy = createBrainGraphProxyHandler(config);
  const handleLogExport = createLogExportHandler(config);
  const handleLogTail = createLogTailHandler(config);
  const handleFeatureFlagsGet = createFeatureFlagsGetHandler();
  // Assigned once `ipcServer` exists (see `emitFlagChanged` below). Passing a
  // thunk lets the PATCH handler push flag changes to connected clients the
  // moment a write commits, rather than waiting on the FeatureFlagWatcher.
  let emitFlagChanged: () => void = () => {};
  const handleFeatureFlagsPatch = createFeatureFlagsPatchHandler(() =>
    emitFlagChanged(),
  );
  const handleGlobalThresholdGet = createGlobalThresholdGetHandler();
  const handleGlobalThresholdPut = createGlobalThresholdPutHandler();
  const handleConversationThresholdGet =
    createConversationThresholdGetHandler();
  const handleConversationThresholdPut =
    createConversationThresholdPutHandler();
  const handleConversationThresholdDelete =
    createConversationThresholdDeleteHandler();
  const handleTrustRulesList = createTrustRulesListHandler();
  const handleTrustRulesCreate = createTrustRulesCreateHandler();
  const handleTrustRulesUpdate = createTrustRulesUpdateHandler();
  const handleTrustRulesDelete = createTrustRulesDeleteHandler();
  const handleTrustRulesReset = createTrustRulesResetHandler();
  const handleTrustRulesSuggest = createTrustRulesSuggestHandler();
  const handleChannelAdmissionPolicyList =
    createChannelAdmissionPolicyListHandler();
  const handleChannelAdmissionPolicySet =
    createChannelAdmissionPolicySetHandler();
  const handleChannelAdmissionPolicyDelete =
    createChannelAdmissionPolicyDeleteHandler();
  const handleChannelPermissionOverridesList =
    createChannelPermissionOverridesListHandler();
  const handleChannelPermissionOverrideSet =
    createChannelPermissionOverrideSetHandler();
  const handleChannelPermissionOverrideDelete =
    createChannelPermissionOverrideDeleteHandler();
  const handleChannelPermissionResolve =
    createChannelPermissionResolveHandler();

  const handleAgentCard = createAgentCardHandler(
    config,
    configFileCache,
    credentialCache,
  );

  const audioProxy = createAudioProxyHandler(config);

  const backupDeps = {
    assistantRuntimeBaseUrl: config.assistantRuntimeBaseUrl,
  };
  const handleListBackups = createListBackupsHandler(backupDeps);
  const handleCreateBackup = createBackupSnapshotHandler(backupDeps);

  const handleRuntimeProxy = createRuntimeProxyHandler(config);

  // Helper to reject when an integration isn't configured
  const requireConfigured = (
    check: () => boolean,
    name: string,
  ): (() => Response | null) => {
    return () => {
      if (!check()) {
        log.warn(
          { integration: name },
          `${name} integration not configured — rejecting request with 503`,
        );
        return Response.json(
          { error: `${name} integration not configured` },
          { status: 503 },
        );
      }
      return null;
    };
  };

  const requireTelegram = requireConfigured(isTelegramConfigured, "Telegram");
  const requireWhatsApp = requireConfigured(isWhatsAppConfigured, "WhatsApp");

  // ── Route table ──
  // Routes are matched top-to-bottom. The first match wins.
  // Auth middleware is applied declaratively per route — no manual
  // requireEdgeAuth/wrapWithAuthFailureTracking calls needed.
  const routes: RouteDefinition[] = [
    // ── A2A agent card discovery (read-only, unauthenticated per spec) ──
    {
      path: A2A_AGENT_CARD_PATH,
      method: "GET",
      handler: (req) => handleAgentCard(req),
    },

    // ── Webhooks (unauthenticated, validated by provider-specific mechanisms) ──
    {
      path: "/webhooks/telegram",
      precondition: requireTelegram,
      handler: (req) => handleTelegramWebhook(req),
    },
    {
      path: TWILIO_VOICE_WEBHOOK_PATH,
      handler: (req) => handleTwilioVoiceWebhook(req),
    },
    {
      path: TWILIO_STATUS_WEBHOOK_PATH,
      handler: (req) => handleTwilioStatusWebhook(req),
    },
    {
      path: "/webhooks/twilio/voice-verify",
      handler: (req) => handleTwilioVoiceVerifyCallback(req),
    },
    {
      path: "/webhooks/whatsapp",
      precondition: requireWhatsApp,
      handler: (req) => handleWhatsAppWebhook(req),
    },
    {
      path: "/webhooks/email",
      handler: (req) => handleEmailWebhook(req),
    },
    {
      path: "/webhooks/resend",
      handler: (req) => handleResendWebhook(req),
    },
    {
      path: "/webhooks/mailgun",
      handler: (req) => handleMailgunWebhook(req),
    },

    // ── BYO provider registration (auto-verify guardian email) ──
    {
      path: "/inbound/register",
      method: "POST",
      auth: "edge-scoped",
      scope: "internal.write",
      handler: (req) => handleInboundRegister(req),
    },

    // ── Guardian channel creation (platform auto-verify) ──
    {
      path: "/v1/contacts/guardian/channel",
      method: "POST",
      auth: "edge-guardian",
      handler: (req) => handleGuardianChannelCreate(req),
    },

    // ── Audio serving (unauthenticated — Twilio fetches these URLs directly) ──
    {
      path: /^\/v1\/audio\/([^/]+)$/,
      method: "GET",
      handler: (_req, params) => audioProxy.handleGetAudio(_req, params[0]),
    },
    {
      path: "/webhooks/oauth/callback",
      method: "GET",
      auth: "track-failures",
      trackFailureStatuses: [400],
      handler: (req) => handleOAuthCallback(req),
    },

    // ── Runtime health ──
    {
      path: "/v1/health",
      method: "GET",
      auth: "edge",
      handler: (req) => runtimeHealthProxy.handleRuntimeHealth(req),
    },
    {
      path: "/v1/healthz",
      method: "GET",
      auth: "edge",
      handler: (req) => runtimeHealthProxy.handleRuntimeHealth(req),
    },

    // ── Process status ──
    {
      path: "/v1/ps",
      method: "GET",
      auth: "edge",
      handler: () => psHandler.handlePs(),
    },

    // ── Brain graph ──
    {
      path: "/v1/brain-graph",
      method: "GET",
      auth: "edge",
      handler: (req) => brainGraphProxy.handleBrainGraph(req),
    },
    {
      path: "/v1/brain-graph-ui",
      method: "GET",
      auth: "edge",
      handler: (req) => brainGraphProxy.handleBrainGraphUI(req),
    },
    // ── Telegram control plane ──
    {
      path: "/v1/integrations/telegram/config",
      method: "GET",
      auth: "edge",
      handler: (req) => telegramControlPlaneProxy.handleGetTelegramConfig(req),
    },
    {
      path: "/v1/integrations/telegram/config",
      method: "POST",
      auth: "edge",
      handler: (req) => telegramControlPlaneProxy.handleSetTelegramConfig(req),
    },
    {
      path: "/v1/integrations/telegram/config",
      method: "DELETE",
      auth: "edge",
      handler: (req) =>
        telegramControlPlaneProxy.handleClearTelegramConfig(req),
    },
    {
      path: "/v1/integrations/telegram/commands",
      method: "POST",
      auth: "edge",
      handler: (req) =>
        telegramControlPlaneProxy.handleSetTelegramCommands(req),
    },
    {
      path: "/v1/integrations/telegram/setup",
      method: "POST",
      auth: "edge",
      handler: (req) => telegramControlPlaneProxy.handleSetupTelegram(req),
    },

    // ── Vercel control plane ──
    {
      path: "/v1/integrations/vercel/config",
      method: "GET",
      auth: "edge",
      handler: (req) => vercelControlPlaneProxy.handleGetVercelConfig(req),
    },
    {
      path: "/v1/integrations/vercel/config",
      method: "POST",
      auth: "edge",
      handler: (req) => vercelControlPlaneProxy.handleSetVercelConfig(req),
    },
    {
      path: "/v1/integrations/vercel/config",
      method: "DELETE",
      auth: "edge",
      handler: (req) => vercelControlPlaneProxy.handleDeleteVercelConfig(req),
    },

    // ── Contacts control plane ──
    {
      path: "/v1/contacts/prompt/submit",
      method: "POST",
      auth: "edge",
      handler: (req) => handleContactPromptSubmit(req),
    },
    {
      // Assistant-scoped variant for clients using the auto-prefix.
      path: /^\/v1\/assistants\/[^/]+\/contacts\/prompt\/submit\/?$/,
      method: "POST",
      auth: "edge",
      handler: (req) => handleContactPromptSubmit(req),
    },
    {
      path: "/v1/contacts",
      method: "GET",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleListContacts(req),
    },
    {
      path: "/v1/contacts",
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleUpsertContact(req),
    },
    {
      // Assistant-scoped variant for clients using the auto-prefix.
      path: /^\/v1\/assistants\/[^/]+\/contacts\/?$/,
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleUpsertContact(req),
    },
    {
      path: "/v1/contacts/merge",
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleMergeContacts(req),
    },
    {
      path: /^\/v1\/contact-channels\/([^/]+)$/,
      method: "PATCH",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleUpdateContactChannel(req, params[0]),
    },
    {
      path: /^\/v1\/contact-channels\/([^/]+)\/verify$/,
      method: "POST",
      auth: "edge-guardian",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleVerifyContactChannel(req, params[0]),
    },
    {
      // Assistant-scoped variant for clients using the auto-prefix.
      path: /^\/v1\/assistants\/[^/]+\/contact-channels\/([^/]+)\/verify\/?$/,
      method: "POST",
      auth: "edge-guardian",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleVerifyContactChannel(req, params[0]),
    },
    // ── Contacts/invites control plane ──
    // Scope map: invites list → settings.read; create/redeem/revoke/call →
    // settings.write.
    {
      path: "/v1/contacts/invites",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => contactsControlPlaneProxy.handleListInvites(req),
    },
    {
      path: "/v1/contacts/invites",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => contactsControlPlaneProxy.handleCreateInvite(req),
    },
    {
      path: "/v1/contacts/invites/redeem",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => contactsControlPlaneProxy.handleRedeemInvite(req),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)\/call$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleCallInvite(req, params[0]),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleRevokeInvite(req, params[0]),
    },
    {
      // Keep DELETE on the invite collection unsupported; only /invites/:id
      // should revoke an invite.
      path: /^\/v1\/contacts\/(?!invites\/?$)([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge",
      handler: (_req, params) =>
        contactsControlPlaneProxy.handleDeleteContact(params[0]),
    },
    {
      // Assistant-scoped variant for clients using the auto-prefix.
      path: /^\/v1\/assistants\/[^/]+\/contacts\/(?!invites\/?$)([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge",
      handler: (_req, params) =>
        contactsControlPlaneProxy.handleDeleteContact(params[0]),
    },
    {
      path: /^\/v1\/contacts\/([^/]+)$/,
      method: "GET",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleGetContact(req, params[0]),
    },

    // ── Generic loopback pairing (localhost-only, auth: none) ──
    {
      path: "/v1/pair",
      method: "POST",
      auth: "none",
      handler: (req, _params, getClientIp) => handlePair(req, getClientIp()),
    },
    {
      path: "/v1/remote-web/pairing-challenge",
      method: "POST",
      auth: "none",
      handler: (req, _params, getClientIp, getRawPeerIp) =>
        handleCreateRemoteWebPairingChallenge(
          req,
          getClientIp(),
          getRawPeerIp(),
        ),
    },
    {
      path: "/v1/remote-web/pairing-verification",
      method: "POST",
      auth: "none",
      handler: (req, _params, getClientIp) =>
        handleVerifyRemoteWebPairingChallenge(req, getClientIp()),
    },
    {
      path: "/v1/remote-web/pairing-token",
      method: "POST",
      auth: "none",
      handler: (req) => handleRemoteWebPairingToken(req),
    },
    // ── Credential requests (one-time credential-collection links) ──
    // Unauthenticated by design: the single-use token in the request BODY is
    // the credential to act. Invalid tokens count as auth failures.
    // The entry page is a static self-contained HTML shell (no token
    // server-side — it rides the URL fragment); Velay-tunneled deployments
    // have no SPA server behind the tunnel, so the gateway serves it.
    {
      path: "/assistant/credentials/enter",
      method: "GET",
      auth: "none",
      handler: (req) => handleCredentialEntryPage(req),
    },
    {
      path: "/v1/credential-requests/peek",
      method: "POST",
      auth: "track-failures",
      trackFailureStatuses: [404],
      handler: (req) => handleCredentialRequestPeek(req),
    },
    {
      path: "/v1/credential-requests/submit",
      method: "POST",
      auth: "track-failures",
      trackFailureStatuses: [404],
      handler: (req) => handleCredentialRequestSubmit(req),
    },
    // ── Device management (localhost-only, auth: none; self-guards loopback) ──
    {
      path: "/v1/devices",
      method: "GET",
      auth: "none",
      handler: (req, _params, getClientIp) =>
        handleListDevices(req, getClientIp()),
    },
    {
      path: "/v1/devices/revoke",
      method: "POST",
      auth: "none",
      handler: (req, _params, getClientIp) =>
        handleRevokeDevice(req, getClientIp()),
    },

    // ── Channel verification sessions ──
    {
      // Bootstrap endpoint — may be replaced with an SSH-based exchange in the
      // future so that remote clients never need an exposed HTTP endpoint.
      path: "/v1/guardian/init",
      method: "POST",
      auth: "none",
      handler: (req, _params, getClientIp) =>
        channelVerificationSessionProxy.handleGuardianInit(req, getClientIp()),
    },
    {
      path: "/v1/guardian/reset-bootstrap",
      method: "POST",
      auth: "none",
      handler: (req, _params, getClientIp) =>
        channelVerificationSessionProxy.handleResetBootstrap(
          getClientIp(),
          req,
        ),
    },
    {
      path: "/v1/channel-verification-sessions",
      method: "POST",
      auth: "edge",
      handler: (req) =>
        channelVerificationSessionProxy.handleCreateVerificationSession(req),
    },
    {
      path: "/v1/channel-verification-sessions",
      method: "DELETE",
      auth: "edge",
      handler: (req) =>
        channelVerificationSessionProxy.handleCancelVerificationSession(req),
    },
    {
      path: "/v1/channel-verification-sessions/resend",
      method: "POST",
      auth: "edge",
      handler: (req) =>
        channelVerificationSessionProxy.handleResendVerificationSession(req),
    },
    {
      path: "/v1/channel-verification-sessions/status",
      method: "GET",
      auth: "edge",
      handler: (req) =>
        channelVerificationSessionProxy.handleGetVerificationStatus(req),
    },
    {
      path: "/v1/channel-verification-sessions/revoke",
      method: "POST",
      auth: "edge",
      handler: (req) =>
        channelVerificationSessionProxy.handleRevokeVerificationBinding(req),
    },

    // ── Guardian refresh (custom auth: accepts expired JWTs) ──
    // The refresh endpoint's purpose is to obtain a new access token,
    // so rejecting expired tokens would create a deadlock once the JWT
    // expires. Signature, audience, and policy epoch are still verified
    // — only the expiration check is relaxed.
    {
      path: "/v1/guardian/refresh",
      method: "POST",
      auth: "custom",
      handler: (req, _params, getClientIp) => {
        if (hasRemoteWebRefreshCookie(req)) {
          return handleGuardianRefresh(req);
        }

        const authHeader = req.headers.get("authorization");
        if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
          authRateLimiter.recordFailure(getClientIp());
          log.warn(
            { path: new URL(req.url).pathname },
            "Guardian refresh auth rejected: missing or malformed Authorization header",
          );
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const result = validateEdgeToken(token, { allowExpired: true });
        if (!result.ok) {
          authRateLimiter.recordFailure(getClientIp());
          log.warn(
            { path: new URL(req.url).pathname, reason: result.reason },
            "Guardian refresh auth rejected: token validation failed",
          );
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return handleGuardianRefresh(req);
      },
    },

    // ── Twilio control plane ──
    {
      path: "/v1/integrations/twilio/config",
      method: "GET",
      auth: "edge",
      handler: (req) => twilioControlPlaneProxy.handleGetTwilioConfig(req),
    },
    {
      path: "/v1/integrations/twilio/credentials",
      method: "POST",
      auth: "edge",
      handler: (req) => twilioControlPlaneProxy.handleSetTwilioCredentials(req),
    },
    {
      path: "/v1/integrations/twilio/credentials",
      method: "DELETE",
      auth: "edge",
      handler: (req) =>
        twilioControlPlaneProxy.handleClearTwilioCredentials(req),
    },
    {
      path: "/v1/integrations/twilio/numbers",
      method: "GET",
      auth: "edge",
      handler: (req) => twilioControlPlaneProxy.handleListTwilioNumbers(req),
    },
    {
      path: "/v1/integrations/twilio/numbers/provision",
      method: "POST",
      auth: "edge",
      handler: (req) =>
        twilioControlPlaneProxy.handleProvisionTwilioNumber(req),
    },
    {
      path: "/v1/integrations/twilio/numbers/assign",
      method: "POST",
      auth: "edge",
      handler: (req) => twilioControlPlaneProxy.handleAssignTwilioNumber(req),
    },
    {
      path: "/v1/integrations/twilio/numbers/release",
      method: "POST",
      auth: "edge",
      handler: (req) => twilioControlPlaneProxy.handleReleaseTwilioNumber(req),
    },
    // ── Slack control plane ──
    {
      path: "/v1/slack/channels",
      method: "GET",
      auth: "edge",
      handler: (req) => slackControlPlaneProxy.handleListSlackChannels(req),
    },
    {
      path: "/v1/slack/share",
      method: "POST",
      auth: "edge",
      handler: (req) => slackControlPlaneProxy.handleShareToSlack(req),
    },

    // ── OAuth providers ──
    {
      path: "/v1/oauth/providers",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => oauthProvidersProxy.handleListProviders(req),
    },
    {
      path: /^\/v1\/oauth\/providers\/([^/]+)\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req, params) =>
        oauthProvidersProxy.handleGetProvider(req, params[0]),
    },

    // ── OAuth apps ──
    {
      path: "/v1/oauth/apps",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => oauthAppsProxy.handleListApps(req),
    },
    {
      path: "/v1/oauth/apps",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => oauthAppsProxy.handleCreateApp(req),
    },
    {
      path: /^\/v1\/oauth\/apps\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => oauthAppsProxy.handleDeleteApp(req, params[0]),
    },
    {
      path: /^\/v1\/oauth\/apps\/([^/]+)\/connections\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req, params) =>
        oauthAppsProxy.handleListConnections(req, params[0]),
    },
    {
      path: /^\/v1\/oauth\/connections\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        oauthAppsProxy.handleDeleteConnection(req, params[0]),
    },
    {
      path: /^\/v1\/oauth\/apps\/([^/]+)\/connect\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => oauthAppsProxy.handleConnect(req, params[0]),
    },

    // ── Upgrade broadcast ──
    {
      path: "/v1/admin/upgrade-broadcast",
      method: "POST",
      auth: "edge-scoped",
      scope: "admin.write",
      handler: (req) => upgradeBroadcastProxy(req),
    },

    // ── Migration export/import ──
    {
      path: "/v1/migrations/export",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => migrationExportProxy(req),
    },
    {
      path: "/v1/migrations/import",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => migrationImportProxy(req),
    },
    {
      // Async-job status endpoint for URL-based imports. The gateway keeps
      // an in-memory job map keyed by the jobId it handed back in the
      // 202 response; this lets callers poll for progress without holding
      // an HTTP connection open for the full import duration.
      //
      // Trailing slash is optional to preserve compatibility with existing
      // pollers. PlatformMigrationClient.pollImportStatus (macOS) and
      // cli/src/lib/platform-client.ts both hit `.../status/` against the
      // platform API today; other callers may follow the bare-path
      // convention (`.../status`). Regex routes in the gateway router are
      // NOT trailing-slash-normalized, so the optionality is encoded here.
      path: /^\/v1\/migrations\/import\/([^/]+)\/status\/?$/,
      method: "GET",
      auth: "edge-scoped",
      // Read-only polling endpoint — read scope, not write. Matches the
      // convention used for other GET endpoints in this router (OAuth
      // providers GET, OAuth apps GET) so a token
      // profile with `settings.read` only (e.g. the `ui_page_v1`
      // profile) can still poll import progress.
      scope: "settings.read",
      handler: (req, params) =>
        migrationImportStatusProxy(req, params[0] ?? ""),
    },

    // ── Teleport-GCS migration (unified daemon-async flow) ──
    // Registered as explicit routes (not via the runtime-proxy catch-all)
    // for dedicated auth and timeout handling. The daemon returns 202
    // { job_id } on POST and cheap JSON on GET, so the gateway just
    // transparently forwards without wrapping.
    {
      path: "/v1/migrations/export-to-gcs",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => migrationExportToGcsProxy(req),
    },
    {
      path: "/v1/migrations/import-from-gcs",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => migrationImportFromGcsProxy(req),
    },
    {
      path: /^\/v1\/migrations\/jobs\/([^/]+)\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req, params) => migrationJobStatusProxy(req, params[0] ?? ""),
    },

    // ── Workspace commit ──
    {
      path: "/v1/admin/workspace-commit",
      method: "POST",
      auth: "edge-scoped",
      scope: "admin.write",
      handler: (req) => workspaceCommitProxy(req),
    },

    // ── Migration rollback ──
    {
      path: "/v1/admin/rollback-migrations",
      method: "POST",
      auth: "edge-scoped",
      scope: "admin.write",
      handler: (req) => migrationRollbackProxy(req),
    },

    // ── Backups ──
    {
      path: "/v1/backups",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleListBackups(req),
    },
    {
      path: "/v1/backups/create",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleCreateBackup(req),
    },

    // ── Backups — assistant-scoped variants ──
    // Mirror the flat /v1/backups routes for clients that use the daemon
    // SDK's assistant-scoped URLs (/v1/assistants/<id>/backups/...).
    // Without these, the request falls through to the runtime-proxy
    // catch-all and the daemon rejects create ("moved to gateway").
    // Backups are gateway-global, so the assistant id is matched and
    // discarded. Same precedent as the trust-rules assistant-scoped
    // variants below.
    {
      path: /^\/v1\/assistants\/[^/]+\/backups\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleListBackups(req),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/backups\/create\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleCreateBackup(req),
    },

    // ── Channel readiness ──
    {
      path: "/v1/channels/readiness",
      method: "GET",
      auth: "edge",
      handler: (req) => channelReadinessProxy.handleGetChannelReadiness(req),
    },
    {
      path: "/v1/channels/readiness/refresh",
      method: "POST",
      auth: "edge",
      handler: (req) =>
        channelReadinessProxy.handleRefreshChannelReadiness(req),
    },

    {
      path: /^\/v1\/assistants\/([^/]+)\/channels\/readiness\/$/,
      method: "GET",
      auth: "edge",
      handler: (req) => channelReadinessProxy.handleGetChannelReadiness(req),
    },

    // ── Integration status ──
    {
      path: "/integrations/status",
      method: "GET",
      auth: "edge",
      handler: () =>
        Response.json({
          email: {
            address: configFileCache.getString("email", "address") ?? null,
          },
        }),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/integrations\/status\/$/,
      method: "GET",
      auth: "edge",
      handler: () =>
        Response.json({
          email: {
            address: configFileCache.getString("email", "address") ?? null,
          },
        }),
    },

    // ── Feature flags (scope-protected) ──
    {
      path: "/v1/feature-flags",
      method: "GET",
      auth: "edge-scoped",
      scope: "feature_flags.read",
      handler: (req) => handleFeatureFlagsGet(req),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/feature-flags\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "feature_flags.read",
      handler: (req) => handleFeatureFlagsGet(req),
    },
    {
      path: /^\/v1\/feature-flags\/(.+)$/,
      method: "PATCH",
      auth: "edge-scoped",
      scope: "feature_flags.write",
      handler: (req, params) => {
        let flagKey: string;
        try {
          flagKey = decodeURIComponent(params[0]);
        } catch {
          return Response.json(
            { error: "Invalid flag key encoding" },
            { status: 400 },
          );
        }
        return handleFeatureFlagsPatch(req, flagKey);
      },
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/feature-flags\/(.+)$/,
      method: "PATCH",
      auth: "edge-scoped",
      scope: "feature_flags.write",
      handler: (req, params) => {
        let flagKey: string;
        try {
          flagKey = decodeURIComponent(params[1].replace(/\/$/, ""));
        } catch {
          return Response.json(
            { error: "Invalid flag key encoding" },
            { status: 400 },
          );
        }
        return handleFeatureFlagsPatch(req, flagKey);
      },
    },

    // ── Auto-approve thresholds (scope-protected) ──
    {
      path: "/v1/permissions/thresholds",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleGlobalThresholdGet(req),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/permissions\/thresholds\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleGlobalThresholdGet(req),
    },
    {
      path: "/v1/permissions/thresholds",
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleGlobalThresholdPut(req),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/permissions\/thresholds\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleGlobalThresholdPut(req),
    },

    // ── Per-conversation threshold overrides (scope-protected) ──
    {
      path: /^\/v1\/permissions\/thresholds\/conversations\/([^/]+)\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req, params) => handleConversationThresholdGet(req, params),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/permissions\/thresholds\/conversations\/([^/]+)\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req, params) =>
        handleConversationThresholdGet(req, params.slice(1)),
    },
    {
      path: /^\/v1\/permissions\/thresholds\/conversations\/([^/]+)\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleConversationThresholdPut(req, params),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/permissions\/thresholds\/conversations\/([^/]+)\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        handleConversationThresholdPut(req, params.slice(1)),
    },
    {
      path: /^\/v1\/permissions\/thresholds\/conversations\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleConversationThresholdDelete(req, params),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/permissions\/thresholds\/conversations\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        handleConversationThresholdDelete(req, params.slice(1)),
    },

    // ── Log export ──
    {
      path: "/v1/logs/export",
      method: "POST",
      auth: "edge",
      handler: (req, params, getClientIp) =>
        handleLogExport(req, params, getClientIp),
    },
    {
      path: "/v1/logs/tail",
      method: "GET",
      auth: "edge",
      handler: (req) => handleLogTail(req),
    },

    // ── Trust rules v3 ──
    {
      path: "/v1/trust-rules",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleTrustRulesList(req),
    },
    {
      // Must appear before the POST /v1/trust-rules create entry and before
      // the /:id catch-all regex so the literal path is matched first.
      path: "/v1/trust-rules/suggest",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleTrustRulesSuggest(req),
    },
    {
      path: "/v1/trust-rules",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleTrustRulesCreate(req),
    },
    {
      // Reset must be registered before the /:id catch-all regex
      path: /^\/v1\/trust-rules\/([^/]+)\/reset$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleTrustRulesReset(req, params[0]),
    },
    {
      path: /^\/v1\/trust-rules\/([^/]+)$/,
      method: "PATCH",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleTrustRulesUpdate(req, params[0]),
    },
    {
      path: /^\/v1\/trust-rules\/([^/]+)$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleTrustRulesDelete(req, params[0]),
    },

    // ── Channel admission policy — flat routes ──
    // Storage + CRUD for the per-channel admission floor. Gateway-owned: the
    // admission-policy store and cache live here, not in the daemon. The
    // platform's RuntimeProxyView strips the `/v1/assistants/<id>/` prefix and
    // forwards the flat path to the gateway via `/gateway-query`, so these flat
    // routes are what actually serve client traffic. The mutation regexes
    // tolerate a trailing slash.
    {
      path: /^\/v1\/channel-admission-policy\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleChannelAdmissionPolicyList(req),
    },
    {
      path: /^\/v1\/channel-admission-policy\/([^/]+)\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleChannelAdmissionPolicySet(req, params[0]),
    },
    {
      path: /^\/v1\/channel-admission-policy\/([^/]+)\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleChannelAdmissionPolicySet(req, params[0]),
    },
    {
      path: /^\/v1\/channel-admission-policy\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        handleChannelAdmissionPolicyDelete(req, params[0]),
    },

    // ── Channel admission policy — assistant-scoped variants ──
    // Mirror the flat routes for clients that use GatewayHTTPClient's
    // auto-prefix, which builds URLs like
    // /v1/assistants/<id>/channel-admission-policy/<channel>/. Without these,
    // the request falls through to the runtime-proxy catch-all and the daemon
    // serves 404 (the daemon does not implement this gateway storage API).
    // Admission policy is gateway-global, so the assistant id is matched and
    // discarded — same precedent as the assistant-scoped trust-rules routes
    // below.
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-admission-policy\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleChannelAdmissionPolicyList(req),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-admission-policy\/([^/]+)\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleChannelAdmissionPolicySet(req, params[0]),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-admission-policy\/([^/]+)\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleChannelAdmissionPolicySet(req, params[0]),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-admission-policy\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        handleChannelAdmissionPolicyDelete(req, params[0]),
    },

    // ── Channel permission overrides (matrix cells) — flat routes ──
    // HTTP mirror of the channel-permission IPC surface so configuration
    // clients can read/write cascade cells. Gateway-owned storage; same
    // platform-proxy path shape as channel-admission-policy above. The
    // delete is a POST verb path because cells are keyed by a composite
    // (selector × contact-type), not a row id.
    {
      path: /^\/v1\/channel-permission-overrides\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleChannelPermissionOverridesList(req),
    },
    {
      path: /^\/v1\/channel-permission-overrides\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleChannelPermissionOverrideSet(req),
    },
    {
      path: /^\/v1\/channel-permission-overrides\/delete\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleChannelPermissionOverrideDelete(req),
    },
    // Resolve is a read (settings.read) despite the POST verb — the body
    // carries a composite query, same rationale as /delete above.
    {
      path: /^\/v1\/channel-permission-overrides\/resolve\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleChannelPermissionResolve(req),
    },

    // ── Channel permission overrides — assistant-scoped variants ──
    // Matrix cells are gateway-global, so the assistant id is matched and
    // discarded — same precedent as channel-admission-policy above.
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-permission-overrides\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleChannelPermissionOverridesList(req),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-permission-overrides\/?$/,
      method: "PUT",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleChannelPermissionOverrideSet(req),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-permission-overrides\/delete\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleChannelPermissionOverrideDelete(req),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/channel-permission-overrides\/resolve\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleChannelPermissionResolve(req),
    },

    // ── Trust rules v3 — assistant-scoped variants ──
    // Mirror the flat /v1/trust-rules routes for clients that use
    // GatewayHTTPClient's auto-prefix (Swift TrustRuleClient and
    // vellum-assistant-platform's web/src/lib/trust-rules/api.ts), which build
    // URLs like /v1/assistants/<id>/trust-rules/. Without these, the request
    // falls through to the runtime-proxy catch-all and the daemon serves 404
    // on mutations (the daemon HTTP handlers were stripped by #28784).
    //
    // Trust rules are gateway-global, so the assistant id is matched and
    // discarded. Same precedent as the assistant-scoped /v1/assistants/.../
    // contacts DELETE route above.
    {
      path: /^\/v1\/assistants\/[^/]+\/trust-rules\/?$/,
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => handleTrustRulesList(req),
    },
    {
      // Must appear before the create entry and before the /:id catch-all
      // so the literal /suggest segment is matched first.
      path: /^\/v1\/assistants\/[^/]+\/trust-rules\/suggest\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleTrustRulesSuggest(req),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/trust-rules\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handleTrustRulesCreate(req),
    },
    {
      // Reset must be registered before the /:id catch-all regex.
      path: /^\/v1\/assistants\/[^/]+\/trust-rules\/([^/]+)\/reset\/?$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleTrustRulesReset(req, params[0]),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/trust-rules\/([^/]+)\/?$/,
      method: "PATCH",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleTrustRulesUpdate(req, params[0]),
    },
    {
      path: /^\/v1\/assistants\/[^/]+\/trust-rules\/([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) => handleTrustRulesDelete(req, params[0]),
    },
  ];

  // ── Web token auth ──
  routes.push({
    path: "/auth/token",
    method: "POST",
    auth: "custom",
    handler: (req) => handleCreateToken(req, server, config.trustProxy),
  });

  // Runtime proxy catch-all — must be last so specific routes are checked first.
  routes.push({
    path: /^\//, // match everything
    auth: "track-failures",
    handler: (req, _params, getClientIp) =>
      handleRuntimeProxy(req, getClientIp()),
  });

  const router = createRouter(routes, {
    authRateLimiter,
    trustProxy: config.trustProxy,
  });

  /** Stamp the assistant version header on a response. */
  function stampVersion<T extends Response>(res: T): T {
    res.headers.set(VERSION_HEADER_NAME, VERSION_HEADER_VALUE);
    return res;
  }

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    // Match the daemon's 512 MB limit (assistant/src/runtime/http-server.ts)
    // so large .vbundle imports proxied through the gateway aren't rejected.
    maxRequestBodySize: 512 * 1024 * 1024,
    websocket: {
      open(ws) {
        if (isMediaStreamSocketData(ws.data)) {
          twilioMediaStreamWebsocketHandlers.open(ws as never);
          return;
        }
        if (isSttStreamSocketData(ws.data)) {
          sttStreamWebsocketHandlers.open(ws as never);
          return;
        }
        if (isLiveVoiceSocketData(ws.data)) {
          liveVoiceWebsocketHandlers.open(ws as never);
          return;
        }
        closeUnknownSocket(ws, "open");
      },
      message(ws, message) {
        if (isMediaStreamSocketData(ws.data)) {
          twilioMediaStreamWebsocketHandlers.message(ws as never, message);
          return;
        }
        if (isSttStreamSocketData(ws.data)) {
          sttStreamWebsocketHandlers.message(ws as never, message);
          return;
        }
        if (isLiveVoiceSocketData(ws.data)) {
          liveVoiceWebsocketHandlers.message(ws as never, message);
          return;
        }
        closeUnknownSocket(ws, "message");
      },
      close(ws, code, reason) {
        if (isMediaStreamSocketData(ws.data)) {
          twilioMediaStreamWebsocketHandlers.close(ws as never, code, reason);
          return;
        }
        if (isSttStreamSocketData(ws.data)) {
          sttStreamWebsocketHandlers.close(ws as never, code, reason);
          return;
        }
        if (isLiveVoiceSocketData(ws.data)) {
          liveVoiceWebsocketHandlers.close(ws as never, code, reason);
          return;
        }
        log.error(
          { wsType: extractWsType(ws.data), code, reason },
          "WebSocket closed with unknown socket type",
        );
      },
    },
    error(err) {
      if (err instanceof CircuitBreakerOpenError) {
        return stampVersion(
          Response.json(
            {
              error: "Service temporarily unavailable — runtime is unreachable",
            },
            {
              status: 503,
              headers: { "Retry-After": String(err.retryAfterSecs) },
            },
          ),
        );
      }
      log.error({ err }, "Unhandled gateway error");
      return stampVersion(
        Response.json({ error: "Internal server error" }, { status: 500 }),
      );
    },
    async fetch(req, svr) {
      svr.timeout(req, 1800);
      const inner = await routeRequest(req, svr);
      if (inner) stampVersion(inner);
      return inner;
    },
  });

  /** Core request routing — extracted so `fetch` can stamp headers on every response. */
  async function routeRequest(
    req: Request,
    svr: ReturnType<typeof Bun.serve>,
  ): Promise<Response | undefined> {
    const url = new URL(req.url);

    // ── Pre-router: health probe ──
    // This stays available during post-assistant-ready startup work so
    // Kubernetes startup/liveness probes can observe the bound process.
    if (url.pathname === "/healthz") {
      const includeMigrations =
        url.searchParams.get("include") === "migrations";
      if (!includeMigrations) {
        return Response.json({ status: "ok" });
      }
      // Fetch the daemon's /v1/health to surface migration state
      // (dbVersion, lastWorkspaceMigrationId) so the CLI can capture
      // pre-upgrade migration state through the gateway.
      try {
        const upstream = await fetch(
          `${config.assistantRuntimeBaseUrl}/v1/health`,
          {
            signal: AbortSignal.timeout(3000),
            headers: { authorization: `Bearer ${mintServiceToken()}` },
          },
        );
        if (upstream.ok) {
          const body = (await upstream.json()) as {
            migrations?: {
              dbVersion?: number;
              lastWorkspaceMigrationId?: string;
            };
          };
          return Response.json({
            status: "ok",
            ...(body.migrations ? { migrations: body.migrations } : {}),
          });
        }
      } catch {
        // Daemon unreachable — graceful degradation, still return ok
      }
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/readyz") {
      if (draining) {
        return Response.json({ status: "draining" }, { status: 503 });
      }
      // Check that the upstream assistant is also reachable so callers
      // know the full stack is ready, not just the gateway process.
      //
      // The assistant's readiness body (`ready`, `dbMigrations`) is forwarded
      // so programmatic callers — the upgrade/hatch CLI waits in particular —
      // can distinguish "still migrating" (200, ready:false) from "ready" and
      // detect terminally failed migrations.
      //
      // Status-code contract while the gateway's own post-assistant-ready
      // work is incomplete (every non-probe route 503s "starting"):
      // - Assistant still migrating (ready:false body): 200. Migrations can
      //   take minutes and the orchestrator must keep the pod in service —
      //   the forwarded ready:false body already keeps body-aware CLI waits
      //   waiting.
      // - Assistant ready, gateway backfills still running: 503 "starting".
      //   This window is seconds long, and reporting ready here would let
      //   the orchestrator route traffic — and CLI waits declare the stack
      //   ready — while every route still 503s (upgrade would commit early;
      //   hatch would burn its guardian-lease budget against the closed
      //   gate).
      try {
        const upstream = await fetch(
          `${config.assistantRuntimeBaseUrl}/readyz`,
          { signal: AbortSignal.timeout(3000) },
        );
        const upstreamBody = (await upstream
          .json()
          .catch(() => null)) as Record<string, unknown> | null;
        if (!upstream.ok) {
          return Response.json(
            {
              ...(upstreamBody ?? {}),
              status: "upstream_unhealthy",
              upstream: upstream.status,
            },
            { status: 503 },
          );
        }
        if (!postAssistantReadyComplete) {
          if (upstreamBody?.ready === false) {
            return Response.json(upstreamBody);
          }
          return Response.json(
            { ...(upstreamBody ?? {}), status: "starting", ready: false },
            { status: 503 },
          );
        }
        return Response.json(upstreamBody ?? { status: "ok" });
      } catch {
        return Response.json(
          { status: "upstream_unreachable" },
          { status: 503 },
        );
      }
    }

    if (!postAssistantReadyComplete) {
      return Response.json({ status: "starting" }, { status: 503 });
    }

    // ── CORS: webview preflight & origin tracking ──
    // The macOS WKWebView loads pages from https://{appId}.vellum.local/
    // which is cross-origin to the gateway at http://127.0.0.1:{port}.
    // Reflect the origin back on matched requests so window.vellum.fetch
    // calls succeed.
    const extensionOrigin = resolveExtensionOrigin(req);
    if (extensionOrigin && req.method === "OPTIONS") {
      return handleExtensionPreflight(extensionOrigin);
    }

    const webviewOrigin = resolveWebviewOrigin(req);
    if (webviewOrigin && req.method === "OPTIONS") {
      return handlePreflight(webviewOrigin);
    }

    if (url.pathname === "/schema") {
      return Response.json(buildSchema());
    }

    // Per-request IP resolver — scoped to this request so it remains
    // correct across async yields under concurrent load.
    const resolveClientIp: GetClientIp = () =>
      getClientIp(req, svr, config.trustProxy);

    const rateLimitResponse = checkAuthRateLimit(
      url,
      authRateLimiter,
      resolveClientIp(),
    );
    if (rateLimitResponse) {
      if (extensionOrigin)
        return withExtensionCorsHeaders(rateLimitResponse, extensionOrigin);
      if (webviewOrigin)
        return withCorsHeaders(rateLimitResponse, webviewOrigin);
      return rateLimitResponse;
    }

    // ── Pre-router: WebSocket upgrades ──
    // Bun's WS upgrade needs `server.upgrade()` which doesn't return
    // a Response, so these can't go through the route table.
    if (
      url.pathname === TWILIO_MEDIA_STREAM_WEBHOOK_PATH ||
      url.pathname.startsWith(`${TWILIO_MEDIA_STREAM_WEBHOOK_PATH}/`)
    ) {
      const upgradeResult = handleTwilioMediaWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined as unknown as Response;
    }

    if (url.pathname === "/v1/stt/stream") {
      const upgradeResult = handleSttStreamWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined as unknown as Response;
    }

    if (url.pathname === "/v1/live-voice") {
      const upgradeResult = handleLiveVoiceWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined as unknown as Response;
    }

    // Attach a trace ID to every non-healthcheck request for
    // end-to-end correlation across webhook -> runtime -> reply.
    if (!req.headers.has("x-trace-id")) {
      req.headers.set("x-trace-id", generateTraceId());
    }

    // ── Route table dispatch ──
    try {
      const response = await router(req, url, resolveClientIp, svr);
      if (response !== null) {
        if (extensionOrigin) {
          return withExtensionCorsHeaders(response, extensionOrigin);
        }
        if (webviewOrigin) {
          return withCorsHeaders(response, webviewOrigin);
        }
        return response;
      }
    } catch (err) {
      // Mirror the error() handler logic while retaining CORS context.
      // Bun's error() callback doesn't receive the request, so thrown
      // errors during webview/extension requests would otherwise lose CORS headers.
      if (!webviewOrigin && !extensionOrigin) throw err;
      if (err instanceof CircuitBreakerOpenError) {
        const body = Response.json(
          {
            error:
              "Service temporarily unavailable \u2014 runtime is unreachable",
          },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
        if (extensionOrigin)
          return withExtensionCorsHeaders(body, extensionOrigin);

        return withCorsHeaders(body, webviewOrigin!);
      }
      log.error({ err }, "Unhandled gateway error");
      const errBody = Response.json(
        { error: "Internal server error" },
        { status: 500 },
      );
      if (extensionOrigin)
        return withExtensionCorsHeaders(errBody, extensionOrigin);
      return withCorsHeaders(errBody, webviewOrigin!);
    }

    const notFound = Response.json(
      { error: "Not found", source: "gateway" },
      { status: 404 },
    );
    if (extensionOrigin)
      return withExtensionCorsHeaders(notFound, extensionOrigin);
    if (webviewOrigin) return withCorsHeaders(notFound, webviewOrigin);
    return notFound;
  }

  log.info({ port: server.port }, "Gateway HTTP server listening");

  // Complete post-assistant-ready startup work after binding /healthz.
  // All non-health routes stay closed until this returns. When the assistant
  // is not migration-ready within the bounded wait, this still returns (so
  // traffic opens) while the deferred tasks keep retrying in the background —
  // see post-assistant-ready.ts.
  try {
    await runPostAssistantReady();
    postAssistantReadyComplete = true;
  } catch (err) {
    log.error({ err }, "Post-assistant-ready startup work failed");
    server.stop(true);
    process.exit(1);
  }

  logAuthBypassState();

  // Start periodic background cleanup for dedup caches
  telegramDedupCache.startCleanup();
  whatsappDedupCache.startCleanup();
  emailDedupCache.startCleanup();

  const telegramCaches = {
    credentials: credentialCache,
    configFile: configFileCache,
  };

  function registerTelegramCommands(): void {
    callTelegramApi(
      "setMyCommands",
      {
        commands: [
          { command: "new", description: "Start a new conversation" },
          { command: "help", description: "Show available commands" },
        ],
      },
      { credentials: credentialCache, configFile: configFileCache },
    ).catch((err) => {
      log.error({ err }, "Failed to register Telegram bot commands");
    });
  }

  // ── Slack Socket Mode lifecycle ──
  let slackSocketClient: SlackSocketModeClient | null = null;

  /** Fire-and-forget: notify the platform of inbound Slack activity so the
   *  idle-sleep timer is reset for this assistant.
   *  Throttled to at most one outbound POST per 30 seconds. */
  let lastRecordActivityTs = 0;
  async function notifyRecordActivity(): Promise<void> {
    if (!arePlatformFeaturesEnabled()) {
      log.debug("Platform features disabled — skipping record-activity");
      return;
    }

    const now = Date.now();
    if (now - lastRecordActivityTs < 30_000) return;
    lastRecordActivityTs = now;

    try {
      const [platformBaseUrl, assistantApiKey, assistantIdRaw] =
        await Promise.all([
          getPlatformBaseUrl(credentialCache),
          credentialCache.get(credentialKey("vellum", "assistant_api_key")),
          credentialCache.get(credentialKey("vellum", "platform_assistant_id")),
        ]);

      const assistantId = assistantIdRaw?.trim() || undefined;

      if (!platformBaseUrl || !assistantApiKey || !assistantId) return;

      const res = await fetchImpl(
        `${platformBaseUrl}/v1/assistants/${assistantId}/record-activity/`,
        {
          method: "POST",
          headers: { Authorization: `Api-Key ${assistantApiKey.trim()}` },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        log.warn(
          { status: res.status },
          "Non-OK response from record-activity endpoint",
        );
      }
    } catch (err) {
      log.debug(
        { err },
        "Failed to notify platform of Slack activity for idle sleep",
      );
    }
  }

  async function startSlackSocket(): Promise<void> {
    if (slackSocketClient) {
      slackSocketClient.stop();
      slackSocketClient = null;
    }

    const botToken = await credentialCache.get(
      credentialKey("slack_channel", "bot_token"),
    );
    const appToken = await credentialCache.get(
      credentialKey("slack_channel", "app_token"),
    );
    if (!botToken || !appToken) return;

    const threadModeRaw = configFileCache.getString("slack", "threadMode");
    const threadMode =
      threadModeRaw === "mention_only" ||
      threadModeRaw === "mention_then_thread"
        ? threadModeRaw
        : "mention_then_thread";

    slackSocketClient = createSlackSocketModeClient(
      { appToken, botToken, gatewayConfig: config, threadMode },
      (normalized) => {
        // Notify the platform of inbound activity so the idle-sleep timer
        // is reset for this assistant (fire-and-forget).
        notifyRecordActivity();

        const { threadTs, channel } = normalized;
        const params = new URLSearchParams({ channel });
        if (threadTs) params.set("threadTs", threadTs);
        // For non-threaded DMs, pass the original message ts so the runtime
        // can target it for emoji-based thinking indicators.
        const origMessageTs = normalized.event.source.messageId;
        if (!threadTs && origMessageTs) params.set("messageTs", origMessageTs);
        const replyCallbackUrl = `${config.gatewayInternalBaseUrl}/deliver/slack?${params}`;
        const slackSourceMetadata = {
          ...(normalized.event.raw.type === "app_mention"
            ? { slackBotMentioned: true }
            : {}),
          ...(threadTs && !normalized.event.source.threadId
            ? { threadId: threadTs }
            : {}),
        };

        // Whether this event represents an edit or callback action — these
        // never carry attachments to upload.
        const isEdit = !!normalized.event.message.isEdit;
        const isCallback = !!normalized.event.message.callbackData;

        // Handle /new command — reset conversation before it reaches the runtime
        if (isNewCommand(normalized.event.message.content)) {
          handleNewCommand(
            config,
            "slack",
            normalized.event.message.conversationExternalId,
            async (text) => {
              await fetchImpl("https://slack.com/api/chat.postMessage", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${botToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  channel,
                  text,
                  ...(threadTs ? { thread_ts: threadTs } : {}),
                }),
              });
            },
            log,
            threadTs,
          );
          return;
        }

        const forward = async () => {
          // Seed contact channel for the Slack actor (dual-write, fire-and-forget).
          // Covers both DMs (externalChatId = DM channel) and workspace messages.
          // Bot/app senders are classified as 'assistant' contacts with a
          // provenance note instead of the default 'human'.
          if (normalized.event.actor.actorExternalId) {
            void upsertContactChannel({
              sourceChannel: "slack",
              externalUserId: normalized.event.actor.actorExternalId,
              ...(normalized.event.source.chatType === "im"
                ? {
                    externalChatId:
                      normalized.event.message.conversationExternalId,
                  }
                : {}),
              displayName: normalized.event.actor.displayName,
              username: normalized.event.actor.username,
              ...(normalized.botSender
                ? {
                    contactType: "assistant" as const,
                    notes: slackBotContactNote(normalized.botSender),
                  }
                : {}),
            }).catch(() => {});
          }

          try {
            // Download and upload attachments if present (skip for edits and
            // callback actions — edits only update text, callbacks have no media)
            let attachmentIds: string[] | undefined;
            const eventAttachments = normalized.event.message.attachments;
            if (
              eventAttachments &&
              eventAttachments.length > 0 &&
              normalized.slackFiles &&
              !isEdit &&
              !isCallback
            ) {
              attachmentIds = [];
              const failedAttachmentNames: string[] = [];
              const maxBytes =
                config.maxAttachmentBytes.slack ??
                config.maxAttachmentBytes.default;

              // Guardian-actor bypass: when the Slack sender is the
              // assistant's owner, the upload is marked trustedSource so the
              // assistant accepts arbitrary MIME types and extensions
              // (e.g. .mkv, .dmg) for downstream processing. Resolved once
              // per message — the assistant re-checks gateway-service auth
              // before honoring the flag, so impersonation is not possible.
              // Lookup failures (e.g. assistant.db unavailable) default to
              // strict handling so non-guardian uploads still flow through
              // the normal validation path instead of being dropped.
              const slackActorId = normalized.event.actor.actorExternalId;
              let isGuardianActor = false;
              if (slackActorId) {
                try {
                  isGuardianActor = !!(await findGuardianForChannelActor(
                    "slack",
                    slackActorId,
                  ));
                } catch (err) {
                  log.warn(
                    { err, slackActorId },
                    "Guardian lookup failed; defaulting to strict attachment validation",
                  );
                }
              }

              // Filter oversized attachments
              const eligible = eventAttachments.filter((att) => {
                if (att.fileSize !== undefined && att.fileSize > maxBytes) {
                  log.warn(
                    {
                      fileId: att.fileId,
                      fileSize: att.fileSize,
                      limit: maxBytes,
                    },
                    "Skipping oversized Slack attachment",
                  );
                  return false;
                }
                return true;
              });

              // Process with bounded concurrency. Socket Mode has no retry
              // mechanism, so all errors (validation and transient) are logged
              // and skipped — the message is still delivered without the
              // failed attachment.
              for (
                let i = 0;
                i < eligible.length;
                i += config.maxAttachmentConcurrency
              ) {
                const batch = eligible.slice(
                  i,
                  i + config.maxAttachmentConcurrency,
                );
                const results = await Promise.allSettled(
                  batch.map(async (att) => {
                    const slackFile = normalized.slackFiles?.get(att.fileId);
                    if (!slackFile) {
                      throw new Error(
                        `No SlackFile found for attachment ${att.fileId}`,
                      );
                    }
                    const downloaded = await downloadSlackFile(
                      slackFile,
                      botToken,
                    );
                    return uploadAttachment(
                      config,
                      { ...downloaded, trustedSource: isGuardianActor },
                      { skipCircuitBreaker: true },
                    );
                  }),
                );
                for (let j = 0; j < results.length; j++) {
                  const result = results[j];
                  if (result.status === "fulfilled") {
                    attachmentIds.push(result.value.id);
                  } else if (
                    result.reason instanceof AttachmentValidationError
                  ) {
                    const att = batch[j];
                    failedAttachmentNames.push(att.fileName || att.fileId);
                    log.warn(
                      { err: result.reason },
                      "Skipping Slack attachment with validation error",
                    );
                  } else {
                    const att = batch[j];
                    failedAttachmentNames.push(att.fileName || att.fileId);
                    log.warn(
                      { err: result.reason },
                      "Skipping Slack attachment due to download/upload failure",
                    );
                  }
                }
              }

              if (failedAttachmentNames.length > 0) {
                const nameList = failedAttachmentNames
                  .map((n) => `"${n}"`)
                  .join(", ");
                normalized.event.message.content += `\n\n[The user attached file(s) that could not be retrieved: ${nameList}. Ask them to re-send if the content is important.]`;
              }
            }

            handleInbound(config, normalized.event, {
              replyCallbackUrl,
              routingOverride: normalized.routing,
              ...(Object.keys(slackSourceMetadata).length > 0
                ? { sourceMetadata: slackSourceMetadata }
                : {}),
              ...(attachmentIds && attachmentIds.length > 0
                ? { attachmentIds }
                : {}),
            }).catch((err) => {
              log.error(
                { err, channel, threadTs },
                "Failed to forward Slack event to runtime",
              );
            });
          } catch (err) {
            log.error(
              { err, channel, threadTs },
              "Failed to process Slack event — delivering message without attachments",
            );
            handleInbound(config, normalized.event, {
              replyCallbackUrl,
              routingOverride: normalized.routing,
              ...(Object.keys(slackSourceMetadata).length > 0
                ? { sourceMetadata: slackSourceMetadata }
                : {}),
            }).catch((fwdErr) => {
              log.error(
                { err: fwdErr, channel, threadTs },
                "Failed to forward Slack event to runtime (fallback)",
              );
            });
          }
        };

        // Slack thread/DM context is now assembled on the daemon from
        // persisted message rows (see `assembleSlackChronologicalMessages`
        // in the assistant), so the gateway no longer fetches per-turn
        // thread/DM context to inject as transport hints.
        forward().catch((err) => {
          log.error(
            { err, channel, threadTs },
            "Unhandled error in Slack forward",
          );
        });

        // Approval message replacement is handled by the assistant's
        // direct Slack delivery path (messaging/providers/slack/send.ts).
      },
    );

    slackSocketClient.start().catch((err) => {
      log.error({ err }, "Failed to start Slack Socket Mode client");
    });
    log.info("Slack Socket Mode client started");
  }

  // Lazily bound below, once `remoteFeatureFlagSync` is constructed, so the
  // credential-change callback can trigger an immediate per-assistant flag
  // re-sync. On a warm-pool claim the `vellum` credentials change to the
  // newly-assigned identity; without forcing a re-sync, flag values would not
  // refresh until the next scheduled poll (up to 5 min), so the onboarding
  // first message evaluates flags against stale values (see JARVIS-1018).
  let remoteFeatureFlagSyncRef: RemoteFeatureFlagSync | null = null;

  const credentialWatcher = new CredentialWatcher((event) => {
    const changed = detectCredentialChanges(event, log);

    // Invalidate the credential cache so subsequent reads pick up fresh values
    if (changed.size > 0) {
      credentialCache.invalidate();
    }

    // Update integration readiness flags from the credential event
    const telegramCreds = event.credentials.get("telegram");
    telegramReady = !!(
      telegramCreds?.bot_token && telegramCreds?.webhook_secret
    );

    const whatsappCreds = event.credentials.get("whatsapp");
    whatsappReady = !!(
      whatsappCreds?.phone_number_id && whatsappCreds?.access_token
    );

    const slackCreds = event.credentials.get("slack_channel");
    slackReady = !!(slackCreds?.bot_token && slackCreds?.app_token);

    const vellumCreds = event.credentials.get("vellum");
    vellumReady = !!(
      vellumCreds?.platform_base_url &&
      vellumCreds?.assistant_api_key &&
      vellumCreds?.platform_assistant_id
    );
    const twilioCreds = event.credentials.get("twilio");

    // Side effects keyed by service name
    if (changed.has("telegram") && telegramReady) {
      registerTelegramCommands();
      reconcileTelegramWebhook(telegramCaches).catch((err) => {
        log.error(
          { err },
          "Failed to reconcile Telegram webhook after credential change",
        );
      });
    }
    if (changed.has("slack_channel")) {
      startSlackSocket().catch((err) => {
        log.error(
          { err },
          "Failed to restart Slack Socket Mode after credential change",
        );
      });

      if (slackReady) {
        avatarChannelSyncer.register(new SlackAvatarSyncer(credentialCache));
        avatarChannelSyncer.syncToChannel("slack").catch((err) => {
          log.warn({ err }, "Initial Slack avatar sync failed");
        });
      } else {
        avatarChannelSyncer.unregister("slack");
      }
    }

    if (changed.has("twilio")) {
      maybeStartVelayTunnelForTwilio("twilio credentials changed", twilioCreds);
      syncConfiguredTwilioPhoneNumberWebhooks({
        credentials: credentialCache,
        configFile: configFileCache,
      }).catch((err) => {
        log.warn({ err }, "Twilio webhook sync failed after credential change");
      });
    }

    // Register email callback route with the platform so inbound email
    // webhooks are forwarded to this gateway (same pattern as Telegram).
    // Fires on initial credential load and whenever vellum credentials change
    // (key rotation, late provisioning).
    if (changed.has("vellum")) {
      velayTunnelClient?.refreshCredentials("vellum credentials changed");
      registerEmailCallbackRoute({
        credentials: credentialCache,
        configFile: configFileCache,
      }).catch((err) => {
        log.error(
          { err },
          "Failed to register email callback route after credential change",
        );
      });

      // Force an immediate per-assistant feature-flag re-sync. A `vellum`
      // credential change means a warm-pool claim / key rotation / late
      // provisioning — the assistant identity the platform evaluates flags
      // for just changed. Without this, flags stay at their previous (often
      // registry-default) values until the next ~5-min poll, which the
      // onboarding auto-greet beats, so first-message flags read stale
      // (JARVIS-1018). The ref is null only during the initial credential
      // poll at startup, which `start()` already covers.
      remoteFeatureFlagSyncRef?.syncNow().catch((err) => {
        log.error(
          { err },
          "Failed to sync remote feature flags after vellum credential change",
        );
      });
    }
  });

  const twilioStartupCredentials = await readTwilioCredentialsForVelayStartup();
  if (velayTunnelClient) {
    await clearManagedPublicBaseUrl(configFileCache).catch((err) => {
      log.error({ err }, "Failed to clear stale Velay public URL");
    });
  }
  maybeStartVelayTunnelForTwilio("startup", twilioStartupCredentials);
  // Velay is also the browser's ingress for web live voice, so bring the tunnel
  // up at startup when `voice-mode` is already enabled (not just for Twilio).
  maybeStartVelayTunnelForLiveVoice("startup");

  // The credential watcher callback handles credential-backed startup side
  // effects during the initial poll. Stale Velay-owned ingress is already
  // cleared before those side effects can register external callbacks.
  await credentialWatcher.start();

  // Start watching avatar directory for changes after credential watcher
  // so channel syncers are already registered before the first file event.
  avatarSyncWatcher.start();

  const configFileWatcher = new ConfigFileWatcher((event) => {
    // Invalidate the config file cache so subsequent reads pick up fresh values
    configFileCache.invalidate();

    // Side effect: reconcile Telegram webhook when ingress URL changes
    const onlyVelayPublicBaseUrlChanged = isOnlyVelayPublicBaseUrlChange(event);

    if (
      event.changedKeys.has("ingress") &&
      !onlyVelayPublicBaseUrlChanged &&
      isTelegramConfigured()
    ) {
      reconcileTelegramWebhook(telegramCaches).catch((err) => {
        log.error(
          { err },
          "Failed to reconcile Telegram webhook after ingress URL change",
        );
      });
    }

    if (shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)) {
      syncConfiguredTwilioPhoneNumberWebhooks({
        credentials: credentialCache,
        configFile: configFileCache,
      }).catch((err) => {
        log.warn({ err }, "Twilio webhook sync failed after config change");
      });
    }

    if (event.changedKeys.has("twilio")) {
      maybeStartVelayTunnelForTwilio("twilio config changed");
    }

    if (event.changedKeys.has("slack")) {
      startSlackSocket().catch((err) => {
        log.error(
          { err },
          "Failed to restart Slack Socket Mode after config change",
        );
      });
    }

    // Side effect: re-register email callback when ingress URL changes so
    // the platform callback route points at the new self-hosted URL.
    if (
      event.changedKeys.has("ingress") &&
      !onlyVelayPublicBaseUrlChanged &&
      vellumReady
    ) {
      registerEmailCallbackRoute({
        credentials: credentialCache,
        configFile: configFileCache,
      }).catch((err) => {
        log.error(
          { err },
          "Failed to re-register email callback route after ingress URL change",
        );
      });
    }
  });

  configFileWatcher.start();

  // ── IPC server ──
  const ipcServer = new GatewayIpcServer([
    ...featureFlagRoutes,
    ...contactRoutes,
    ...inviteRoutes,
    ...verificationSessionRoutes,
    ...slackThreadRoutes,
    ...thresholdRoutes,
    ...admissionPolicyRoutes,
    ...channelPermissionRoutes,
    ...trustVerdictRoutes,
    ...guardianDeliveryRoutes,
    ...riskClassificationRoutes,
    ...createLogTailRoutes(config),
    ...trustRulesRoutes,
    ...createVelayRoutes(velayTunnelClient),
    ...createCredentialRequestIpcRoutes(
      config,
      configFileCache,
      credentialCache,
      ensurePublicIngressLiveForCredentialLink,
    ),
  ]);
  ipcServer.start();

  void refreshRouteSchema();

  // ── Backup worker ──
  const backupWorkerHandle = startBackupWorker({
    assistantRuntimeBaseUrl: config.assistantRuntimeBaseUrl,
  });

  emitFlagChanged = () => {
    ipcServer.emit("feature_flags_changed");
    // A `voice-mode` flip (e.g. after a warm-pool claim syncs the assistant's
    // flags) should bring up the Velay tunnel so web live voice can connect
    // without a gateway restart.
    maybeStartVelayTunnelForLiveVoice("voice-mode flag changed");
  };

  const featureFlagWatcher = new FeatureFlagWatcher({
    onChanged: emitFlagChanged,
  });
  featureFlagWatcher.start();

  const remoteFeatureFlagSync = new RemoteFeatureFlagSync({
    credentials: credentialCache,
    onChanged: emitFlagChanged,
  });
  // Bind the ref so the credential-change callback above can force an
  // immediate re-sync when the assistant's `vellum` identity changes
  // (warm-pool claim / key rotation) instead of waiting for the next poll.
  remoteFeatureFlagSyncRef = remoteFeatureFlagSync;
  // Intentionally fire-and-forget: remote flag fetch is best-effort;
  // the gateway continues with registry defaults if it fails.
  void remoteFeatureFlagSync.start();

  // Periodically ship legacy-loopback auth-fallback counts to the daemon
  // telemetry route. Best-effort background work; never blocks auth.
  const authFallbackReporter = new AuthFallbackReporter({
    tracker: loopbackFallbackCountTracker,
    baseUrl: config.assistantRuntimeBaseUrl,
  });
  authFallbackReporter.start();

  // ── Sleep/wake detection ──
  // Detect system sleep/wake transitions and force-reconnect channels
  // that may have stale connections after the OS suspended the process.
  const sleepWakeDetector = new SleepWakeDetector(() => {
    log.info("System wake detected — reconnecting channels");

    // Force-reconnect Slack WebSocket (may be half-open after sleep)
    slackSocketClient?.forceReconnect();

    // Invalidate caches so next read picks up any config changes (e.g. new ngrok URL)
    configFileCache.invalidate();
    credentialCache.invalidate();

    // Immediately refresh remote feature flags so the gateway doesn't run
    // with stale values until the next scheduled poll (up to 5 min away).
    remoteFeatureFlagSync.syncNow().catch((err) => {
      log.error({ err }, "Failed to sync remote feature flags after wake");
    });

    // Re-register Telegram webhook with current ingress URL
    if (telegramReady) {
      reconcileTelegramWebhook(telegramCaches).catch((err) => {
        log.error({ err }, "Failed to reconcile Telegram webhook after wake");
      });
    }
  });
  sleepWakeDetector.start();

  const drainMs = config.shutdownDrainMs;

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    draining = true;
    const shutdownTasks: Promise<void>[] = [];
    sleepWakeDetector.stop();
    backupWorkerHandle.stop();
    credentialWatcher.stop();
    configFileWatcher.stop();
    avatarSyncWatcher.stop();
    featureFlagWatcher.stop();
    remoteFeatureFlagSync.stop();
    // Stop the timer and flush any buffered auth-fallback counts before exit.
    shutdownTasks.push(authFallbackReporter.stop());
    const velayStop = velayTunnelClient?.stop();
    if (velayStop) shutdownTasks.push(velayStop);
    ipcServer.stop();
    telegramDedupCache.stopCleanup();
    whatsappDedupCache.stopCleanup();
    emailDedupCache.stopCleanup();
    if (slackSocketClient) {
      slackSocketClient.stop();
      slackSocketClient = null;
    }
    setTimeout(() => {
      log.info("Drain window elapsed, stopping server");
      void Promise.allSettled(shutdownTasks).then(() => {
        server.stop(true);
        process.exit(0);
      });
    }, drainMs);
  });
}

main();
