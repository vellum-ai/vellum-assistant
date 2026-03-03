process.title = "vellum-gateway";

import { randomBytes } from "node:crypto";
import { AuthRateLimiter } from "./auth-rate-limiter.js";
import { loadOrCreateSigningKey, initSigningKey } from "./auth/token-service.js";
import { validateEdgeToken } from "./auth/token-exchange.js";
import { resolveScopeProfile } from "./auth/scopes.js";
import type { Scope } from "./auth/types.js";
import { ConfigFileWatcher } from "./config-file-watcher.js";
import { loadConfig, isSlackChannelConfigured } from "./config.js";
import { CredentialWatcher } from "./credential-watcher.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import {
  createBrowserRelayWebsocketHandler,
  getBrowserRelayWebsocketHandlers,
  type BrowserRelaySocketData,
} from "./http/routes/browser-relay-websocket.js";
import { createTelegramDeliverHandler } from "./http/routes/telegram-deliver.js";
import { createTelegramReconcileHandler } from "./http/routes/telegram-reconcile.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { createTwilioVoiceWebhookHandler } from "./http/routes/twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./http/routes/twilio-status-webhook.js";
import { createTwilioConnectActionWebhookHandler } from "./http/routes/twilio-connect-action-webhook.js";
import { createTwilioRelayWebsocketHandler, getRelayWebsocketHandlers } from "./http/routes/twilio-relay-websocket.js";
import { createTwilioSmsWebhookHandler } from "./http/routes/twilio-sms-webhook.js";
import { createSmsDeliverHandler } from "./http/routes/sms-deliver.js";
import { createWhatsAppWebhookHandler } from "./http/routes/whatsapp-webhook.js";
import { createWhatsAppDeliverHandler } from "./http/routes/whatsapp-deliver.js";
import { createSlackDeliverHandler } from "./http/routes/slack-deliver.js";
import { createOAuthCallbackHandler } from "./http/routes/oauth-callback.js";
import { createA2AProxyHandler } from "./http/routes/a2a-proxy.js";
import { createA2AInboundHandler } from "./http/routes/a2a-inbound.js";
import { createPairingProxyHandler } from "./http/routes/pairing-proxy.js";
import { createFeatureFlagsGetHandler, createFeatureFlagsPatchHandler } from "./http/routes/feature-flags.js";
import { createGuardianControlPlaneProxyHandler } from "./http/routes/guardian-control-plane-proxy.js";
import { createTelegramControlPlaneProxyHandler } from "./http/routes/telegram-control-plane-proxy.js";
import { createIngressControlPlaneProxyHandler } from "./http/routes/ingress-control-plane-proxy.js";
import { matchIngressControlPlaneRoute } from "./http/routes/ingress-control-plane-route-match.js";
import { createTwilioControlPlaneProxyHandler } from "./http/routes/twilio-control-plane-proxy.js";
import { createChannelReadinessProxyHandler } from "./http/routes/channel-readiness-proxy.js";
import { createRuntimeHealthProxyHandler } from "./http/routes/runtime-health-proxy.js";
import { createBrainGraphProxyHandler } from "./http/routes/brain-graph-proxy.js";
import { getLogger, initLogger } from "./logger.js";
import { CircuitBreakerOpenError } from "./runtime/client.js";
import { buildSchema } from "./schema.js";
import { createSlackSocketModeClient, type SlackSocketModeClient } from "./slack/socket-mode.js";
import { handleInbound } from "./handlers/handle-inbound.js";
import { callTelegramApi } from "./telegram/api.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";

const log = getLogger("main");

function generateTraceId(): string {
  return randomBytes(8).toString("hex");
}

let draining = false;

// Shared rate limiter for auth failures and unauthenticated endpoints
const authRateLimiter = new AuthRateLimiter();

// Per-IP rate limiter for A2A connect requests (10 per minute)
const a2aConnectRateLimiter = new AuthRateLimiter(10, 60_000);

function isBrowserRelaySocketData(data: unknown): data is BrowserRelaySocketData {
  return !!data && typeof data === "object" && (data as { wsType?: unknown }).wsType === "browser-relay";
}

function getClientIp(req: Request, server: ReturnType<typeof Bun.serve>, trustProxy: boolean): string {
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

function main() {
  const config = loadConfig();
  initLogger(config.logFile);

  log.info("Starting Vellum Gateway...");

  // Initialize the JWT signing key shared with the daemon.
  // This must happen before any request handling.
  const signingKey = loadOrCreateSigningKey();
  initSigningKey(signingKey);
  log.info("JWT signing key initialized");

  const { handler: handleTelegramWebhook, dedupCache: telegramDedupCache } = createTelegramWebhookHandler(config);
  const handleTelegramDeliver = createTelegramDeliverHandler(config);
  const handleTelegramReconcile = createTelegramReconcileHandler(config);

  const isTelegramConfigured = () =>
    !!(config.telegramBotToken && config.telegramWebhookSecret);

  const isWhatsAppConfigured = () =>
    !!(config.whatsappPhoneNumberId && config.whatsappAccessToken);

  const handleTwilioVoiceWebhook = createTwilioVoiceWebhookHandler(config);
  const handleTwilioStatusWebhook = createTwilioStatusWebhookHandler(config);
  const handleTwilioConnectActionWebhook = createTwilioConnectActionWebhookHandler(config);
  const handleTwilioRelayWs = createTwilioRelayWebsocketHandler(config);
  const handleBrowserRelayWs = createBrowserRelayWebsocketHandler(config);
  const twilioRelayWebsocketHandlers = getRelayWebsocketHandlers();
  const browserRelayWebsocketHandlers = getBrowserRelayWebsocketHandlers();
  const { handler: handleTwilioSmsWebhook, dedupCache: smsDedupCache } = createTwilioSmsWebhookHandler(config);
  const handleSmsDeliver = createSmsDeliverHandler(config);
  const { handler: handleWhatsAppWebhook, dedupCache: whatsappDedupCache } = createWhatsAppWebhookHandler(config);
  const handleWhatsAppDeliver = createWhatsAppDeliverHandler(config);
  const handleSlackDeliver = createSlackDeliverHandler(config);
  const handleOAuthCallback = createOAuthCallbackHandler(config);
  const a2aProxy = createA2AProxyHandler(config);
  const a2aInbound = createA2AInboundHandler(config);
  const pairingProxy = createPairingProxyHandler(config);
  const guardianControlPlaneProxy = createGuardianControlPlaneProxyHandler(config);
  const telegramControlPlaneProxy = createTelegramControlPlaneProxyHandler(config);
  const ingressControlPlaneProxy = createIngressControlPlaneProxyHandler(config);
  const twilioControlPlaneProxy = createTwilioControlPlaneProxyHandler(config);
  const channelReadinessProxy = createChannelReadinessProxyHandler(config);
  const runtimeHealthProxy = createRuntimeHealthProxyHandler(config);
  const brainGraphProxy = createBrainGraphProxyHandler(config);
  const handleFeatureFlagsGet = createFeatureFlagsGetHandler();
  const handleFeatureFlagsPatch = createFeatureFlagsPatchHandler();

  const handleRuntimeProxy = config.runtimeProxyEnabled
    ? createRuntimeProxyHandler(config)
    : null;

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
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
          { status: 503, headers: { "Retry-After": String(err.retryAfterSecs) } },
        );
      }
      log.error({ err }, "Unhandled gateway error");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
    async fetch(req, svr) {
      svr.timeout(req, 1800);
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/schema") {
        return Response.json(buildSchema());
      }

      if (url.pathname === "/readyz") {
        if (draining) {
          return Response.json({ status: "draining" }, { status: 503 });
        }
        return Response.json({ status: "ok" });
      }

      // Rate-limit check for auth-protected, pairing, and unauthenticated
      // endpoints that forward to the runtime (OAuth callback is publicly
      // reachable and forwards every valid-looking request).
      const isRateLimitedRoute = url.pathname === "/integrations/status" ||
        url.pathname === "/deliver/telegram" ||
        url.pathname === "/deliver/sms" ||
        url.pathname === "/deliver/whatsapp" ||
        url.pathname === "/deliver/slack" ||
        url.pathname.startsWith("/pairing/") ||
        url.pathname === "/webhooks/oauth/callback" ||
        (url.pathname.startsWith("/v1/") &&
          url.pathname !== "/v1/calls/twilio/voice-webhook" &&
          url.pathname !== "/v1/calls/twilio/status" &&
          url.pathname !== "/v1/calls/twilio/connect-action" &&
          url.pathname !== "/v1/browser-relay" &&
          url.pathname !== "/v1/calls/relay");
      if (isRateLimitedRoute) {
        const clientIp = getClientIp(req, svr, config.trustProxy);
        if (authRateLimiter.isBlocked(clientIp)) {
          log.warn({ ip: clientIp, path: url.pathname }, "Auth rate limit exceeded");
          return Response.json(
            { error: "Too many failed attempts. Try again later." },
            { status: 429, headers: { "Retry-After": "60" } },
          );
        }
      }

      // Attach a trace ID to every non-healthcheck request for
      // end-to-end correlation across webhook → runtime → reply.
      const traceId = req.headers.get("x-trace-id") || generateTraceId();
      const headers = new Headers(req.headers);
      headers.set("x-trace-id", traceId);
      const tracedReq = new Request(req, { headers });

      if (url.pathname === "/internal/telegram/reconcile") {
        return handleTelegramReconcile(tracedReq);
      }

      if (url.pathname === "/webhooks/telegram") {
        if (!isTelegramConfigured()) {
          return Response.json(
            { error: "Telegram integration not configured" },
            { status: 503 },
          );
        }
        return handleTelegramWebhook(tracedReq);
      }

      if (url.pathname === "/deliver/telegram") {
        if (!isTelegramConfigured()) {
          return Response.json(
            { error: "Telegram integration not configured" },
            { status: 503 },
          );
        }
        const res = await handleTelegramDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (
        url.pathname === "/webhooks/twilio/voice" ||
        url.pathname === "/v1/calls/twilio/voice-webhook"
      ) {
        return handleTwilioVoiceWebhook(tracedReq);
      }

      if (
        url.pathname === "/webhooks/twilio/status" ||
        url.pathname === "/v1/calls/twilio/status"
      ) {
        return handleTwilioStatusWebhook(tracedReq);
      }

      if (
        url.pathname === "/webhooks/twilio/connect-action" ||
        url.pathname === "/v1/calls/twilio/connect-action"
      ) {
        return handleTwilioConnectActionWebhook(tracedReq);
      }

      if (url.pathname === "/webhooks/twilio/sms") {
        return handleTwilioSmsWebhook(tracedReq);
      }

      if (url.pathname === "/deliver/sms") {
        const res = await handleSmsDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/webhooks/whatsapp") {
        if (!isWhatsAppConfigured()) {
          return Response.json(
            { error: "WhatsApp integration not configured" },
            { status: 503 },
          );
        }
        return handleWhatsAppWebhook(tracedReq);
      }

      if (url.pathname === "/deliver/whatsapp") {
        if (!isWhatsAppConfigured()) {
          return Response.json(
            { error: "WhatsApp integration not configured" },
            { status: 503 },
          );
        }
        const res = await handleWhatsAppDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/deliver/slack") {
        if (!config.slackChannelBotToken) {
          return Response.json(
            { error: "Slack integration not configured" },
            { status: 503 },
          );
        }
        const res = await handleSlackDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/webhooks/twilio/relay" || url.pathname === "/v1/calls/relay") {
        const upgradeResult = handleTwilioRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        // If upgrade was handled, Bun doesn't need a response
        return undefined as unknown as Response;
      }

      if (config.runtimeProxyEnabled && url.pathname === "/v1/browser-relay") {
        const upgradeResult = handleBrowserRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        // If upgrade was handled, Bun doesn't need a response
        return undefined as unknown as Response;
      }

      if (url.pathname === "/webhooks/oauth/callback" && tracedReq.method === "GET") {
        const res = await handleOAuthCallback(tracedReq);
        if (res.status === 400) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      /**
       * Validate a JWT bearer token (aud=vellum-gateway) for client-facing routes.
       * Returns null on success, or a Response to short-circuit with.
       */
      function requireEdgeAuth(): Response | null {
        const authHeader = tracedReq.headers.get("authorization");
        if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const result = validateEdgeToken(token);
        if (!result.ok) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return null;
      }

      /**
       * Validate a JWT bearer token and check that its scope profile
       * includes a specific scope. Returns null on success.
       */
      function requireEdgeAuthWithScope(scope: Scope): Response | null {
        const authHeader = tracedReq.headers.get("authorization");
        if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const result = validateEdgeToken(token);
        if (!result.ok) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const scopes = resolveScopeProfile(result.claims.scope_profile);
        if (!scopes.has(scope)) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        return null;
      }

      // ── Runtime health proxy ──
      if (url.pathname === "/v1/health" && req.method === "GET") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return runtimeHealthProxy.handleRuntimeHealth(tracedReq);
      }

      // ── Brain graph proxy ──
      if (url.pathname === "/v1/brain-graph" && req.method === "GET") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return brainGraphProxy.handleBrainGraph(tracedReq);
      }
      if (url.pathname === "/v1/brain-graph-ui" && req.method === "GET") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return brainGraphProxy.handleBrainGraphUI(tracedReq);
      }
      if (url.pathname === "/v1/home-base-ui" && req.method === "GET") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return brainGraphProxy.handleHomeBaseUI(tracedReq);
      }

      // ── Telegram integration control-plane proxy ──
      if (
        (url.pathname === "/v1/integrations/telegram/config" && req.method === "GET")
        || (url.pathname === "/v1/integrations/telegram/config" && req.method === "POST")
        || (url.pathname === "/v1/integrations/telegram/config" && req.method === "DELETE")
        || (url.pathname === "/v1/integrations/telegram/commands" && req.method === "POST")
        || (url.pathname === "/v1/integrations/telegram/setup" && req.method === "POST")
      ) {
        const authError = requireEdgeAuth();
        if (authError) return authError;

        if (url.pathname === "/v1/integrations/telegram/config" && req.method === "GET") {
          return telegramControlPlaneProxy.handleGetTelegramConfig(tracedReq);
        }
        if (url.pathname === "/v1/integrations/telegram/config" && req.method === "POST") {
          return telegramControlPlaneProxy.handleSetTelegramConfig(tracedReq);
        }
        if (url.pathname === "/v1/integrations/telegram/config" && req.method === "DELETE") {
          return telegramControlPlaneProxy.handleClearTelegramConfig(tracedReq);
        }
        if (url.pathname === "/v1/integrations/telegram/commands") {
          return telegramControlPlaneProxy.handleSetTelegramCommands(tracedReq);
        }
        return telegramControlPlaneProxy.handleSetupTelegram(tracedReq);
      }

      // ── Ingress members/invites control-plane proxy ──
      const ingressRoute = matchIngressControlPlaneRoute(url.pathname, req.method);
      if (ingressRoute) {
        const authError = requireEdgeAuth();
        if (authError) return authError;

        switch (ingressRoute.kind) {
          case "listMembers":
            return ingressControlPlaneProxy.handleListMembers(tracedReq);
          case "upsertMember":
            return ingressControlPlaneProxy.handleUpsertMember(tracedReq);
          case "blockMember":
            return ingressControlPlaneProxy.handleBlockMember(tracedReq, ingressRoute.memberId);
          case "revokeMember":
            return ingressControlPlaneProxy.handleRevokeMember(tracedReq, ingressRoute.memberId);
          case "listInvites":
            return ingressControlPlaneProxy.handleListInvites(tracedReq);
          case "createInvite":
            return ingressControlPlaneProxy.handleCreateInvite(tracedReq);
          case "redeemInvite":
            return ingressControlPlaneProxy.handleRedeemInvite(tracedReq);
          case "revokeInvite":
            return ingressControlPlaneProxy.handleRevokeInvite(tracedReq, ingressRoute.inviteId);
        }
      }

      // ── Guardian vellum bootstrap (actor token) ──
      if (url.pathname === "/v1/integrations/guardian/vellum/bootstrap" && req.method === "POST") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return guardianControlPlaneProxy.handleGuardianVellumBootstrap(tracedReq);
      }

      // ── Guardian verification control-plane proxy ──
      if (
        (url.pathname === "/v1/integrations/guardian/challenge" && req.method === "POST")
        || (url.pathname === "/v1/integrations/guardian/status" && req.method === "GET")
        || (url.pathname === "/v1/integrations/guardian/revoke" && req.method === "POST")
        || (url.pathname === "/v1/integrations/guardian/outbound/start" && req.method === "POST")
        || (url.pathname === "/v1/integrations/guardian/outbound/resend" && req.method === "POST")
        || (url.pathname === "/v1/integrations/guardian/outbound/cancel" && req.method === "POST")
      ) {
        const authError = requireEdgeAuth();
        if (authError) return authError;

        if (url.pathname === "/v1/integrations/guardian/challenge") {
          return guardianControlPlaneProxy.handleCreateGuardianChallenge(tracedReq);
        }
        if (url.pathname === "/v1/integrations/guardian/status") {
          return guardianControlPlaneProxy.handleGetGuardianStatus(tracedReq);
        }
        if (url.pathname === "/v1/integrations/guardian/revoke") {
          return guardianControlPlaneProxy.handleRevokeGuardian(tracedReq);
        }
        if (url.pathname === "/v1/integrations/guardian/outbound/start") {
          return guardianControlPlaneProxy.handleStartGuardianOutbound(tracedReq);
        }
        if (url.pathname === "/v1/integrations/guardian/outbound/resend") {
          return guardianControlPlaneProxy.handleResendGuardianOutbound(tracedReq);
        }
        return guardianControlPlaneProxy.handleCancelGuardianOutbound(tracedReq);
      }

      // ── Guardian vellum refresh proxy ──
      // Accept expired-but-otherwise-valid JWTs on the refresh path.
      // The refresh endpoint's purpose is to obtain a new access token,
      // so rejecting expired tokens here would create a deadlock once
      // the JWT expires. Signature, audience, and policy epoch are still
      // verified — only the expiration check is relaxed.
      if (url.pathname === "/v1/integrations/guardian/vellum/refresh" && req.method === "POST") {
        const authHeader = tracedReq.headers.get("authorization");
        if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const result = validateEdgeToken(token, { allowExpired: true });
        if (!result.ok) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return guardianControlPlaneProxy.handleGuardianRefresh(tracedReq);
      }

      // ── Twilio integration control-plane proxy ──
      if (
        (url.pathname === "/v1/integrations/twilio/config" && req.method === "GET")
        || (url.pathname === "/v1/integrations/twilio/credentials" && req.method === "POST")
        || (url.pathname === "/v1/integrations/twilio/credentials" && req.method === "DELETE")
        || (url.pathname === "/v1/integrations/twilio/numbers" && req.method === "GET")
        || (url.pathname === "/v1/integrations/twilio/numbers/provision" && req.method === "POST")
        || (url.pathname === "/v1/integrations/twilio/numbers/assign" && req.method === "POST")
        || (url.pathname === "/v1/integrations/twilio/numbers/release" && req.method === "POST")
        || (url.pathname === "/v1/integrations/twilio/sms/compliance" && req.method === "GET")
        || (url.pathname === "/v1/integrations/twilio/sms/compliance/tollfree" && req.method === "POST")
        || (url.pathname === "/v1/integrations/twilio/sms/test" && req.method === "POST")
        || (url.pathname === "/v1/integrations/twilio/sms/doctor" && req.method === "POST")
      ) {
        const authError = requireEdgeAuth();
        if (authError) return authError;

        if (url.pathname === "/v1/integrations/twilio/config" && req.method === "GET") {
          return twilioControlPlaneProxy.handleGetTwilioConfig(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/credentials" && req.method === "POST") {
          return twilioControlPlaneProxy.handleSetTwilioCredentials(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/credentials" && req.method === "DELETE") {
          return twilioControlPlaneProxy.handleClearTwilioCredentials(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/numbers" && req.method === "GET") {
          return twilioControlPlaneProxy.handleListTwilioNumbers(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/numbers/provision") {
          return twilioControlPlaneProxy.handleProvisionTwilioNumber(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/numbers/assign") {
          return twilioControlPlaneProxy.handleAssignTwilioNumber(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/numbers/release") {
          return twilioControlPlaneProxy.handleReleaseTwilioNumber(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/sms/compliance" && req.method === "GET") {
          return twilioControlPlaneProxy.handleGetSmsCompliance(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/sms/compliance/tollfree") {
          return twilioControlPlaneProxy.handleSubmitTollfreeVerification(tracedReq);
        }
        if (url.pathname === "/v1/integrations/twilio/sms/test") {
          return twilioControlPlaneProxy.handleSmsSendTest(tracedReq);
        }
        return twilioControlPlaneProxy.handleSmsDoctor(tracedReq);
      }

      // ── Twilio tollfree verification dynamic path routes ──
      const tollfreeVerificationMatch = url.pathname.match(
        /^\/v1\/integrations\/twilio\/sms\/compliance\/tollfree\/([^/]+)$/,
      );
      if (tollfreeVerificationMatch && (req.method === "PATCH" || req.method === "DELETE")) {
        const authError = requireEdgeAuth();
        if (authError) return authError;

        const verificationSid = decodeURIComponent(tollfreeVerificationMatch[1]);
        if (req.method === "PATCH") {
          return twilioControlPlaneProxy.handleUpdateTollfreeVerification(tracedReq, verificationSid);
        }
        return twilioControlPlaneProxy.handleDeleteTollfreeVerification(tracedReq, verificationSid);
      }

      // ── Channel readiness proxy ──
      if (
        (url.pathname === "/v1/channels/readiness" && req.method === "GET")
        || (url.pathname === "/v1/channels/readiness/refresh" && req.method === "POST")
      ) {
        const authError = requireEdgeAuth();
        if (authError) return authError;

        if (url.pathname === "/v1/channels/readiness" && req.method === "GET") {
          return channelReadinessProxy.handleGetChannelReadiness(tracedReq);
        }
        return channelReadinessProxy.handleRefreshChannelReadiness(tracedReq);
      }

      if (url.pathname === "/integrations/status" && req.method === "GET") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return Response.json({
          email: {
            address: config.assistantEmail ?? null,
          },
        });
      }

      // ── Pairing proxy ──
      // Register requires bearer auth (privileged operation from CLI/macOS)
      if (url.pathname === "/pairing/register" && tracedReq.method === "POST") {
        const authError = requireEdgeAuth();
        if (authError) return authError;
        return pairingProxy.handlePairingRegister(tracedReq);
      }
      // Request and status are unauthenticated at the gateway (secret-gated)
      // Record auth failures when the daemon rejects the pairing secret
      if (url.pathname === "/pairing/request" && tracedReq.method === "POST") {
        const res = await pairingProxy.handlePairingRequest(tracedReq);
        if (res.status === 401 || res.status === 403) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }
      if (url.pathname === "/pairing/status" && tracedReq.method === "GET") {
        const res = await pairingProxy.handlePairingStatus(tracedReq);
        if (res.status === 401 || res.status === 403) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      // ── A2A peer handshake proxy ──
      // These endpoints are public-facing (unauthenticated at gateway level).
      // The connect endpoint is invite-token-gated; verify/status occur during
      // the handshake before credentials are exchanged.
      if (url.pathname === "/v1/a2a/connect" && tracedReq.method === "POST") {
        const connectClientIp = getClientIp(req, svr, config.trustProxy);
        if (a2aConnectRateLimiter.isBlocked(connectClientIp)) {
          log.warn({ ip: connectClientIp }, "A2A connect rate limit exceeded");
          return Response.json(
            { error: { code: "RATE_LIMITED", message: "Too Many Requests" } },
            { status: 429, headers: { "Retry-After": "60" } },
          );
        }
        a2aConnectRateLimiter.recordFailure(connectClientIp);
        const res = await a2aProxy.handleConnect(tracedReq, connectClientIp);
        if (res.status === 401 || res.status === 403) {
          authRateLimiter.recordFailure(connectClientIp);
        }
        return res;
      }
      if (url.pathname === "/v1/a2a/verify" && tracedReq.method === "POST") {
        const verifyClientIp = getClientIp(req, svr, config.trustProxy);
        const res = await a2aProxy.handleVerify(tracedReq, verifyClientIp);
        if (res.status === 401 || res.status === 403) {
          authRateLimiter.recordFailure(verifyClientIp);
        }
        return res;
      }
      const a2aStatusMatch = url.pathname.match(/^\/v1\/a2a\/connections\/([^/]+)\/status$/);
      if (a2aStatusMatch && tracedReq.method === "GET") {
        const statusClientIp = getClientIp(req, svr, config.trustProxy);
        return a2aProxy.handleConnectionStatus(tracedReq, decodeURIComponent(a2aStatusMatch[1]), statusClientIp);
      }
      // A2A inbound message endpoint (peer assistant -> gateway -> runtime).
      // Authenticated via HMAC-SHA256 A2A headers (not gateway JWT).
      if (url.pathname === "/v1/a2a/messages/inbound" && tracedReq.method === "POST") {
        const inboundClientIp = getClientIp(req, svr, config.trustProxy);
        return a2aInbound.handleA2AInbound(tracedReq, inboundClientIp);
      }

      // A2A revocation notification endpoint (peer assistant -> gateway -> runtime).
      // Authenticated via HMAC-SHA256 A2A headers (not gateway JWT).
      if (url.pathname === "/v1/a2a/revoke-notify" && tracedReq.method === "POST") {
        const revokeNotifyClientIp = getClientIp(req, svr, config.trustProxy);
        return a2aInbound.handleA2ARevokeNotify(tracedReq, revokeNotifyClientIp);
      }

      // ── Feature flags API ──
      // Feature flag access is scope-based: actor_client_v1 includes
      // feature_flags.read/write. No separate feature flag token needed.
      if (url.pathname === "/v1/feature-flags" && req.method === "GET") {
        const authError = requireEdgeAuthWithScope('feature_flags.read');
        if (authError) return authError;
        return handleFeatureFlagsGet(tracedReq);
      }

      const featureFlagPatchMatch = url.pathname.match(/^\/v1\/feature-flags\/(.+)$/);
      if (featureFlagPatchMatch && req.method === "PATCH") {
        const authError = requireEdgeAuthWithScope('feature_flags.write');
        if (authError) return authError;
        let flagKey: string;
        try {
          flagKey = decodeURIComponent(featureFlagPatchMatch[1]);
        } catch {
          return Response.json({ error: "Invalid flag key encoding" }, { status: 400 });
        }
        return handleFeatureFlagsPatch(tracedReq, flagKey);
      }

      if (handleRuntimeProxy) {
        const res = await handleRuntimeProxy(tracedReq, getClientIp(req, svr, config.trustProxy));
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      return Response.json({ error: "Not found", source: "gateway" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");

  // Start periodic background cleanup for dedup caches
  telegramDedupCache.startCleanup();
  smsDedupCache.startCleanup();
  whatsappDedupCache.startCleanup();

  function registerTelegramCommands(): void {
    callTelegramApi(config, "setMyCommands", {
      commands: [
        { command: "new", description: "Start a new conversation" },
        { command: "help", description: "Show available commands" },
      ],
    }).catch((err) => {
      log.error({ err }, "Failed to register Telegram bot commands");
    });
  }

  if (isTelegramConfigured()) {
    registerTelegramCommands();
    reconcileTelegramWebhook(config).catch((err) => {
      log.error({ err }, "Failed to reconcile Telegram webhook on startup");
    });
  }

  // ── Slack Socket Mode lifecycle ──
  let slackSocketClient: SlackSocketModeClient | null = null;

  function startSlackSocket(): void {
    if (slackSocketClient) {
      slackSocketClient.stop();
      slackSocketClient = null;
    }
    if (!isSlackChannelConfigured(config)) return;

    slackSocketClient = createSlackSocketModeClient(
      {
        appToken: config.slackChannelAppToken!,
        botToken: config.slackChannelBotToken!,
        gatewayConfig: config,
      },
      (normalized) => {
        const { threadTs, channel } = normalized;
        const replyCallbackUrl =
          `${config.gatewayInternalBaseUrl}/deliver/slack?threadTs=${encodeURIComponent(threadTs)}&channel=${encodeURIComponent(channel)}`;

        handleInbound(config, normalized.event, {
          replyCallbackUrl,
          routingOverride: normalized.routing,
        }).catch((err) => {
          log.error({ err, channel, threadTs }, "Failed to forward Slack event to runtime");
        });
      },
    );

    slackSocketClient.start().catch((err) => {
      log.error({ err }, "Failed to start Slack Socket Mode client");
    });
    log.info("Slack Socket Mode client started");
  }

  if (isSlackChannelConfigured(config)) {
    startSlackSocket();
  }

  const telegramFromEnv = isTelegramConfigured();
  const slackFromEnv = !!(process.env.SLACK_CHANNEL_BOT_TOKEN && process.env.SLACK_CHANNEL_APP_TOKEN);

  const credentialWatcher = new CredentialWatcher((event) => {
    if (event.telegramChanged && !telegramFromEnv) {
      if (event.telegramCredentials) {
        config.telegramBotToken = event.telegramCredentials.botToken;
        config.telegramWebhookSecret = event.telegramCredentials.webhookSecret;
        log.info("Telegram credentials loaded from credential vault");
        registerTelegramCommands();
        reconcileTelegramWebhook(config).catch((err) => {
          log.error({ err }, "Failed to reconcile Telegram webhook after credential change");
        });
      } else {
        config.telegramBotToken = undefined;
        config.telegramWebhookSecret = undefined;
        log.info("Telegram credentials cleared");
      }
    }

    if (event.twilioChanged) {
      if (event.twilioCredentials) {
        config.twilioAccountSid = event.twilioCredentials.accountSid;
        config.twilioAuthToken = event.twilioCredentials.authToken;
        log.info("Twilio credentials loaded from credential vault");
      } else {
        config.twilioAccountSid = undefined;
        config.twilioAuthToken = undefined;
        log.info("Twilio credentials cleared");
      }
    }

    if (event.whatsappChanged) {
      if (event.whatsappCredentials) {
        config.whatsappPhoneNumberId = event.whatsappCredentials.phoneNumberId;
        config.whatsappAccessToken = event.whatsappCredentials.accessToken;
        config.whatsappAppSecret = event.whatsappCredentials.appSecret;
        config.whatsappWebhookVerifyToken = event.whatsappCredentials.webhookVerifyToken;
        log.info("WhatsApp credentials loaded from credential vault");
      } else {
        config.whatsappPhoneNumberId = undefined;
        config.whatsappAccessToken = undefined;
        config.whatsappAppSecret = undefined;
        config.whatsappWebhookVerifyToken = undefined;
        log.info("WhatsApp credentials cleared");
      }
    }

    if (event.slackChannelChanged && !slackFromEnv) {
      if (event.slackChannelCredentials) {
        config.slackChannelBotToken = event.slackChannelCredentials.botToken;
        config.slackChannelAppToken = event.slackChannelCredentials.appToken;
        log.info("Slack channel credentials loaded from credential vault");
      } else {
        config.slackChannelBotToken = undefined;
        config.slackChannelAppToken = undefined;
        log.info("Slack channel credentials cleared");
      }
      startSlackSocket();
    }
  });

  credentialWatcher.start();

  const configFileWatcher = new ConfigFileWatcher((event) => {
    if (event.smsPhoneNumberChanged) {
      config.twilioPhoneNumber = event.smsPhoneNumber;
    }

    if (event.assistantPhoneNumbersChanged) {
      config.assistantPhoneNumbers = event.assistantPhoneNumbers;
    }

    if (event.assistantEmailChanged) {
      config.assistantEmail = event.assistantEmail;
    }

    if (event.ingressChanged) {
      config.ingressPublicBaseUrl = event.ingressPublicBaseUrl;
      if (isTelegramConfigured()) {
        reconcileTelegramWebhook(config).catch((err) => {
          log.error({ err }, "Failed to reconcile Telegram webhook after ingress URL change");
        });
      }
    }
  });

  configFileWatcher.start();

  const drainMs = config.shutdownDrainMs;

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    draining = true;
    credentialWatcher.stop();
    configFileWatcher.stop();
    telegramDedupCache.stopCleanup();
    smsDedupCache.stopCleanup();
    whatsappDedupCache.stopCleanup();
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
