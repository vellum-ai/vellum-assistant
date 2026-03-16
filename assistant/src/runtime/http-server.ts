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
import type { ServerMessage } from "../daemon/message-protocol.js";
import { PairingStore } from "../daemon/pairing-store.js";
import {
  type Confidence,
  getAttentionStateByConversationIds,
  markConversationUnread,
  recordConversationSeenSignal,
  type SignalType,
} from "../memory/conversation-attention-store.js";
import {
  getConversation,
  getDisplayMetaForConversations,
} from "../memory/conversation-crud.js";
import { resolveConversationId } from "../memory/conversation-key-store.js";
import {
  countConversations,
  listConversations,
} from "../memory/conversation-queries.js";
import * as externalConversationStore from "../memory/external-conversation-store.js";
import {
  consumeCallback,
  consumeCallbackError,
} from "../security/oauth-callback-registry.js";
import { UserError } from "../util/errors.js";
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
import { acpRouteDefinitions } from "./routes/acp-routes.js";
import { appManagementRouteDefinitions } from "./routes/app-management-routes.js";
import { handleServePage } from "./routes/app-routes.js";
import { appRouteDefinitions } from "./routes/app-routes.js";
import { approvalRouteDefinitions } from "./routes/approval-routes.js";
import { attachmentRouteDefinitions } from "./routes/attachment-routes.js";
import { avatarRouteDefinitions } from "./routes/avatar-routes.js";
import { brainGraphRouteDefinitions } from "./routes/brain-graph-routes.js";
import { btwRouteDefinitions } from "./routes/btw-routes.js";
import { callRouteDefinitions } from "./routes/call-routes.js";
import {
  startCanonicalGuardianExpirySweep,
  stopCanonicalGuardianExpirySweep,
} from "./routes/canonical-guardian-expiry-sweep.js";
import { channelReadinessRouteDefinitions } from "./routes/channel-readiness-routes.js";
import {
  channelRouteDefinitions,
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
} from "./routes/channel-routes.js";
import { channelVerificationRouteDefinitions } from "./routes/channel-verification-routes.js";
import {
  contactCatchAllRouteDefinitions,
  contactRouteDefinitions,
} from "./routes/contact-routes.js";
import { conversationAttentionRouteDefinitions } from "./routes/conversation-attention-routes.js";
import { conversationManagementRouteDefinitions } from "./routes/conversation-management-routes.js";
import { conversationQueryRouteDefinitions } from "./routes/conversation-query-routes.js";
import { conversationRouteDefinitions } from "./routes/conversation-routes.js";
import { debugRouteDefinitions } from "./routes/debug-routes.js";
import { diagnosticsRouteDefinitions } from "./routes/diagnostics-routes.js";
import { documentRouteDefinitions } from "./routes/documents-routes.js";
import { eventsRouteDefinitions } from "./routes/events-routes.js";
import { globalSearchRouteDefinitions } from "./routes/global-search-routes.js";
import { guardianActionRouteDefinitions } from "./routes/guardian-action-routes.js";
import { handleGuardianBootstrap } from "./routes/guardian-bootstrap-routes.js";
import { handleGuardianRefresh } from "./routes/guardian-refresh-routes.js";
import { hostBashRouteDefinitions } from "./routes/host-bash-routes.js";
import { hostCuRouteDefinitions } from "./routes/host-cu-routes.js";
import { hostFileRouteDefinitions } from "./routes/host-file-routes.js";
import { handleHealth } from "./routes/identity-routes.js";
import { identityRouteDefinitions } from "./routes/identity-routes.js";
import { slackChannelRouteDefinitions } from "./routes/integrations/slack/channel.js";
import { slackShareRouteDefinitions } from "./routes/integrations/slack/share.js";
import { telegramRouteDefinitions } from "./routes/integrations/telegram.js";
import { twilioRouteDefinitions } from "./routes/integrations/twilio.js";
import { inviteRouteDefinitions } from "./routes/invite-routes.js";
import { logExportRouteDefinitions } from "./routes/log-export-routes.js";
import { memoryItemRouteDefinitions } from "./routes/memory-item-routes.js";
import { migrationRouteDefinitions } from "./routes/migration-routes.js";
import type { PairingHandlerContext } from "./routes/pairing-routes.js";
import {
  handlePairingRequest,
  handlePairingStatus,
  pairingRouteDefinitions,
} from "./routes/pairing-routes.js";
import { recordingRouteDefinitions } from "./routes/recording-routes.js";
import { scheduleRouteDefinitions } from "./routes/schedule-routes.js";
import { secretRouteDefinitions } from "./routes/secret-routes.js";
import { settingsRouteDefinitions } from "./routes/settings-routes.js";
import { skillRouteDefinitions } from "./routes/skills-routes.js";
import { subagentRouteDefinitions } from "./routes/subagents-routes.js";
import { surfaceActionRouteDefinitions } from "./routes/surface-action-routes.js";
import { surfaceContentRouteDefinitions } from "./routes/surface-content-routes.js";
import { threadStarterRouteDefinitions } from "./routes/thread-starter-routes.js";
import { trustRulesRouteDefinitions } from "./routes/trust-rules-routes.js";
import { usageRouteDefinitions } from "./routes/usage-routes.js";
import { watchRouteDefinitions } from "./routes/watch-routes.js";
import { workItemRouteDefinitions } from "./routes/work-items-routes.js";
import { workspaceRouteDefinitions } from "./routes/workspace-routes.js";

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
  RuntimeMessageConversationOptions,
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
  private findConversation?: RuntimeHttpServerOptions["findConversation"];
  private findConversationBySurfaceId?: RuntimeHttpServerOptions["findConversationBySurfaceId"];
  private getSkillContext?: RuntimeHttpServerOptions["getSkillContext"];
  private conversationManagementDeps?: RuntimeHttpServerOptions["conversationManagementDeps"];
  private getModelSetContext?: RuntimeHttpServerOptions["getModelSetContext"];
  private getWatchDeps?: RuntimeHttpServerOptions["getWatchDeps"];
  private getRecordingDeps?: RuntimeHttpServerOptions["getRecordingDeps"];
  private getCesClient?: RuntimeHttpServerOptions["getCesClient"];
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
    this.findConversation = options.findConversation;
    this.findConversationBySurfaceId = options.findConversationBySurfaceId;
    this.getSkillContext = options.getSkillContext;
    this.conversationManagementDeps = options.conversationManagementDeps;
    this.getModelSetContext = options.getModelSetContext;
    this.getWatchDeps = options.getWatchDeps;
    this.getRecordingDeps = options.getRecordingDeps;
    this.getCesClient = options.getCesClient;
    this.router = new HttpRouter(this.buildRouteTable());
  }

  /** The port the server is actually listening on (resolved after start). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  /** Expose the pairing store so the daemon server can wire HTTP handlers. */
  getPairingStore(): PairingStore {
    return this.pairingStore;
  }

  /** Set a callback for broadcasting server messages (wired by daemon server). */
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
    const broadcast = this.pairingBroadcast;
    return {
      pairingStore: this.pairingStore,
      bearerToken: this.bearerToken,
      featureFlagToken: this.readFeatureFlagToken(),
      pairingBroadcast: broadcast
        ? (msg) => {
            // Broadcast to all clients via the event hub so HTTP/SSE clients
            // (e.g. macOS app) receive pairing approval requests.
            broadcast(msg);
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
    if (path === "/v1/guardian/init" && req.method === "POST") {
      return await handleGuardianBootstrap(req, server);
    }
    if (path === "/v1/guardian/refresh" && req.method === "POST") {
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

    // Strip trailing slashes so routes match regardless of whether the
    // caller includes one (e.g. platform proxy paths use Django's trailing-
    // slash convention, so the gateway may forward paths with a trailing /).
    const endpoint = path.slice("/v1/".length).replace(/\/$/, "");

    if (!isHttpAuthDisabled()) {
      const clientIp = extractClientIp(req, server);
      const token = extractBearerToken(req);
      const limiter = token ? apiRateLimiter : ipRateLimiter;
      const limiterKind = token ? "authenticated" : "unauthenticated";
      const result = limiter.check(clientIp, path);
      if (!result.allowed) {
        return rateLimitResponse(result, {
          clientIp,
          deniedPath: path,
          limiterKind: limiterKind as "authenticated" | "unauthenticated",
          pathCounts: limiter.getRecentPathCounts(clientIp),
        });
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
   *
   * Each domain's routes are defined in their own module under
   * `./routes/` and composed here via spread. The composition order
   * preserves the original top-to-bottom matching semantics.
   */
  private buildRouteTable(): RouteDefinition[] {
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

    return [
      ...pairingRouteDefinitions({
        getPairingContext: () => this.pairingContext,
      }),
      ...appRouteDefinitions(),
      ...appManagementRouteDefinitions(),
      ...secretRouteDefinitions({
        getCesClient: this.getCesClient,
      }),
      ...identityRouteDefinitions(),
      ...debugRouteDefinitions(),
      ...usageRouteDefinitions(),
      ...workspaceRouteDefinitions(),
      ...memoryItemRouteDefinitions(),
      ...threadStarterRouteDefinitions(),
      ...settingsRouteDefinitions(),
      ...avatarRouteDefinitions(),
      ...scheduleRouteDefinitions({
        sendMessageDeps: this.sendMessageDeps,
      }),
      ...diagnosticsRouteDefinitions(),
      ...logExportRouteDefinitions(),
      ...documentRouteDefinitions(),
      ...workItemRouteDefinitions(
        this.sendMessageDeps
          ? {
              getOrCreateConversation: (conversationId) =>
                this.sendMessageDeps!.getOrCreateConversation(conversationId),
              findConversation: this.findConversation
                ? (conversationId) => {
                    const s = this.findConversation!(conversationId);
                    if (!s || !("abort" in s)) return undefined;
                    return s as import("../daemon/conversation.js").Conversation;
                  }
                : undefined,
            }
          : undefined,
      ),
      ...acpRouteDefinitions(),
      ...subagentRouteDefinitions(),
      ...conversationQueryRouteDefinitions({
        getModelSetContext: this.getModelSetContext,
        findConversationForQueue: this.findConversation
          ? (id) => {
              const s = this.findConversation!(id);
              if (!s?.removeQueuedMessage) return undefined;
              return { removeQueuedMessage: s.removeQueuedMessage.bind(s) };
            }
          : undefined,
      }),

      // Browser relay — not extracted into a domain module because
      // these two routes depend on the in-process extensionRelayServer
      // singleton which is only available here.
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

      // Conversation list and seen signal — kept inline because they
      // depend on multiple cross-cutting stores that aren't grouped
      // into a single domain module.
      {
        endpoint: "conversations",
        method: "GET",
        handler: ({ url }) => {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const conversations = listConversations(limit, false, offset);
          const totalCount = countConversations();
          const conversationIds = conversations.map((c) => c.id);
          const displayMeta = getDisplayMetaForConversations(conversationIds);
          const bindings =
            externalConversationStore.getBindingsForConversations(
              conversationIds,
            );
          const attentionStates =
            getAttentionStateByConversationIds(conversationIds);
          return Response.json({
            conversations: conversations.map((c) => {
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
                conversationType:
                  c.conversationType === "private" ? "private" : "standard",
                source: c.source ?? "user",
                ...(c.scheduleJobId ? { scheduleJobId: c.scheduleJobId } : {}),
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
                ...(displayMeta.get(c.id)?.isPinned
                  ? {
                      isPinned: true,
                      displayOrder: displayMeta.get(c.id)!.displayOrder,
                    }
                  : displayMeta.get(c.id)?.displayOrder != null
                    ? {
                        displayOrder: displayMeta.get(c.id)!.displayOrder,
                      }
                    : {}),
              };
            }),
            hasMore: offset + conversations.length < totalCount,
          });
        },
      },
      ...conversationAttentionRouteDefinitions(),

      ...(this.conversationManagementDeps
        ? conversationManagementRouteDefinitions(
            this.conversationManagementDeps,
          )
        : []),

      {
        endpoint: "conversations/seen",
        method: "POST",
        handler: async ({ req }) => {
          const body = (await req.json()) as Record<string, unknown>;
          const rawConversationId = body.conversationId as string | undefined;
          if (!rawConversationId)
            return httpError("BAD_REQUEST", "Missing conversationId", 400);
          // The client may send a conversation key rather than the internal
          // conversation ID. Resolve to the internal ID to satisfy FK constraints.
          const conversationId = resolveConversationId(rawConversationId);
          if (!conversationId)
            return httpError(
              "NOT_FOUND",
              `Unknown conversation: ${rawConversationId}`,
              404,
            );
          try {
            recordConversationSeenSignal({
              conversationId,
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

      {
        endpoint: "conversations/unread",
        method: "POST",
        handler: async ({ req }) => {
          const body = (await req.json()) as Record<string, unknown>;
          const rawConversationId = body.conversationId as string | undefined;
          if (!rawConversationId)
            return httpError("BAD_REQUEST", "Missing conversationId", 400);
          const conversationId = resolveConversationId(rawConversationId);
          if (!conversationId)
            return httpError(
              "NOT_FOUND",
              `Unknown conversation: ${rawConversationId}`,
              404,
            );
          try {
            markConversationUnread(conversationId);
            return Response.json({ ok: true });
          } catch (err) {
            if (err instanceof UserError) {
              return httpError("UNPROCESSABLE_ENTITY", err.message, 422);
            }
            log.error(
              { err, conversationId },
              "POST /v1/conversations/unread: failed",
            );
            return httpError(
              "INTERNAL_ERROR",
              "Failed to mark conversation unread",
              500,
            );
          }
        },
      },

      // conversations/:id must be registered AFTER all literal conversations/<word>
      // routes above (attention, seen, unread) so the parameterized :id does not
      // shadow them.
      {
        endpoint: "conversations/:id",
        method: "GET",
        handler: ({ params }) => {
          const conversation = getConversation(params.id);
          if (!conversation) {
            return httpError(
              "NOT_FOUND",
              `Conversation ${params.id} not found`,
              404,
            );
          }
          const bindings =
            externalConversationStore.getBindingsForConversations([
              conversation.id,
            ]);
          const attentionStates = getAttentionStateByConversationIds([
            conversation.id,
          ]);
          const binding = bindings.get(conversation.id);
          const originChannel = parseChannelId(conversation.originChannel);
          const attn = attentionStates.get(conversation.id);
          const assistantAttention = attn
            ? {
                hasUnseenLatestAssistantMessage:
                  attn.latestAssistantMessageAt != null &&
                  (attn.lastSeenAssistantMessageAt == null ||
                    attn.lastSeenAssistantMessageAt <
                      attn.latestAssistantMessageAt),
                ...(attn.latestAssistantMessageAt != null
                  ? {
                      latestAssistantMessageAt: attn.latestAssistantMessageAt,
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
          return Response.json({
            conversation: {
              id: conversation.id,
              title: conversation.title ?? "Untitled",
              createdAt: conversation.createdAt,
              updatedAt: conversation.updatedAt,
              conversationType:
                conversation.conversationType === "private"
                  ? "private"
                  : "standard",
              source: conversation.source ?? "user",
              ...(conversation.scheduleJobId
                ? { scheduleJobId: conversation.scheduleJobId }
                : {}),
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
            },
          });
        },
      },

      ...btwRouteDefinitions({
        sendMessageDeps: this.sendMessageDeps,
      }),

      ...conversationRouteDefinitions({
        interfacesDir: this.interfacesDir,
        sendMessageDeps: this.sendMessageDeps,
        approvalConversationGenerator: this.approvalConversationGenerator,
        suggestionCache: this.suggestionCache,
        suggestionInFlight: this.suggestionInFlight,
      }),
      ...globalSearchRouteDefinitions(),
      ...approvalRouteDefinitions(),
      ...hostBashRouteDefinitions(),
      ...hostCuRouteDefinitions(),
      ...hostFileRouteDefinitions(),
      ...(this.getSkillContext
        ? skillRouteDefinitions({
            getSkillContext: this.getSkillContext,
          })
        : []),
      ...trustRulesRouteDefinitions(),
      ...surfaceActionRouteDefinitions({
        findConversation: this.findConversation,
        findConversationBySurfaceId: this.findConversationBySurfaceId,
      }),
      ...surfaceContentRouteDefinitions({
        findConversation: this.findConversation,
      }),
      ...guardianActionRouteDefinitions(),

      ...contactRouteDefinitions(),
      ...inviteRouteDefinitions(),
      // contacts/:id catch-all must follow invite routes to avoid shadowing
      ...contactCatchAllRouteDefinitions(),

      ...telegramRouteDefinitions(),
      ...channelVerificationRouteDefinitions(),
      ...slackChannelRouteDefinitions(),
      ...slackShareRouteDefinitions(),
      ...twilioRouteDefinitions(),
      ...channelReadinessRouteDefinitions(),
      ...attachmentRouteDefinitions(),

      ...(this.getWatchDeps
        ? watchRouteDefinitions({
            getWatchDeps: this.getWatchDeps,
          })
        : []),
      ...(this.getRecordingDeps
        ? recordingRouteDefinitions({
            getRecordingDeps: this.getRecordingDeps,
          })
        : []),

      {
        endpoint: "interfaces/:path*",
        method: "GET",
        policyKey: "interfaces",
        handler: ({ params }) => this.handleGetInterface(params.path),
      },

      ...channelRouteDefinitions({
        assistantId,
        processMessage: this.processMessage,
        approvalCopyGenerator: this.approvalCopyGenerator,
        approvalConversationGenerator: this.approvalConversationGenerator,
        guardianActionCopyGenerator: this.guardianActionCopyGenerator,
        guardianFollowUpConversationGenerator:
          this.guardianFollowUpConversationGenerator,
      }),
      ...callRouteDefinitions({ assistantId }),

      // Internal Twilio forwarding (gateway -> runtime) — kept inline
      // because these reconstruct fake form-encoded requests from JSON,
      // a pattern specific to the gateway-to-daemon bridge.
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

      ...brainGraphRouteDefinitions({ mintUiPageToken }),
      ...eventsRouteDefinitions(),
      ...migrationRouteDefinitions(),

      // Internal OAuth callback (gateway -> runtime)
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
