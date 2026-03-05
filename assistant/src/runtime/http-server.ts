/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Always started on the
 * configured port (default: 7821).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ServerWebSocket } from "bun";

import type { BrowserRelayWebSocketData } from "../browser-extension-relay/server.js";
import { extensionRelayServer } from "../browser-extension-relay/server.js";
import {
  startGuardianActionSweep,
  stopGuardianActionSweep,
} from "../calls/guardian-action-sweep.js";
import type { RelayWebSocketData } from "../calls/relay-server.js";
import {
  activeRelayConnections,
  RelayConnection,
} from "../calls/relay-server.js";
import {
  handleConnectAction,
  handleStatusCallback,
  handleVoiceWebhook,
} from "../calls/twilio-routes.js";
import { parseChannelId } from "../channels/types.js";
import {
  getGatewayInternalBaseUrl,
  hasUngatedHttpAuthDisabled,
  isHttpAuthDisabled,
} from "../config/env.js";
import type { ServerMessage } from "../daemon/ipc-contract.js";
import { PairingStore } from "../daemon/pairing-store.js";
import {
  type Confidence,
  getAttentionStateByConversationIds,
  recordConversationSeenSignal,
  type SignalType,
} from "../memory/conversation-attention-store.js";
import * as conversationStore from "../memory/conversation-store.js";
import * as externalConversationStore from "../memory/external-conversation-store.js";
import {
  consumeCallback,
  consumeCallbackError,
} from "../security/oauth-callback-registry.js";
import { getLogger } from "../util/logger.js";
import { buildAssistantEvent } from "./assistant-event.js";
import { assistantEventHub } from "./assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
// Auth
import { authenticateRequest } from "./auth/middleware.js";
import {
  mintDaemonDeliveryToken,
  mintUiPageToken,
  verifyToken,
} from "./auth/token-service.js";
import { sweepFailedEvents } from "./channel-retry-sweep.js";
import { httpError } from "./http-errors.js";
import type { RouteDefinition } from "./http-router.js";
import { HttpRouter } from "./http-router.js";
// Middleware
import {
  extractBearerToken,
  isLoopbackHost,
  isPrivateNetworkOrigin,
  isPrivateNetworkPeer,
} from "./middleware/auth.js";
import { withErrorHandling } from "./middleware/error-handler.js";
import {
  apiRateLimiter,
  extractClientIp,
  ipRateLimiter,
  rateLimitHeaders,
  rateLimitResponse,
} from "./middleware/rate-limiter.js";
import { withRequestLogging } from "./middleware/request-logger.js";
import {
  cloneRequestWithBody,
  GATEWAY_ONLY_BLOCKED_SUBPATHS,
  GATEWAY_SUBPATH_MAP,
  TWILIO_GATEWAY_WEBHOOK_RE,
  TWILIO_WEBHOOK_RE,
  validateTwilioWebhook,
} from "./middleware/twilio-validation.js";
import {
  handleDeleteSharedApp,
  handleDownloadSharedApp,
  handleGetSharedAppMetadata,
  handleServePage,
  handleShareApp,
} from "./routes/app-routes.js";
import {
  handleConfirm,
  handleListPendingInteractions,
  handleSecret,
  handleTrustRule,
} from "./routes/approval-routes.js";
import {
  handleDeleteAttachment,
  handleGetAttachment,
  handleGetAttachmentContent,
  handleUploadAttachment,
} from "./routes/attachment-routes.js";
import {
  handleGetBrainGraph,
  handleServeBrainGraphUI,
  handleServeHomeBaseUI,
} from "./routes/brain-graph-routes.js";
import {
  handleAnswerCall,
  handleCancelCall,
  handleGetCallStatus,
  handleInstructionCall,
  handleStartCall,
} from "./routes/call-routes.js";
import {
  startCanonicalGuardianExpirySweep,
  stopCanonicalGuardianExpirySweep,
} from "./routes/canonical-guardian-expiry-sweep.js";
import {
  handleGetChannelReadiness,
  handleRefreshChannelReadiness,
} from "./routes/channel-readiness-routes.js";
import {
  handleChannelDeliveryAck,
  handleChannelInbound,
  handleDeleteConversation,
  handleListDeadLetters,
  handleReplayDeadLetters,
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
} from "./routes/channel-routes.js";
import {
  handleGetContact,
  handleListContacts,
  handleMergeContacts,
  handleUpdateContactChannel,
  handleUpsertContact,
  handleVerifyContactChannel,
} from "./routes/contact-routes.js";
import { handleListConversationAttention } from "./routes/conversation-attention-routes.js";
// Route handlers — grouped by domain
import {
  handleGetSuggestion,
  handleListMessages,
  handleSearchConversations,
  handleSendMessage,
} from "./routes/conversation-routes.js";
import { handleDebug } from "./routes/debug-routes.js";
import { handleSubscribeAssistantEvents } from "./routes/events-routes.js";
import { handleGlobalSearch } from "./routes/global-search-routes.js";
import {
  handleGuardianActionDecision,
  handleGuardianActionsPending,
} from "./routes/guardian-action-routes.js";
import { handleGuardianBootstrap } from "./routes/guardian-bootstrap-routes.js";
import { handleGuardianRefresh } from "./routes/guardian-refresh-routes.js";
import { handleGetIdentity, handleHealth } from "./routes/identity-routes.js";
import {
  handleCancelOutbound,
  handleClearSlackChannelConfig,
  handleClearTelegramConfig,
  handleCreateGuardianChallenge,
  handleGetGuardianStatus,
  handleGetSlackChannelConfig,
  handleGetTelegramConfig,
  handleResendOutbound,
  handleRevokeGuardian,
  handleSetSlackChannelConfig,
  handleSetTelegramCommands,
  handleSetTelegramConfig,
  handleSetupTelegram,
  handleStartOutbound,
} from "./routes/integration-routes.js";
import {
  handleCreateInvite,
  handleListInvites,
  handleRedeemInvite,
  handleRevokeInvite,
} from "./routes/invite-routes.js";
import {
  handleMigrationExport,
  handleMigrationImport,
  handleMigrationImportPreflight,
  handleMigrationValidate,
} from "./routes/migration-routes.js";
import type { PairingHandlerContext } from "./routes/pairing-routes.js";
// Extracted route handlers
import {
  handlePairingRegister,
  handlePairingRequest,
  handlePairingStatus,
} from "./routes/pairing-routes.js";
import { handleAddSecret, handleDeleteSecret } from "./routes/secret-routes.js";
import { handleSurfaceAction } from "./routes/surface-action-routes.js";
import {
  handleAddTrustRuleManage,
  handleListTrustRules,
  handleRemoveTrustRuleManage,
  handleUpdateTrustRuleManage,
} from "./routes/trust-rules-routes.js";
import {
  handleAssignTwilioNumber,
  handleClearTwilioCredentials,
  handleDeleteTollfreeVerification,
  handleGetSmsCompliance,
  handleGetTwilioConfig,
  handleListTwilioNumbers,
  handleProvisionTwilioNumber,
  handleReleaseTwilioNumber,
  handleSetTwilioCredentials,
  handleSmsDoctor,
  handleSmsSendTest,
  handleSubmitTollfreeVerification,
  handleUpdateTollfreeVerification,
} from "./routes/twilio-routes.js";

// Re-export for consumers
export { isPrivateAddress } from "./middleware/auth.js";

// Re-export shared types so existing consumers don't need to update imports
export type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
  RuntimeAttachmentMetadata,
  RuntimeHttpServerOptions,
  RuntimeMessageSessionOptions,
  SendMessageDeps,
} from "./http-types.js";

import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
  RuntimeHttpServerOptions,
  SendMessageDeps,
} from "./http-types.js";

const log = getLogger("runtime-http");

const DEFAULT_PORT = 7821;
const DEFAULT_HOSTNAME = "127.0.0.1";

/** Global hard cap on request body size (50 MB). */
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private hostname: string;
  /** Legacy shared secret for pairing routes (not used for delivery or auth). */
  private bearerToken: string | undefined;
  private processMessage?: MessageProcessor;
  private approvalCopyGenerator?: ApprovalCopyGenerator;
  private approvalConversationGenerator?: ApprovalConversationGenerator;
  private guardianActionCopyGenerator?: GuardianActionCopyGenerator;
  private guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator;
  private interfacesDir: string | null;
  private suggestionCache = new Map<string, string>();
  private suggestionInFlight = new Map<string, Promise<string | null>>();
  private retrySweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInProgress = false;
  private pairingStore = new PairingStore();
  private pairingBroadcast?: (msg: ServerMessage) => void;
  private sendMessageDeps?: SendMessageDeps;
  private findSession?: (sessionId: string) =>
    | {
        handleSurfaceAction(
          surfaceId: string,
          actionId: string,
          data?: Record<string, unknown>,
        ): void;
      }
    | undefined;
  private router: HttpRouter;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;
    this.bearerToken = options.bearerToken;
    this.processMessage = options.processMessage;
    this.approvalCopyGenerator = options.approvalCopyGenerator;
    this.approvalConversationGenerator = options.approvalConversationGenerator;
    this.guardianActionCopyGenerator = options.guardianActionCopyGenerator;
    this.guardianFollowUpConversationGenerator =
      options.guardianFollowUpConversationGenerator;
    this.interfacesDir = options.interfacesDir ?? null;
    this.sendMessageDeps = options.sendMessageDeps;
    this.findSession = options.findSession;
    this.router = new HttpRouter(this.buildRouteTable());
  }

  /** The port the server is actually listening on (resolved after start). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  /** Expose the pairing store so the daemon server can wire IPC handlers. */
  getPairingStore(): PairingStore {
    return this.pairingStore;
  }

  /** Set a callback for broadcasting IPC messages (wired by daemon server). */
  setPairingBroadcast(fn: (msg: ServerMessage) => void): void {
    this.pairingBroadcast = fn;
  }

  /** Read the feature-flag client token from disk so it can be included in pairing approval responses. */
  private readFeatureFlagToken(): string | undefined {
    try {
      const baseDir = process.env.BASE_DATA_DIR?.trim() || homedir();
      const tokenPath = join(baseDir, ".vellum", "feature-flag-token");
      const token = readFileSync(tokenPath, "utf-8").trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  private get pairingContext(): PairingHandlerContext {
    const ipcBroadcast = this.pairingBroadcast;
    return {
      pairingStore: this.pairingStore,
      bearerToken: this.bearerToken,
      featureFlagToken: this.readFeatureFlagToken(),
      pairingBroadcast: ipcBroadcast
        ? (msg) => {
            // Broadcast to IPC socket clients (local Unix socket)
            ipcBroadcast(msg);
            // Also publish to the event hub so HTTP/SSE clients (e.g. macOS
            // app with localHttpEnabled) receive pairing approval requests.
            void assistantEventHub.publish(
              buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, msg),
            );
          }
        : undefined,
    };
  }

  async start(): Promise<void> {
    type AllWebSocketData = RelayWebSocketData | BrowserRelayWebSocketData;
    this.server = Bun.serve<AllWebSocketData>({
      port: this.port,
      hostname: this.hostname,
      idleTimeout: 0,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open(ws) {
          const data = ws.data as AllWebSocketData;
          if ("wsType" in data && data.wsType === "browser-relay") {
            extensionRelayServer.handleOpen(
              ws as ServerWebSocket<BrowserRelayWebSocketData>,
            );
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          log.info({ callSessionId }, "ConversationRelay WebSocket opened");
          if (callSessionId) {
            const connection = new RelayConnection(
              ws as ServerWebSocket<RelayWebSocketData>,
              callSessionId,
            );
            activeRelayConnections.set(callSessionId, connection);
          }
        },
        message(ws, message) {
          const data = ws.data as AllWebSocketData;
          const raw =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          if ("wsType" in data && data.wsType === "browser-relay") {
            extensionRelayServer.handleMessage(
              ws as ServerWebSocket<BrowserRelayWebSocketData>,
              raw,
            );
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          if (callSessionId) {
            const connection = activeRelayConnections.get(callSessionId);
            connection?.handleMessage(raw);
          }
        },
        close(ws, code, reason) {
          const data = ws.data as AllWebSocketData;
          if ("wsType" in data && data.wsType === "browser-relay") {
            extensionRelayServer.handleClose(
              ws as ServerWebSocket<BrowserRelayWebSocketData>,
              code,
              reason?.toString(),
            );
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          log.info(
            { callSessionId, code, reason: reason?.toString() },
            "ConversationRelay WebSocket closed",
          );
          if (callSessionId) {
            const connection = activeRelayConnections.get(callSessionId);
            connection?.handleTransportClosed(code, reason?.toString());
            connection?.destroy();
            activeRelayConnections.delete(callSessionId);
          }
        },
      },
    });

    if (this.processMessage) {
      const pm = this.processMessage;
      const mintBt = () => mintDaemonDeliveryToken();
      this.retrySweepTimer = setInterval(() => {
        if (this.sweepInProgress) return;
        this.sweepInProgress = true;
        sweepFailedEvents(pm, mintBt).finally(() => {
          this.sweepInProgress = false;
        });
      }, 30_000);
    }

    startGuardianExpirySweep(
      getGatewayInternalBaseUrl(),
      () => mintDaemonDeliveryToken(),
      this.approvalCopyGenerator,
    );
    log.info("Guardian approval expiry sweep started");

    startGuardianActionSweep(
      getGatewayInternalBaseUrl(),
      () => mintDaemonDeliveryToken(),
      this.guardianActionCopyGenerator,
    );
    log.info("Guardian action expiry sweep started");

    startCanonicalGuardianExpirySweep();
    log.info("Canonical guardian request expiry sweep started");

    log.info(
      "Running in gateway-only ingress mode. Direct webhook routes disabled.",
    );
    if (!isLoopbackHost(this.hostname)) {
      log.warn(
        "RUNTIME_HTTP_HOST is not bound to loopback. This may expose the runtime to direct public access.",
      );
    }

    this.pairingStore.start();

    if (hasUngatedHttpAuthDisabled()) {
      log.warn(
        "DISABLE_HTTP_AUTH is set but VELLUM_UNSAFE_AUTH_BYPASS=1 is not — auth bypass is IGNORED and HTTP authentication remains enabled. Set VELLUM_UNSAFE_AUTH_BYPASS=1 to confirm the bypass.",
      );
    } else if (isHttpAuthDisabled()) {
      log.warn(
        "DISABLE_HTTP_AUTH is set — HTTP API authentication is DISABLED. All API endpoints are accessible without a bearer token. Do not use in production.",
      );
    }

    log.info(
      {
        port: this.actualPort,
        hostname: this.hostname,
        auth: !!this.bearerToken,
      },
      "Runtime HTTP server listening",
    );
  }

  async stop(): Promise<void> {
    this.pairingStore.stop();
    stopGuardianExpirySweep();
    stopGuardianActionSweep();
    stopCanonicalGuardianExpirySweep();
    if (this.retrySweepTimer) {
      clearInterval(this.retrySweepTimer);
      this.retrySweepTimer = null;
    }
    if (this.server) {
      this.server.stop(true);
      this.server = null;
      log.info("Runtime HTTP server stopped");
    }
  }

  private async handleRequest(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Promise<Response> {
    server.timeout(req, 1800);
    // Skip request logging for health-check probes to reduce log noise.
    const url = new URL(req.url);
    if (url.pathname === "/healthz" && req.method === "GET") {
      return this.routeRequest(req, server);
    }
    return withRequestLogging(req, () => this.routeRequest(req, server));
  }

  private async routeRequest(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz" && req.method === "GET") {
      return handleHealth();
    }

    // WebSocket upgrade for the Chrome extension browser relay.
    if (
      path === "/v1/browser-relay" &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.handleBrowserRelayUpgrade(req, server);
    }

    // WebSocket upgrade for ConversationRelay — before auth check because
    // Twilio WebSocket connections don't use bearer tokens.
    if (
      path.startsWith("/v1/calls/relay") &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.handleRelayUpgrade(req, server);
    }

    // Twilio webhook endpoints — before auth check because Twilio
    // webhook POSTs don't include bearer tokens.
    const twilioResponse = await this.handleTwilioWebhook(req, path);
    if (twilioResponse) return twilioResponse;

    // Pairing endpoints (unauthenticated, secret-gated)
    if (path === "/v1/pairing/request" && req.method === "POST") {
      return await handlePairingRequest(req, this.pairingContext);
    }
    if (path === "/v1/pairing/status" && req.method === "GET") {
      return handlePairingStatus(url, this.pairingContext);
    }

    // Guardian bootstrap and refresh endpoints — before JWT auth because
    // bootstrap is the first endpoint called to obtain a JWT, and refresh
    // needs to work when the access token is expired. Bootstrap has its
    // own loopback IP validation; refresh is secured by the refresh token
    // in the request body (32 random bytes, hash-only storage).
    if (
      path === "/v1/integrations/guardian/vellum/bootstrap" &&
      req.method === "POST"
    ) {
      return await handleGuardianBootstrap(req, server);
    }
    if (
      path === "/v1/integrations/guardian/vellum/refresh" &&
      req.method === "POST"
    ) {
      return await handleGuardianRefresh(req);
    }

    // JWT bearer authentication — replaces the old shared-secret comparison.
    // authenticateRequest handles dev bypass (DISABLE_HTTP_AUTH) internally.
    const authResult = authenticateRequest(req);
    if (!authResult.ok) {
      return authResult.response;
    }
    const authContext = authResult.context;

    // Serve shareable app pages (outside /v1/ namespace, no rate limiting)
    const pagesMatch = path.match(/^\/pages\/([^/]+)$/);
    if (pagesMatch && req.method === "GET") {
      return withErrorHandling("pages", async () =>
        handleServePage(pagesMatch[1]),
      );
    }

    // Per-client-IP rate limiting for /v1/* endpoints. Authenticated requests
    // get a higher limit; unauthenticated requests get a lower limit to reduce
    // abuse surface. We key on IP rather than bearer token because the gateway
    // uses a single shared token for all proxied requests, which would collapse
    // all users into one bucket.
    // Skip rate limiting entirely when HTTP auth is disabled (local Docker dev).
    if (!path.startsWith("/v1/")) {
      return httpError("NOT_FOUND", "Not found", 404);
    }

    const endpoint = path.slice("/v1/".length);

    if (!isHttpAuthDisabled()) {
      const clientIp = extractClientIp(req, server);
      const token = extractBearerToken(req);
      const result = token
        ? apiRateLimiter.check(clientIp)
        : ipRateLimiter.check(clientIp);
      if (!result.allowed) {
        return rateLimitResponse(result);
      }
      const routerResponse = await this.router.dispatch(
        endpoint,
        req,
        url,
        server,
        authContext,
      );
      const response =
        routerResponse ?? httpError("NOT_FOUND", "Not found", 404);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(rateLimitHeaders(result))) {
        headers.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const routerResponse = await this.router.dispatch(
      endpoint,
      req,
      url,
      server,
      authContext,
    );
    return routerResponse ?? httpError("NOT_FOUND", "Not found", 404);
  }

  private handleBrowserRelayUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Response {
    if (
      !isLoopbackHost(new URL(req.url).hostname) &&
      !isPrivateNetworkPeer(server, req)
    ) {
      return httpError(
        "FORBIDDEN",
        "Browser relay only accepts connections from localhost",
        403,
      );
    }

    if (!isHttpAuthDisabled()) {
      const wsUrl = new URL(req.url);
      const token = wsUrl.searchParams.get("token");
      if (!token) {
        return httpError("UNAUTHORIZED", "Unauthorized", 401);
      }
      const jwtResult = verifyToken(token, "vellum-daemon");
      if (!jwtResult.ok) {
        return httpError("UNAUTHORIZED", "Unauthorized", 401);
      }
    }

    const connectionId = crypto.randomUUID();
    const upgraded = server.upgrade(req, {
      data: {
        wsType: "browser-relay",
        connectionId,
      } satisfies BrowserRelayWebSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  private handleRelayUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Response {
    if (!isPrivateNetworkPeer(server, req) || !isPrivateNetworkOrigin(req)) {
      return httpError(
        "FORBIDDEN",
        "Direct relay access disabled — only private network peers allowed",
        403,
      );
    }

    const wsUrl = new URL(req.url);
    const callSessionId = wsUrl.searchParams.get("callSessionId");
    if (!callSessionId) {
      return new Response("Missing callSessionId", { status: 400 });
    }
    const upgraded = server.upgrade(req, { data: { callSessionId } });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  private async handleTwilioWebhook(
    req: Request,
    path: string,
  ): Promise<Response | null> {
    const twilioMatch = path.match(TWILIO_WEBHOOK_RE);
    const gatewayTwilioMatch = !twilioMatch
      ? path.match(TWILIO_GATEWAY_WEBHOOK_RE)
      : null;
    const resolvedTwilioSubpath = twilioMatch
      ? twilioMatch[1]
      : gatewayTwilioMatch
        ? GATEWAY_SUBPATH_MAP[gatewayTwilioMatch[1]]
        : null;
    if (!resolvedTwilioSubpath || req.method !== "POST") return null;

    const twilioSubpath = resolvedTwilioSubpath;

    if (GATEWAY_ONLY_BLOCKED_SUBPATHS.has(twilioSubpath)) {
      return httpError(
        "GONE",
        "Direct webhook access disabled. Use the gateway.",
        410,
      );
    }

    const validation = await validateTwilioWebhook(req);
    if (validation instanceof Response) return validation;

    const validatedReq = cloneRequestWithBody(req, validation.body);

    if (twilioSubpath === "voice-webhook")
      return await handleVoiceWebhook(validatedReq);
    if (twilioSubpath === "status")
      return await handleStatusCallback(validatedReq);
    if (twilioSubpath === "connect-action")
      return await handleConnectAction(validatedReq);

    return null;
  }

  private handleGetInterface(interfacePath: string): Response {
    if (!this.interfacesDir) {
      return httpError("NOT_FOUND", "Interface not found", 404);
    }
    const fullPath = resolve(this.interfacesDir, interfacePath);
    if (
      (fullPath !== this.interfacesDir &&
        !fullPath.startsWith(this.interfacesDir + "/")) ||
      !existsSync(fullPath)
    ) {
      return httpError("NOT_FOUND", "Interface not found", 404);
    }
    const source = readFileSync(fullPath, "utf-8");
    return new Response(source, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // ---------------------------------------------------------------------------
  // Declarative route table
  // ---------------------------------------------------------------------------

  /**
   * Build the full set of route definitions. Routes are matched in order,
   * so more specific patterns (e.g. `calls/:id/cancel`) must precede
   * more general ones (e.g. `calls/:id`).
   */
  private buildRouteTable(): RouteDefinition[] {
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

    return [
      // ------------------------------------------------------------------
      // Pairing (authenticated)
      // ------------------------------------------------------------------
      {
        endpoint: "pairing/register",
        method: "POST",
        handler: async ({ req }) =>
          handlePairingRegister(req, this.pairingContext),
      },

      // ------------------------------------------------------------------
      // Apps — cloud sharing
      // ------------------------------------------------------------------
      {
        endpoint: "apps/share",
        method: "POST",
        handler: async ({ req }) => handleShareApp(req),
      },
      {
        endpoint: "apps/shared/:token/metadata",
        method: "GET",
        policyKey: "apps/shared/metadata",
        handler: ({ params }) => handleGetSharedAppMetadata(params.token),
      },
      {
        endpoint: "apps/shared/:token",
        method: "GET",
        policyKey: "apps/shared",
        handler: ({ params }) => handleDownloadSharedApp(params.token),
      },
      {
        endpoint: "apps/shared/:token",
        method: "DELETE",
        policyKey: "apps/shared",
        handler: ({ params }) => handleDeleteSharedApp(params.token),
      },

      // ------------------------------------------------------------------
      // Secrets
      // ------------------------------------------------------------------
      {
        endpoint: "secrets",
        method: "POST",
        handler: async ({ req }) => handleAddSecret(req),
      },
      {
        endpoint: "secrets",
        method: "DELETE",
        handler: async ({ req }) => handleDeleteSecret(req),
      },

      // ------------------------------------------------------------------
      // Health / debug / browser relay
      // ------------------------------------------------------------------
      {
        endpoint: "health",
        method: "GET",
        handler: () => handleHealth(),
      },
      {
        endpoint: "debug",
        method: "GET",
        handler: () => handleDebug(),
      },
      {
        endpoint: "browser-relay/status",
        method: "GET",
        handler: () => Response.json(extensionRelayServer.getStatus()),
      },
      {
        endpoint: "browser-relay/command",
        method: "POST",
        handler: async ({ req }) => {
          const body = (await req.json()) as Record<string, unknown>;
          const resp = await extensionRelayServer.sendCommand(
            body as Omit<
              import("../browser-extension-relay/protocol.js").ExtensionCommand,
              "id"
            >,
          );
          return Response.json(resp);
        },
      },

      // ------------------------------------------------------------------
      // Conversations
      // ------------------------------------------------------------------
      {
        endpoint: "conversations",
        method: "GET",
        handler: ({ url }) => {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const conversations = conversationStore.listConversations(
            limit,
            false,
            offset,
          );
          const totalCount = conversationStore.countConversations();
          const conversationIds = conversations.map((c) => c.id);
          const bindings =
            externalConversationStore.getBindingsForConversations(
              conversationIds,
            );
          const attentionStates =
            getAttentionStateByConversationIds(conversationIds);
          return Response.json({
            sessions: conversations.map((c) => {
              const binding = bindings.get(c.id);
              const originChannel = parseChannelId(c.originChannel);
              const attn = attentionStates.get(c.id);
              const assistantAttention = attn
                ? {
                    hasUnseenLatestAssistantMessage:
                      attn.latestAssistantMessageAt != null &&
                      (attn.lastSeenAssistantMessageAt == null ||
                        attn.lastSeenAssistantMessageAt <
                          attn.latestAssistantMessageAt),
                    ...(attn.latestAssistantMessageAt != null
                      ? {
                          latestAssistantMessageAt:
                            attn.latestAssistantMessageAt,
                        }
                      : {}),
                    ...(attn.lastSeenAssistantMessageAt != null
                      ? {
                          lastSeenAssistantMessageAt:
                            attn.lastSeenAssistantMessageAt,
                        }
                      : {}),
                    ...(attn.lastSeenConfidence != null
                      ? { lastSeenConfidence: attn.lastSeenConfidence }
                      : {}),
                    ...(attn.lastSeenSignalType != null
                      ? { lastSeenSignalType: attn.lastSeenSignalType }
                      : {}),
                  }
                : undefined;
              return {
                id: c.id,
                title: c.title ?? "Untitled",
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                threadType: c.threadType === "private" ? "private" : "standard",
                source: c.source ?? "user",
                ...(binding
                  ? {
                      channelBinding: {
                        sourceChannel: binding.sourceChannel,
                        externalChatId: binding.externalChatId,
                        externalUserId: binding.externalUserId,
                        displayName: binding.displayName,
                        username: binding.username,
                      },
                    }
                  : {}),
                ...(originChannel
                  ? { conversationOriginChannel: originChannel }
                  : {}),
                ...(assistantAttention ? { assistantAttention } : {}),
              };
            }),
            hasMore: offset + conversations.length < totalCount,
          });
        },
      },
      {
        endpoint: "conversations/attention",
        method: "GET",
        handler: ({ url }) => handleListConversationAttention(url),
      },
      {
        endpoint: "conversations/seen",
        method: "POST",
        handler: async ({ req }) => {
          const body = (await req.json()) as Record<string, unknown>;
          const conversationId = body.conversationId as string | undefined;
          if (!conversationId)
            return httpError("BAD_REQUEST", "Missing conversationId", 400);
          try {
            recordConversationSeenSignal({
              conversationId,
              assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
              sourceChannel: (body.sourceChannel as string) ?? "vellum",
              signalType: ((body.signalType as string) ??
                "macos_conversation_opened") as SignalType,
              confidence: ((body.confidence as string) ??
                "explicit") as Confidence,
              source: (body.source as string) ?? "http-api",
              evidenceText: body.evidenceText as string | undefined,
              metadata: body.metadata as Record<string, unknown> | undefined,
              observedAt: body.observedAt as number | undefined,
            });
            return Response.json({ ok: true });
          } catch (err) {
            log.error(
              { err, conversationId },
              "POST /v1/conversations/seen: failed",
            );
            return httpError(
              "INTERNAL_ERROR",
              "Failed to record seen signal",
              500,
            );
          }
        },
      },

      // ------------------------------------------------------------------
      // Messages / search
      // ------------------------------------------------------------------
      {
        endpoint: "messages",
        method: "GET",
        handler: ({ url }) => handleListMessages(url, this.interfacesDir),
      },
      {
        endpoint: "messages",
        method: "POST",
        handler: async ({ req, authContext }) =>
          handleSendMessage(
            req,
            {
              sendMessageDeps: this.sendMessageDeps!,
              approvalConversationGenerator: this.approvalConversationGenerator,
            },
            authContext,
          ),
      },
      {
        endpoint: "search",
        method: "GET",
        handler: ({ url }) => handleSearchConversations(url),
      },
      {
        endpoint: "search/global",
        method: "GET",
        handler: async ({ url }) => handleGlobalSearch(url),
      },

      // ------------------------------------------------------------------
      // Approvals
      // ------------------------------------------------------------------
      {
        endpoint: "confirm",
        method: "POST",
        handler: async ({ req, authContext }) =>
          handleConfirm(req, authContext),
      },
      {
        endpoint: "secret",
        method: "POST",
        handler: async ({ req, authContext }) => handleSecret(req, authContext),
      },
      {
        endpoint: "trust-rules",
        method: "POST",
        handler: async ({ req, authContext }) =>
          handleTrustRule(req, authContext),
      },
      {
        endpoint: "pending-interactions",
        method: "GET",
        handler: ({ url, authContext }) =>
          handleListPendingInteractions(url, authContext),
      },

      // ------------------------------------------------------------------
      // Trust rule CRUD management
      // ------------------------------------------------------------------
      {
        endpoint: "trust-rules/manage",
        method: "GET",
        handler: () => handleListTrustRules(),
      },
      {
        endpoint: "trust-rules/manage",
        method: "POST",
        handler: async ({ req }) => handleAddTrustRuleManage(req),
      },
      {
        endpoint: "trust-rules/manage/:id",
        method: "DELETE",
        handler: ({ params }) => handleRemoveTrustRuleManage(params.id),
      },
      {
        endpoint: "trust-rules/manage/:id",
        method: "PATCH",
        handler: async ({ req, params }) =>
          handleUpdateTrustRuleManage(req, params.id),
      },

      // ------------------------------------------------------------------
      // Surface actions
      // ------------------------------------------------------------------
      {
        endpoint: "surface-actions",
        method: "POST",
        handler: async ({ req }) => {
          if (!this.findSession) {
            return httpError(
              "NOT_IMPLEMENTED",
              "Surface actions not available",
              501,
            );
          }
          return handleSurfaceAction(req, this.findSession);
        },
      },

      // ------------------------------------------------------------------
      // Guardian actions
      // ------------------------------------------------------------------
      {
        endpoint: "guardian-actions/pending",
        method: "GET",
        handler: ({ url, authContext }) =>
          handleGuardianActionsPending(url, authContext),
      },
      {
        endpoint: "guardian-actions/decision",
        method: "POST",
        handler: async ({ req, authContext }) =>
          handleGuardianActionDecision(req, authContext),
      },

      // ------------------------------------------------------------------
      // Contacts
      // ------------------------------------------------------------------
      {
        endpoint: "contacts",
        method: "GET",
        handler: ({ url, authContext }) =>
          handleListContacts(url, authContext.assistantId),
      },
      {
        endpoint: "contacts",
        method: "POST",
        handler: async ({ req, authContext }) =>
          handleUpsertContact(req, authContext.assistantId),
      },
      {
        endpoint: "contacts/merge",
        method: "POST",
        handler: async ({ req, authContext }) =>
          handleMergeContacts(req, authContext.assistantId),
      },
      {
        endpoint: "contacts/channels/:id",
        method: "PATCH",
        policyKey: "contacts/channels",
        handler: async ({ req, params, authContext }) =>
          handleUpdateContactChannel(req, params.id, authContext.assistantId),
      },
      {
        endpoint: "contacts/:contactId/channels/:channelId/verify",
        method: "POST",
        policyKey: "contacts/channels",
        handler: async ({ params, authContext }) =>
          handleVerifyContactChannel(
            params.contactId,
            params.channelId,
            authContext.assistantId,
          ),
      },

      // ------------------------------------------------------------------
      // Contacts invites — must precede contacts/:id to avoid shadowing
      // ------------------------------------------------------------------
      {
        endpoint: "contacts/invites",
        method: "GET",
        handler: ({ url }) => handleListInvites(url),
      },
      {
        endpoint: "contacts/invites",
        method: "POST",
        handler: async ({ req }) => handleCreateInvite(req),
      },
      {
        endpoint: "contacts/invites/redeem",
        method: "POST",
        handler: async ({ req }) => handleRedeemInvite(req),
      },
      {
        endpoint: "contacts/invites/:id",
        method: "DELETE",
        policyKey: "contacts/invites",
        handler: ({ params }) => handleRevokeInvite(params.id),
      },

      {
        endpoint: "contacts/:id",
        method: "GET",
        policyKey: "contacts",
        handler: ({ params, authContext }) =>
          handleGetContact(params.id, authContext.assistantId),
      },

      // ------------------------------------------------------------------
      // Integrations — Telegram
      // ------------------------------------------------------------------
      {
        endpoint: "integrations/telegram/config",
        method: "GET",
        handler: () => handleGetTelegramConfig(),
      },
      {
        endpoint: "integrations/telegram/config",
        method: "POST",
        handler: async ({ req }) => handleSetTelegramConfig(req),
      },
      {
        endpoint: "integrations/telegram/config",
        method: "DELETE",
        handler: async () => handleClearTelegramConfig(),
      },
      {
        endpoint: "integrations/telegram/commands",
        method: "POST",
        handler: async ({ req }) => handleSetTelegramCommands(req),
      },
      {
        endpoint: "integrations/telegram/setup",
        method: "POST",
        handler: async ({ req }) => handleSetupTelegram(req),
      },

      // ------------------------------------------------------------------
      // Integrations — Slack
      // ------------------------------------------------------------------
      {
        endpoint: "integrations/slack/channel/config",
        method: "GET",
        handler: () => handleGetSlackChannelConfig(),
      },
      {
        endpoint: "integrations/slack/channel/config",
        method: "POST",
        handler: async ({ req }) => handleSetSlackChannelConfig(req),
      },
      {
        endpoint: "integrations/slack/channel/config",
        method: "DELETE",
        handler: () => handleClearSlackChannelConfig(),
      },

      // ------------------------------------------------------------------
      // Integrations — Guardian
      // ------------------------------------------------------------------
      {
        endpoint: "integrations/guardian/challenge",
        method: "POST",
        handler: async ({ req }) => handleCreateGuardianChallenge(req),
      },
      {
        endpoint: "integrations/guardian/status",
        method: "GET",
        handler: ({ url }) => handleGetGuardianStatus(url),
      },
      {
        endpoint: "integrations/guardian/revoke",
        method: "POST",
        handler: async ({ req }) => handleRevokeGuardian(req),
      },
      {
        endpoint: "integrations/guardian/outbound/start",
        method: "POST",
        handler: async ({ req }) => handleStartOutbound(req),
      },
      {
        endpoint: "integrations/guardian/outbound/resend",
        method: "POST",
        handler: async ({ req }) => handleResendOutbound(req),
      },
      {
        endpoint: "integrations/guardian/outbound/cancel",
        method: "POST",
        handler: async ({ req }) => handleCancelOutbound(req),
      },

      // ------------------------------------------------------------------
      // Integrations — Twilio
      // ------------------------------------------------------------------
      {
        endpoint: "integrations/twilio/config",
        method: "GET",
        handler: () => handleGetTwilioConfig(),
      },
      {
        endpoint: "integrations/twilio/credentials",
        method: "POST",
        handler: async ({ req }) => handleSetTwilioCredentials(req),
      },
      {
        endpoint: "integrations/twilio/credentials",
        method: "DELETE",
        handler: () => handleClearTwilioCredentials(),
      },
      {
        endpoint: "integrations/twilio/numbers",
        method: "GET",
        handler: async () => handleListTwilioNumbers(),
      },
      {
        endpoint: "integrations/twilio/numbers/provision",
        method: "POST",
        handler: async ({ req }) => handleProvisionTwilioNumber(req),
      },
      {
        endpoint: "integrations/twilio/numbers/assign",
        method: "POST",
        handler: async ({ req }) => handleAssignTwilioNumber(req),
      },
      {
        endpoint: "integrations/twilio/numbers/release",
        method: "POST",
        handler: async ({ req }) => handleReleaseTwilioNumber(req),
      },
      {
        endpoint: "integrations/twilio/sms/compliance",
        method: "GET",
        handler: async () => handleGetSmsCompliance(),
      },
      {
        endpoint: "integrations/twilio/sms/compliance/tollfree",
        method: "POST",
        handler: async ({ req }) => handleSubmitTollfreeVerification(req),
      },
      {
        endpoint: "integrations/twilio/sms/compliance/tollfree/:sid",
        method: "PATCH",
        policyKey: "integrations/twilio/sms/compliance/tollfree",
        handler: async ({ req, params }) =>
          handleUpdateTollfreeVerification(req, params.sid),
      },
      {
        endpoint: "integrations/twilio/sms/compliance/tollfree/:sid",
        method: "DELETE",
        policyKey: "integrations/twilio/sms/compliance/tollfree",
        handler: async ({ params }) =>
          handleDeleteTollfreeVerification(params.sid),
      },
      {
        endpoint: "integrations/twilio/sms/test",
        method: "POST",
        handler: async ({ req }) => handleSmsSendTest(req),
      },
      {
        endpoint: "integrations/twilio/sms/doctor",
        method: "POST",
        handler: async () => handleSmsDoctor(),
      },

      // ------------------------------------------------------------------
      // Channel readiness
      // ------------------------------------------------------------------
      {
        endpoint: "channels/readiness",
        method: "GET",
        handler: async ({ url }) => handleGetChannelReadiness(url),
      },
      {
        endpoint: "channels/readiness/refresh",
        method: "POST",
        handler: async ({ req }) => handleRefreshChannelReadiness(req),
      },

      // ------------------------------------------------------------------
      // Attachments — specific sub-resource routes before generic ones
      // ------------------------------------------------------------------
      {
        endpoint: "attachments",
        method: "POST",
        handler: async ({ req }) => handleUploadAttachment(req),
      },
      {
        endpoint: "attachments",
        method: "DELETE",
        handler: async ({ req }) => handleDeleteAttachment(req),
      },
      {
        endpoint: "attachments/:id/content",
        method: "GET",
        policyKey: "attachments/content",
        handler: ({ req, params }) =>
          handleGetAttachmentContent(params.id, req),
      },
      {
        endpoint: "attachments/:id",
        method: "GET",
        policyKey: "attachments",
        handler: ({ params }) => handleGetAttachment(params.id),
      },

      // ------------------------------------------------------------------
      // Suggestion
      // ------------------------------------------------------------------
      {
        endpoint: "suggestion",
        method: "GET",
        handler: async ({ url }) =>
          handleGetSuggestion(url, {
            suggestionCache: this.suggestionCache,
            suggestionInFlight: this.suggestionInFlight,
          }),
      },

      // ------------------------------------------------------------------
      // Interfaces
      // ------------------------------------------------------------------
      {
        endpoint: "interfaces/:path*",
        method: "GET",
        policyKey: "interfaces",
        handler: ({ params }) => this.handleGetInterface(params.path),
      },

      // ------------------------------------------------------------------
      // Channel operations
      // ------------------------------------------------------------------
      {
        endpoint: "channels/conversation",
        method: "DELETE",
        handler: async ({ req }) => handleDeleteConversation(req, assistantId),
      },
      {
        endpoint: "channels/inbound",
        method: "POST",
        handler: async ({ req }) =>
          handleChannelInbound(
            req,
            this.processMessage,
            assistantId,
            this.approvalCopyGenerator,
            this.approvalConversationGenerator,
            this.guardianActionCopyGenerator,
            this.guardianFollowUpConversationGenerator,
          ),
      },
      {
        endpoint: "channels/delivery-ack",
        method: "POST",
        handler: async ({ req }) => handleChannelDeliveryAck(req),
      },
      {
        endpoint: "channels/dead-letters",
        method: "GET",
        handler: () => handleListDeadLetters(),
      },
      {
        endpoint: "channels/replay",
        method: "POST",
        handler: async ({ req }) => handleReplayDeadLetters(req),
      },

      // ------------------------------------------------------------------
      // Calls — specific sub-actions before the generic calls/:id route
      // ------------------------------------------------------------------
      {
        endpoint: "calls/start",
        method: "POST",
        handler: async ({ req }) => handleStartCall(req, assistantId),
      },
      {
        endpoint: "calls/:id/cancel",
        method: "POST",
        policyKey: "calls/cancel",
        handler: async ({ req, params }) => handleCancelCall(req, params.id),
      },
      {
        endpoint: "calls/:id/answer",
        method: "POST",
        policyKey: "calls/answer",
        handler: async ({ req, params }) => handleAnswerCall(req, params.id),
      },
      {
        endpoint: "calls/:id/instruction",
        method: "POST",
        policyKey: "calls/instruction",
        handler: async ({ req, params }) =>
          handleInstructionCall(req, params.id),
      },
      {
        endpoint: "calls/:id",
        method: "GET",
        policyKey: "calls",
        handler: ({ params }) => handleGetCallStatus(params.id),
      },

      // ------------------------------------------------------------------
      // Internal Twilio forwarding (gateway -> runtime)
      // ------------------------------------------------------------------
      {
        endpoint: "internal/twilio/voice-webhook",
        method: "POST",
        handler: async ({ req }) => {
          const json = (await req.json()) as {
            params: Record<string, string>;
            originalUrl?: string;
          };
          const formBody = new URLSearchParams(json.params).toString();
          const reconstructedUrl = json.originalUrl ?? req.url;
          const fakeReq = new Request(reconstructedUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody,
          });
          return handleVoiceWebhook(fakeReq);
        },
      },
      {
        endpoint: "internal/twilio/status",
        method: "POST",
        handler: async ({ req }) => {
          const json = (await req.json()) as {
            params: Record<string, string>;
          };
          const formBody = new URLSearchParams(json.params).toString();
          const fakeReq = new Request(req.url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody,
          });
          return handleStatusCallback(fakeReq);
        },
      },
      {
        endpoint: "internal/twilio/connect-action",
        method: "POST",
        handler: async ({ req }) => {
          const json = (await req.json()) as {
            params: Record<string, string>;
          };
          const formBody = new URLSearchParams(json.params).toString();
          const fakeReq = new Request(req.url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody,
          });
          return handleConnectAction(fakeReq);
        },
      },

      // ------------------------------------------------------------------
      // Identity / brain graph / UIs / events
      // ------------------------------------------------------------------
      {
        endpoint: "identity",
        method: "GET",
        handler: () => handleGetIdentity(),
      },
      {
        endpoint: "brain-graph",
        method: "GET",
        handler: () => handleGetBrainGraph(),
      },
      {
        endpoint: "brain-graph-ui",
        method: "GET",
        handler: () => handleServeBrainGraphUI(mintUiPageToken()),
      },
      {
        endpoint: "home-base-ui",
        method: "GET",
        handler: () => handleServeHomeBaseUI(mintUiPageToken()),
      },
      {
        endpoint: "events",
        method: "GET",
        handler: ({ req, url, authContext }) =>
          handleSubscribeAssistantEvents(req, url, { authContext }),
      },

      // ------------------------------------------------------------------
      // Migrations
      // ------------------------------------------------------------------
      {
        endpoint: "migrations/validate",
        method: "POST",
        handler: async ({ req }) => handleMigrationValidate(req),
      },
      {
        endpoint: "migrations/export",
        method: "POST",
        handler: async ({ req }) => handleMigrationExport(req),
      },
      {
        endpoint: "migrations/import-preflight",
        method: "POST",
        handler: async ({ req }) => handleMigrationImportPreflight(req),
      },
      {
        endpoint: "migrations/import",
        method: "POST",
        handler: async ({ req }) => handleMigrationImport(req),
      },

      // ------------------------------------------------------------------
      // Internal OAuth callback (gateway -> runtime)
      // ------------------------------------------------------------------
      {
        endpoint: "internal/oauth/callback",
        method: "POST",
        handler: async ({ req }) => {
          const json = (await req.json()) as {
            state: string;
            code?: string;
            error?: string;
          };
          if (!json.state)
            return httpError("BAD_REQUEST", "Missing state parameter", 400);
          if (json.error) {
            const consumed = consumeCallbackError(json.state, json.error);
            return consumed
              ? Response.json({ ok: true })
              : httpError("NOT_FOUND", "Unknown state", 404);
          }
          if (json.code) {
            const consumed = consumeCallback(json.state, json.code);
            return consumed
              ? Response.json({ ok: true })
              : httpError("NOT_FOUND", "Unknown state", 404);
          }
          return httpError(
            "BAD_REQUEST",
            "Missing code or error parameter",
            400,
          );
        },
      },
    ];
  }
}
