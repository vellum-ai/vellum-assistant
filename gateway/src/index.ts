process.title = "vellum-gateway";

import { randomBytes } from "node:crypto";
import { AuthRateLimiter } from "./auth-rate-limiter.js";
import {
  loadOrCreateSigningKey,
  initSigningKey,
} from "./auth/token-service.js";
import { validateEdgeToken, mintServiceToken } from "./auth/token-exchange.js";
import { ConfigFileCache } from "./config-file-cache.js";
import { ConfigFileWatcher } from "./config-file-watcher.js";
import { FeatureFlagWatcher } from "./feature-flag-watcher.js";
import { RemoteFeatureFlagSync } from "./remote-feature-flag-sync.js";
import { loadConfig } from "./config.js";
import { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";
import {
  CredentialWatcher,
  type CredentialChangeEvent,
} from "./credential-watcher.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import {
  createBrowserRelayWebsocketHandler,
  getBrowserRelayWebsocketHandlers,
  type BrowserRelaySocketData,
} from "./http/routes/browser-relay-websocket.js";
import { createTelegramDeliverHandler } from "./http/routes/telegram-deliver.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { createAudioProxyHandler } from "./http/routes/audio-proxy.js";
import { createTwilioVoiceWebhookHandler } from "./http/routes/twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./http/routes/twilio-status-webhook.js";
import { createTwilioConnectActionWebhookHandler } from "./http/routes/twilio-connect-action-webhook.js";
import {
  createTwilioRelayWebsocketHandler,
  getRelayWebsocketHandlers,
} from "./http/routes/twilio-relay-websocket.js";
import { createWhatsAppWebhookHandler } from "./http/routes/whatsapp-webhook.js";
import { createWhatsAppDeliverHandler } from "./http/routes/whatsapp-deliver.js";
import { createEmailWebhookHandler } from "./http/routes/email-webhook.js";
import { createSlackDeliverHandler } from "./http/routes/slack-deliver.js";
import { createOAuthCallbackHandler } from "./http/routes/oauth-callback.js";
import { createPairingProxyHandler } from "./http/routes/pairing-proxy.js";
import {
  createFeatureFlagsGetHandler,
  createFeatureFlagsPatchHandler,
} from "./http/routes/feature-flags.js";
import { createPrivacyConfigPatchHandler } from "./http/routes/privacy-config.js";
import { createChannelVerificationSessionProxyHandler } from "./http/routes/channel-verification-session-proxy.js";
import { createTelegramControlPlaneProxyHandler } from "./http/routes/telegram-control-plane-proxy.js";
import { createTwilioControlPlaneProxyHandler } from "./http/routes/twilio-control-plane-proxy.js";
import { createVercelControlPlaneProxyHandler } from "./http/routes/vercel-control-plane-proxy.js";
import { createContactsControlPlaneProxyHandler } from "./http/routes/contacts-control-plane-proxy.js";
import { createSlackControlPlaneProxyHandler } from "./http/routes/slack-control-plane-proxy.js";
import { createOAuthAppsProxyHandler } from "./http/routes/oauth-apps-proxy.js";
import { createOAuthProvidersProxyHandler } from "./http/routes/oauth-providers-proxy.js";
import { createChannelReadinessProxyHandler } from "./http/routes/channel-readiness-proxy.js";
import { createRuntimeHealthProxyHandler } from "./http/routes/runtime-health-proxy.js";
import { createUpgradeBroadcastProxyHandler } from "./http/routes/upgrade-broadcast-proxy.js";
import {
  createMigrationExportProxyHandler,
  createMigrationImportProxyHandler,
} from "./http/routes/migration-proxy.js";
import { createMigrationRollbackProxyHandler } from "./http/routes/migration-rollback-proxy.js";
import { createWorkspaceCommitProxyHandler } from "./http/routes/workspace-commit-proxy.js";
import { createBrainGraphProxyHandler } from "./http/routes/brain-graph-proxy.js";
import { createLogExportHandler } from "./http/routes/log-export.js";
import {
  createTrustRulesListHandler,
  createTrustRulesAddHandler,
  createTrustRulesUpdateHandler,
  createTrustRulesDeleteHandler,
  createTrustRulesClearHandler,
  createTrustRulesMatchHandler,
  createTrustRulesStarterBundleHandler,
} from "./http/routes/trust-rules.js";
import { getLogger, initLogger } from "./logger.js";
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
import { fetchThreadContext } from "./slack/thread-context.js";
import { fetchDmContext } from "./slack/dm-context.js";
import { handleInbound } from "./handlers/handle-inbound.js";
import { checkAuthRateLimit } from "./http/middleware/rate-limit.js";
import {
  resolveWebviewOrigin,
  handlePreflight,
  withCorsHeaders,
} from "./http/middleware/cors.js";
import {
  createRouter,
  type RouteDefinition,
  type GetClientIp,
} from "./http/router.js";
import { SleepWakeDetector } from "./sleep-wake-detector.js";
import { callTelegramApi } from "./telegram/api.js";
import { fetchImpl } from "./fetch.js";
import { isNewCommand, handleNewCommand } from "./webhook-pipeline.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";
import { registerEmailCallbackRoute } from "./email/register-callback.js";
import { GatewayIpcServer } from "./ipc/server.js";
import { featureFlagRoutes } from "./ipc/feature-flag-handlers.js";

const log = getLogger("main");

function generateTraceId(): string {
  return randomBytes(8).toString("hex");
}

let draining = false;

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

function isBrowserRelaySocketData(
  data: unknown,
): data is BrowserRelaySocketData {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { wsType?: unknown }).wsType === "browser-relay"
  );
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

  // ── TTL caches ──
  // Instantiate caches for credential and config file reads.
  // Handlers read dynamic credentials and config.json values from these
  // caches at call time, with automatic TTL refresh.
  const credentialCache = new CredentialCache();
  const configFileCache = new ConfigFileCache();

  // ── Integration readiness flags ──
  // Track whether each integration has valid credentials so route
  // preconditions can gate requests synchronously. Updated by the
  // credential watcher callback whenever credentials change.
  let telegramReady = false;
  let whatsappReady = false;
  let slackReady = false;
  let vellumReady = false;

  const twilioValidationCaches = {
    credentials: credentialCache,
    configFile: configFileCache,
  };

  const { handler: handleTelegramWebhook, dedupCache: telegramDedupCache } =
    createTelegramWebhookHandler(config, {
      credentials: credentialCache,
      configFile: configFileCache,
    });
  const handleTelegramDeliver = createTelegramDeliverHandler(config, {
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
  const handleTwilioConnectActionWebhook =
    createTwilioConnectActionWebhookHandler(config, twilioValidationCaches);
  const handleTwilioRelayWs = createTwilioRelayWebsocketHandler(config, {
    configFile: configFileCache,
  });
  const handleBrowserRelayWs = createBrowserRelayWebsocketHandler(config);
  const twilioRelayWebsocketHandlers = getRelayWebsocketHandlers();
  const browserRelayWebsocketHandlers = getBrowserRelayWebsocketHandlers();
  const { handler: handleWhatsAppWebhook, dedupCache: whatsappDedupCache } =
    createWhatsAppWebhookHandler(config, {
      credentials: credentialCache,
      configFile: configFileCache,
    });
  const handleWhatsAppDeliver = createWhatsAppDeliverHandler(config, {
    credentials: credentialCache,
    configFile: configFileCache,
  });
  const { handler: handleEmailWebhook, dedupCache: emailDedupCache } =
    createEmailWebhookHandler(config, {
      credentials: credentialCache,
      configFile: configFileCache,
    });
  // Map: "channel:threadTs" -> { messageTs, expiresAt } for replacing approval
  // messages with the bot's follow-up content after an approval button click.
  const pendingApprovalReplacements = new Map<
    string,
    { messageTs: string; expiresAt: number }
  >();

  // Clean up expired entries every 60s
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingApprovalReplacements) {
      if (entry.expiresAt <= now) pendingApprovalReplacements.delete(key);
    }
  }, 60_000);

  const handleSlackDeliver = createSlackDeliverHandler(
    config,
    (threadTs) => {
      slackSocketClient?.trackThread(threadTs);
    },
    { credentials: credentialCache, configFile: configFileCache },
    pendingApprovalReplacements,
  );
  const handleOAuthCallback = createOAuthCallbackHandler(config);
  const pairingProxy = createPairingProxyHandler(config);
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
  const runtimeHealthProxy = createRuntimeHealthProxyHandler(config);
  const upgradeBroadcastProxy = createUpgradeBroadcastProxyHandler(config);
  const migrationExportProxy = createMigrationExportProxyHandler(config);
  const migrationImportProxy = createMigrationImportProxyHandler(config);
  const migrationRollbackProxy = createMigrationRollbackProxyHandler(config);
  const workspaceCommitProxy = createWorkspaceCommitProxyHandler(config);
  const brainGraphProxy = createBrainGraphProxyHandler(config);
  const handleLogExport = createLogExportHandler(config);
  const handleFeatureFlagsGet = createFeatureFlagsGetHandler();
  const handleFeatureFlagsPatch = createFeatureFlagsPatchHandler();
  const handlePrivacyConfigPatch = createPrivacyConfigPatchHandler();
  const handleTrustRulesList = createTrustRulesListHandler();
  const handleTrustRulesAdd = createTrustRulesAddHandler();
  const handleTrustRulesUpdate = createTrustRulesUpdateHandler();
  const handleTrustRulesDelete = createTrustRulesDeleteHandler();
  const handleTrustRulesClear = createTrustRulesClearHandler();
  const handleTrustRulesMatch = createTrustRulesMatchHandler();
  const handleTrustRulesStarterBundle = createTrustRulesStarterBundleHandler();

  const audioProxy = createAudioProxyHandler(config);

  const handleRuntimeProxy = config.runtimeProxyEnabled
    ? createRuntimeProxyHandler(config)
    : null;

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
  const requireSlack = requireConfigured(() => slackReady, "Slack");

  // ── Route table ──
  // Routes are matched top-to-bottom. The first match wins.
  // Auth middleware is applied declaratively per route — no manual
  // requireEdgeAuth/wrapWithAuthFailureTracking calls needed.
  const routes: RouteDefinition[] = [
    // ── Webhooks (unauthenticated, validated by provider-specific mechanisms) ──
    {
      path: "/webhooks/telegram",
      precondition: requireTelegram,
      handler: (req) => handleTelegramWebhook(req),
    },
    {
      path: "/webhooks/twilio/voice",
      handler: (req) => handleTwilioVoiceWebhook(req),
    },
    {
      path: "/webhooks/twilio/status",
      handler: (req) => handleTwilioStatusWebhook(req),
    },
    {
      path: "/webhooks/twilio/connect-action",
      handler: (req) => handleTwilioConnectActionWebhook(req),
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

    // ── Deliver routes (token-tracked) ──
    {
      path: "/deliver/telegram",
      precondition: requireTelegram,
      auth: "track-failures",
      handler: (req) => handleTelegramDeliver(req),
    },
    {
      path: "/deliver/whatsapp",
      precondition: requireWhatsApp,
      auth: "track-failures",
      handler: (req) => handleWhatsAppDeliver(req),
    },
    {
      path: "/deliver/slack",
      precondition: requireSlack,
      auth: "track-failures",
      handler: (req) => handleSlackDeliver(req),
    },

    // ── Pairing (mixed auth) ──
    {
      path: "/pairing/register",
      method: "POST",
      auth: "edge",
      handler: (req) => pairingProxy.handlePairingRegister(req),
    },
    {
      path: "/pairing/request",
      method: "POST",
      auth: "track-failures",
      trackFailureStatuses: [401, 403],
      handler: (req) => pairingProxy.handlePairingRequest(req),
    },
    {
      path: "/pairing/status",
      method: "GET",
      auth: "track-failures",
      trackFailureStatuses: [401, 403],
      handler: (req) => pairingProxy.handlePairingStatus(req),
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
    // ── Contacts/invites control plane ──
    {
      path: "/v1/contacts/invites",
      method: "GET",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleListInvites(req),
    },
    {
      path: "/v1/contacts/invites",
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleCreateInvite(req),
    },
    {
      path: "/v1/contacts/invites/redeem",
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleRedeemInvite(req),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)\/call$/,
      method: "POST",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleCallInvite(req, params[0]),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)$/,
      method: "DELETE",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleRevokeInvite(req, params[0]),
    },
    {
      // Keep DELETE on the invite collection unsupported; only /invites/:id
      // should revoke an invite.
      path: /^\/v1\/contacts\/(?!invites$)([^/]+)$/,
      method: "DELETE",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleDeleteContact(req, params[0]),
    },
    {
      path: /^\/v1\/contacts\/([^/]+)$/,
      method: "GET",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleGetContact(req, params[0]),
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
        return channelVerificationSessionProxy.handleGuardianRefresh(req);
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

    // ── Privacy config (scope-protected) ──
    {
      path: "/v1/config/privacy",
      method: "PATCH",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handlePrivacyConfigPatch(req),
    },
    {
      path: /^\/v1\/assistants\/([^/]+)\/config\/privacy\/$/,
      method: "PATCH",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => handlePrivacyConfigPatch(req),
    },

    // ── Log export ──
    {
      path: "/v1/logs/export",
      method: "POST",
      auth: "edge",
      handler: (req, params, getClientIp) =>
        handleLogExport(req, params, getClientIp),
    },

    // ── Trust rules ──
    {
      path: "/v1/trust-rules/clear",
      method: "POST",
      auth: "edge",
      handler: (req) => handleTrustRulesClear(req),
    },
    {
      path: "/v1/trust-rules/match",
      method: "GET",
      auth: "edge",
      handler: (req) => handleTrustRulesMatch(req),
    },
    {
      path: "/v1/trust-rules/starter-bundle",
      method: "POST",
      auth: "edge",
      handler: (req) => handleTrustRulesStarterBundle(req),
    },
    {
      path: "/v1/trust-rules",
      method: "GET",
      auth: "edge",
      handler: (req) => handleTrustRulesList(req),
    },
    {
      path: "/v1/trust-rules",
      method: "POST",
      auth: "edge",
      handler: (req) => handleTrustRulesAdd(req),
    },
    {
      path: /^\/v1\/trust-rules\/([^/]+)$/,
      method: "PATCH",
      auth: "edge",
      handler: (req, params) => handleTrustRulesUpdate(req, params[0]),
    },
    {
      path: /^\/v1\/trust-rules\/([^/]+)$/,
      method: "DELETE",
      auth: "edge",
      handler: (req, params) => handleTrustRulesDelete(req, params[0]),
    },
  ];

  // The runtime proxy catch-all is only added when the proxy is enabled.
  // It must be last so that all specific routes are checked first.
  if (handleRuntimeProxy) {
    routes.push({
      path: /^\//, // match everything
      auth: "track-failures",
      handler: (req, _params, getClientIp) =>
        handleRuntimeProxy(req, getClientIp()),
    });
  }

  const router = createRouter(routes, {
    authRateLimiter,
  });

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    // Match the daemon's 512 MB limit (assistant/src/runtime/http-server.ts)
    // so large .vbundle imports proxied through the gateway aren't rejected.
    maxRequestBodySize: 512 * 1024 * 1024,
    websocket: {
      open(ws) {
        if (isBrowserRelaySocketData(ws.data)) {
          browserRelayWebsocketHandlers.open(ws as never);
          return;
        }
        twilioRelayWebsocketHandlers.open(ws as never);
      },
      message(ws, message) {
        if (isBrowserRelaySocketData(ws.data)) {
          browserRelayWebsocketHandlers.message(ws as never, message);
          return;
        }
        twilioRelayWebsocketHandlers.message(ws as never, message);
      },
      close(ws, code, reason) {
        if (isBrowserRelaySocketData(ws.data)) {
          browserRelayWebsocketHandlers.close(ws as never, code, reason);
          return;
        }
        twilioRelayWebsocketHandlers.close(ws as never, code, reason);
      },
    },
    error(err) {
      if (err instanceof CircuitBreakerOpenError) {
        return Response.json(
          { error: "Service temporarily unavailable — runtime is unreachable" },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
      }
      log.error({ err }, "Unhandled gateway error");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
    async fetch(req, svr) {
      svr.timeout(req, 1800);
      const url = new URL(req.url);

      // ── CORS: webview preflight & origin tracking ──
      // The macOS WKWebView loads pages from https://{appId}.vellum.local/
      // which is cross-origin to the gateway at http://127.0.0.1:{port}.
      // Reflect the origin back on matched requests so window.vellum.fetch
      // calls succeed.
      const webviewOrigin = resolveWebviewOrigin(req);
      if (webviewOrigin && req.method === "OPTIONS") {
        return handlePreflight(webviewOrigin);
      }

      // ── Pre-router: health/readiness probes ──
      // These bypass rate limiting and tracing for minimal overhead.
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

      if (url.pathname === "/schema") {
        return Response.json(buildSchema());
      }

      if (url.pathname === "/readyz") {
        if (draining) {
          return Response.json({ status: "draining" }, { status: 503 });
        }
        // Check that the upstream assistant is also reachable so callers
        // know the full stack is ready, not just the gateway process.
        try {
          const upstream = await fetch(
            `${config.assistantRuntimeBaseUrl}/readyz`,
            { signal: AbortSignal.timeout(3000) },
          );
          if (!upstream.ok) {
            return Response.json(
              { status: "upstream_unhealthy", upstream: upstream.status },
              { status: 503 },
            );
          }
        } catch {
          return Response.json(
            { status: "upstream_unreachable" },
            { status: 503 },
          );
        }
        return Response.json({ status: "ok" });
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
        if (webviewOrigin)
          return withCorsHeaders(rateLimitResponse, webviewOrigin);
        return rateLimitResponse;
      }

      // ── Pre-router: WebSocket upgrades ──
      // Bun's WS upgrade needs `server.upgrade()` which doesn't return
      // a Response, so these can't go through the route table.
      if (url.pathname === "/webhooks/twilio/relay") {
        const upgradeResult = handleTwilioRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        return undefined as unknown as Response;
      }

      if (config.runtimeProxyEnabled && url.pathname === "/v1/browser-relay") {
        const upgradeResult = handleBrowserRelayWs(req, server);
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
        const response = router(req, url, resolveClientIp, svr);
        if (response !== null) {
          if (webviewOrigin) {
            const resolved = await response;
            return withCorsHeaders(resolved, webviewOrigin);
          }
          return response;
        }
      } catch (err) {
        // Mirror the error() handler logic while retaining CORS context.
        // Bun's error() callback doesn't receive the request, so thrown
        // errors during webview requests would otherwise lose CORS headers.
        if (!webviewOrigin) throw err;
        if (err instanceof CircuitBreakerOpenError) {
          return withCorsHeaders(
            Response.json(
              {
                error:
                  "Service temporarily unavailable \u2014 runtime is unreachable",
              },
              {
                status: 503,
                headers: { "Retry-After": String(err.retryAfterSecs) },
              },
            ),
            webviewOrigin,
          );
        }
        log.error({ err }, "Unhandled gateway error");
        return withCorsHeaders(
          Response.json({ error: "Internal server error" }, { status: 500 }),
          webviewOrigin,
        );
      }

      const notFound = Response.json(
        { error: "Not found", source: "gateway" },
        { status: 404 },
      );
      if (webviewOrigin) return withCorsHeaders(notFound, webviewOrigin);
      return notFound;
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");

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

    slackSocketClient = createSlackSocketModeClient(
      { appToken, botToken, gatewayConfig: config },
      (normalized) => {
        const { threadTs, channel } = normalized;
        const params = new URLSearchParams({ channel });
        if (threadTs) params.set("threadTs", threadTs);
        // For non-threaded DMs, pass the original message ts so the runtime
        // can target it for emoji-based thinking indicators.
        const origMessageTs = normalized.event.source.messageId;
        if (!threadTs && origMessageTs) params.set("messageTs", origMessageTs);
        const replyCallbackUrl = `${config.gatewayInternalBaseUrl}/deliver/slack?${params}`;

        // Check if this is a regular thread reply (not an edit or callback action).
        // Edits and callbacks don't benefit from thread context and would just add
        // unnecessary Slack API traffic + latency.
        const messageTs = normalized.event.source.messageId;
        const isEdit = !!normalized.event.message.isEdit;
        const isCallback = !!normalized.event.message.callbackData;
        const isThreadReply =
          messageTs !== undefined &&
          threadTs !== messageTs &&
          !isEdit &&
          !isCallback;

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
          );
          return;
        }

        const forward = async (threadContextHint?: string) => {
          try {
            const hints: string[] = [];
            if (threadContextHint) hints.push(threadContextHint);

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
                    return uploadAttachment(config, downloaded, {
                      skipCircuitBreaker: true,
                    });
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
              ...(attachmentIds && attachmentIds.length > 0
                ? { attachmentIds }
                : {}),
              ...(hints.length > 0 ? { transportMetadata: { hints } } : {}),
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
              ...(threadContextHint
                ? { transportMetadata: { hints: [threadContextHint] } }
                : {}),
            }).catch((fwdErr) => {
              log.error(
                { err: fwdErr, channel, threadTs },
                "Failed to forward Slack event to runtime (fallback)",
              );
            });
          }
        };

        if (isThreadReply && botToken && threadTs) {
          fetchThreadContext(channel, threadTs, messageTs, botToken)
            .then((context) => context ?? undefined)
            .catch(() => undefined)
            .then((context) => forward(context))
            .catch((err) => {
              log.error(
                { err, channel, threadTs },
                "Unhandled error in Slack forward (thread reply)",
              );
            });
        } else if (
          channel.startsWith("D") &&
          botToken &&
          messageTs &&
          !isEdit &&
          !isCallback
        ) {
          fetchDmContext(channel, messageTs, botToken)
            .then((context) => context ?? undefined)
            .catch(() => undefined)
            .then((context) => forward(context))
            .catch((err) => {
              log.error(
                { err, channel },
                "Unhandled error in Slack forward (DM context)",
              );
            });
        } else {
          forward().catch((err) => {
            log.error(
              { err, channel, threadTs },
              "Unhandled error in Slack forward",
            );
          });
        }

        // When an approval button is clicked, store the approval message ts
        // so the next outbound delivery to this thread replaces the approval
        // message instead of posting a new one.
        const callbackData = normalized.event.message.callbackData;
        if (callbackData?.startsWith("apr:") && messageTs && threadTs) {
          const key = `${channel}:${threadTs}`;
          pendingApprovalReplacements.set(key, {
            messageTs,
            expiresAt: Date.now() + 60_000, // 60s TTL
          });
        }
      },
    );

    slackSocketClient.start().catch((err) => {
      log.error({ err }, "Failed to start Slack Socket Mode client");
    });
    log.info("Slack Socket Mode client started");
  }

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
    }

    // Register email callback route with the platform so inbound email
    // webhooks are forwarded to this gateway (same pattern as Telegram).
    // Fires on initial credential load and whenever vellum credentials change
    // (key rotation, late provisioning).
    if (changed.has("vellum")) {
      registerEmailCallbackRoute({
        credentials: credentialCache,
        configFile: configFileCache,
      }).catch((err) => {
        log.error(
          { err },
          "Failed to register email callback route after credential change",
        );
      });
    }
  });

  // The credential watcher callback handles startup side effects (Telegram
  // webhook reconciliation, Slack Socket Mode) during the initial poll, so no
  // additional post-start triggers are needed here.
  await credentialWatcher.start();

  const configFileWatcher = new ConfigFileWatcher((event) => {
    // Invalidate the config file cache so subsequent reads pick up fresh values
    configFileCache.invalidate();

    // Side effect: reconcile Telegram webhook when ingress URL changes
    if (event.changedKeys.has("ingress") && isTelegramConfigured()) {
      reconcileTelegramWebhook(telegramCaches).catch((err) => {
        log.error(
          { err },
          "Failed to reconcile Telegram webhook after ingress URL change",
        );
      });
    }

    // Side effect: re-register email callback when ingress URL changes so
    // the platform callback route points at the new self-hosted URL.
    if (event.changedKeys.has("ingress") && vellumReady) {
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
  const ipcServer = new GatewayIpcServer(undefined, [...featureFlagRoutes]);
  ipcServer.start();

  const featureFlagWatcher = new FeatureFlagWatcher();
  featureFlagWatcher.start();

  const remoteFeatureFlagSync = new RemoteFeatureFlagSync({
    credentials: credentialCache,
  });
  // Intentionally fire-and-forget: remote flag fetch is best-effort;
  // the gateway continues with registry defaults if it fails.
  void remoteFeatureFlagSync.start();

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
    sleepWakeDetector.stop();
    credentialWatcher.stop();
    configFileWatcher.stop();
    featureFlagWatcher.stop();
    remoteFeatureFlagSync.stop();
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
      server.stop(true);
      process.exit(0);
    }, drainMs);
  });
}

main();
