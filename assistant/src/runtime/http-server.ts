/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Always started on the
 * configured port (default: 7821).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { ServerWebSocket } from "bun";

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
  type AttentionState,
  type Confidence,
  getAttentionStateByConversationIds,
  markConversationUnread,
  recordConversationSeenSignal,
  type SignalType,
} from "../memory/conversation-attention-store.js";
import {
  type ConversationRow,
  forkConversation as forkConversationInStore,
  getConversation,
  getDisplayMetaForConversations,
} from "../memory/conversation-crud.js";
import { resolveConversationId } from "../memory/conversation-key-store.js";
import {
  countConversations,
  listConversations,
  listPinnedConversations,
} from "../memory/conversation-queries.js";
import type { ExternalConversationBinding } from "../memory/external-conversation-store.js";
import * as externalConversationStore from "../memory/external-conversation-store.js";
import { listGroups } from "../memory/group-crud.js";
import {
  consumeCallback,
  consumeCallbackError,
} from "../security/oauth-callback-registry.js";
import { UserError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getRuntimePortFilePath } from "../util/platform.js";
import { buildAssistantEvent } from "./assistant-event.js";
import { assistantEventHub } from "./assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
// Auth
import { authenticateRequest } from "./auth/middleware.js";
import { parseSub } from "./auth/subject.js";
import {
  mintDaemonDeliveryToken,
  mintUiPageToken,
  verifyToken,
} from "./auth/token-service.js";
import { sweepFailedEvents } from "./channel-retry-sweep.js";
import { getChromeExtensionRegistry } from "./chrome-extension-registry.js";
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
import { handleGetAudio } from "./routes/audio-routes.js";
import { avatarRouteDefinitions } from "./routes/avatar-routes.js";
import { brainGraphRouteDefinitions } from "./routes/brain-graph-routes.js";
import { browserCdpRouteDefinitions } from "./routes/browser-cdp-routes.js";
import { handleBrowserExtensionPair } from "./routes/browser-extension-pair-routes.js";
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
import { conversationAnalysisRouteDefinitions } from "./routes/conversation-analysis-routes.js";
import { conversationAttentionRouteDefinitions } from "./routes/conversation-attention-routes.js";
import {
  type ConversationManagementDeps,
  conversationManagementRouteDefinitions,
} from "./routes/conversation-management-routes.js";
import { conversationQueryRouteDefinitions } from "./routes/conversation-query-routes.js";
import { conversationRouteDefinitions } from "./routes/conversation-routes.js";
import { conversationStarterRouteDefinitions } from "./routes/conversation-starter-routes.js";
import { debugRouteDefinitions } from "./routes/debug-routes.js";
import { diagnosticsRouteDefinitions } from "./routes/diagnostics-routes.js";
import { documentRouteDefinitions } from "./routes/documents-routes.js";
import { eventsRouteDefinitions } from "./routes/events-routes.js";
import { globalSearchRouteDefinitions } from "./routes/global-search-routes.js";
import { groupRouteDefinitions } from "./routes/group-routes.js";
import { guardianActionRouteDefinitions } from "./routes/guardian-action-routes.js";
import { handleGuardianBootstrap } from "./routes/guardian-bootstrap-routes.js";
import { handleGuardianRefresh } from "./routes/guardian-refresh-routes.js";
import { heartbeatRouteDefinitions } from "./routes/heartbeat-routes.js";
import { hostBashRouteDefinitions } from "./routes/host-bash-routes.js";
import { hostBrowserRouteDefinitions } from "./routes/host-browser-routes.js";
import { hostCuRouteDefinitions } from "./routes/host-cu-routes.js";
import { hostFileRouteDefinitions } from "./routes/host-file-routes.js";
import {
  handleHealth,
  handleReadyz,
  identityRouteDefinitions,
} from "./routes/identity-routes.js";
import { slackChannelRouteDefinitions } from "./routes/integrations/slack/channel.js";
import { slackShareRouteDefinitions } from "./routes/integrations/slack/share.js";
import { telegramRouteDefinitions } from "./routes/integrations/telegram.js";
import { twilioRouteDefinitions } from "./routes/integrations/twilio.js";
import { vercelRouteDefinitions } from "./routes/integrations/vercel.js";
import { inviteRouteDefinitions } from "./routes/invite-routes.js";
import { logExportRouteDefinitions } from "./routes/log-export-routes.js";
import { memoryItemRouteDefinitions } from "./routes/memory-item-routes.js";
import { migrationRollbackRouteDefinitions } from "./routes/migration-rollback-routes.js";
import { migrationRouteDefinitions } from "./routes/migration-routes.js";
import { notificationRouteDefinitions } from "./routes/notification-routes.js";
import { oauthAppsRouteDefinitions } from "./routes/oauth-apps.js";
import { oauthProvidersRouteDefinitions } from "./routes/oauth-providers.js";
import type { PairingHandlerContext } from "./routes/pairing-routes.js";
import {
  handlePairingRequest,
  handlePairingStatus,
  pairingRouteDefinitions,
} from "./routes/pairing-routes.js";
import { profilerRouteDefinitions } from "./routes/profiler-routes.js";
import { recordingRouteDefinitions } from "./routes/recording-routes.js";
import { scheduleRouteDefinitions } from "./routes/schedule-routes.js";
import { secretRouteDefinitions } from "./routes/secret-routes.js";
import { settingsRouteDefinitions } from "./routes/settings-routes.js";
import { skillRouteDefinitions } from "./routes/skills-routes.js";
import { subagentRouteDefinitions } from "./routes/subagents-routes.js";
import { surfaceActionRouteDefinitions } from "./routes/surface-action-routes.js";
import { surfaceContentRouteDefinitions } from "./routes/surface-content-routes.js";
import { telemetryRouteDefinitions } from "./routes/telemetry-routes.js";
import { traceEventRouteDefinitions } from "./routes/trace-event-routes.js";
import { trustRulesRouteDefinitions } from "./routes/trust-rules-routes.js";
import { ttsRouteDefinitions } from "./routes/tts-routes.js";
import { upgradeBroadcastRouteDefinitions } from "./routes/upgrade-broadcast-routes.js";
import { usageRouteDefinitions } from "./routes/usage-routes.js";
import { userRouteDefinitions } from "./routes/user-routes.js";
import { watchRouteDefinitions } from "./routes/watch-routes.js";
import { workItemRouteDefinitions } from "./routes/work-items-routes.js";
import { workspaceCommitRouteDefinitions } from "./routes/workspace-commit-routes.js";
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

/** Global hard cap on request body size (512 MB — accommodates large .vbundle backup imports). */
const MAX_REQUEST_BODY_BYTES = 512 * 1024 * 1024;

/**
 * WebSocket data attached to `/v1/browser-relay` connections. The route
 * is used exclusively by the chrome-extension CDP proxy — inbound frames
 * from the extension travel over HTTP (`/v1/host-browser-result`), and
 * outbound frames are pushed through the {@link ChromeExtensionRegistry}.
 */
interface BrowserRelayWebSocketData {
  wsType: "browser-relay";
  connectionId: string;
  /**
   * Guardian identity derived from the JWT claims at WebSocket upgrade
   * time. Used by the ChromeExtensionRegistry to route
   * host_browser_request frames to the correct extension. Undefined when
   * HTTP auth is disabled (dev bypass) or when the token's sub cannot be
   * parsed into an actor principal.
   */
  guardianId?: string;
}

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
  private onProviderCredentialsChanged?: RuntimeHttpServerOptions["onProviderCredentialsChanged"];
  private getHeartbeatService?: RuntimeHttpServerOptions["getHeartbeatService"];
  private router: HttpRouter;

  /**
   * Whether the server is fully initialized and can serve all routes.
   * When false, only health-check, readiness-probe, and pairing endpoints
   * respond — everything else returns 503 Service Unavailable.  This
   * allows the HTTP server to bind its port early in daemon startup so
   * clients can detect liveness immediately, while heavyweight subsystems
   * (CES, providers, DaemonServer) finish initializing in the background.
   */
  private _ready = false;

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
    this.onProviderCredentialsChanged = options.onProviderCredentialsChanged;
    this.getHeartbeatService = options.getHeartbeatService;
    this.router = new HttpRouter(this.buildRouteTable());
  }

  /** The port the server is actually listening on (resolved after start). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  /** Whether the server has been fully initialized with all deps. */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * Wire up the full set of daemon dependencies and mark the server as
   * ready.  Called once heavyweight initialization (CES, providers,
   * DaemonServer) has completed.  Rebuilds the internal route table so
   * conditionally-registered routes (e.g. conversation analysis, skills)
   * pick up the newly available deps.
   */
  setFullDeps(
    options: Omit<
      RuntimeHttpServerOptions,
      "port" | "hostname" | "bearerToken"
    >,
  ): void {
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
    this.onProviderCredentialsChanged = options.onProviderCredentialsChanged;
    this.getHeartbeatService = options.getHeartbeatService;

    // Rebuild the route table so conditionally-registered routes that
    // depend on the newly-set deps are included.
    this.router = new HttpRouter(this.buildRouteTable());
    this._ready = true;
    log.info("Runtime HTTP server is now fully ready");
  }

  /** Expose the pairing store so the daemon server can wire HTTP handlers. */
  getPairingStore(): PairingStore {
    return this.pairingStore;
  }

  /** Set a callback for broadcasting server messages (wired by daemon server). */
  setPairingBroadcast(fn: (msg: ServerMessage) => void): void {
    this.pairingBroadcast = fn;
  }

  private get pairingContext(): PairingHandlerContext {
    const broadcast = this.pairingBroadcast;
    return {
      pairingStore: this.pairingStore,
      bearerToken: this.bearerToken,
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
            // When the JWT sub resolved to a guardian principal at upgrade
            // time, register this connection with the chrome-extension
            // registry so host_browser_request frames can be routed to it.
            if (data.guardianId) {
              getChromeExtensionRegistry().register({
                id: data.connectionId,
                guardianId: data.guardianId,
                ws,
                connectedAt: Date.now(),
              });
            }
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
            // The /v1/browser-relay socket is one-way (server → extension).
            // The extension POSTs results via /v1/host-browser-result;
            // inbound frames are unexpected.
            log.debug(
              { connectionId: data.connectionId },
              "Unexpected inbound browser-relay message",
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
            // Always attempt to unregister — the registry uses connectionId
            // as the key and no-ops if the entry is absent (e.g. when the
            // connection was never registered because guardianId was
            // undefined, or when it was superseded by a newer registration
            // for the same guardian).
            getChromeExtensionRegistry().unregister(data.connectionId);
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

    // Advertise the actual port to thin helpers that need to reach the
    // runtime without inheriting the daemon's environment (e.g. the
    // chrome-extension native messaging helper, spawned by Chrome).
    this.writeRuntimePortFile(this.actualPort);
  }

  /**
   * Atomically publish the runtime HTTP port to ~/.vellum/runtime-port so
   * external helpers can locate a non-default `RUNTIME_HTTP_PORT` without
   * any manifest changes. Best-effort — write failures never block
   * daemon startup (see assistant/AGENTS.md "Daemon startup philosophy").
   */
  private writeRuntimePortFile(actualPort: number): void {
    try {
      const portFile = getRuntimePortFilePath();
      const dir = dirname(portFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${portFile}.tmp.${process.pid}`;
      writeFileSync(tmpPath, String(actualPort), { mode: 0o644 });
      renameSync(tmpPath, portFile);
      log.info({ portFile, actualPort }, "Wrote runtime port file");
    } catch (err) {
      log.warn(
        { err },
        "Failed to write runtime port file; non-default assistant ports may require --assistant-port on thin helpers",
      );
    }
  }

  /**
   * Remove the runtime port file written by `writeRuntimePortFile`.
   * Called from `stop()` on clean shutdown so a stale file does not
   * point thin helpers (e.g. the chrome-extension native messaging
   * helper) at a dead port until the next daemon start overwrites it.
   * Best-effort — unlink failures never block shutdown.
   *
   * The unlink is conditional: we only remove the file if its current
   * contents still match this server's port. The runtime-port file
   * lives at the user-home level (`~/.vellum/runtime-port`) and is
   * therefore shared across multiple daemon instances running on
   * different `RUNTIME_HTTP_PORT`s. If a sibling instance has already
   * rewritten the file with its own port, deleting it would strand
   * thin helpers on the default port `7821` and break their ability
   * to reach the still-running sibling.
   *
   * Note: this only runs on graceful shutdown. A crash leaves the
   * file in place; the next successful startup overwrites it.
   */
  private removeRuntimePortFile(): void {
    try {
      const portFile = getRuntimePortFilePath();
      if (!existsSync(portFile)) return;
      // Read-then-compare-then-unlink. Race-safe enough: the worst case
      // is that another instance writes the file between our read and
      // our unlink, in which case we erroneously delete its mapping.
      // That window is short (a few microseconds) and a sibling startup
      // will rewrite the file on its next port-publish call. The much
      // more common multi-instance race — sibling already overwrote
      // before our stop() runs — is correctly handled here as a no-op.
      const current = readFileSync(portFile, "utf-8").trim();
      if (current !== String(this.actualPort)) {
        log.info(
          { portFile, current, actualPort: this.actualPort },
          "Leaving runtime port file alone — owned by another instance",
        );
        return;
      }
      unlinkSync(portFile);
      log.info({ portFile }, "Removed runtime port file");
    } catch (err) {
      log.warn({ err }, "Failed to remove runtime port file");
    }
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
    this.removeRuntimePortFile();
  }

  private async handleRequest(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Promise<Response> {
    server.timeout(req, 1800);
    // Skip request logging for health-check probes to reduce log noise.
    const url = new URL(req.url);
    if (
      (url.pathname === "/healthz" || url.pathname === "/readyz") &&
      req.method === "GET"
    ) {
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

    if (path === "/readyz" && req.method === "GET") {
      if (!this._ready) {
        return Response.json({ status: "initializing" }, { status: 503 });
      }
      return handleReadyz();
    }

    // When the server hasn't been fully initialized yet, reject all
    // non-health / non-pairing requests with 503 so clients know the
    // daemon is alive but not yet ready to serve traffic.
    if (!this._ready) {
      return Response.json(
        {
          error: "SERVICE_UNAVAILABLE",
          message: "Daemon is still initializing",
        },
        { status: 503 },
      );
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

    // Audio serving endpoint — before auth check because Twilio
    // fetches these URLs directly. The audioId is an unguessable UUID.
    const audioMatch = path.match(/^\/v1\/audio\/([^/]+)$/);
    if (audioMatch && req.method === "GET") {
      return handleGetAudio(audioMatch[1]);
    }

    // Pairing endpoints (unauthenticated, secret-gated)
    if (path === "/v1/pairing/request" && req.method === "POST") {
      return await handlePairingRequest(req, this.pairingContext);
    }
    if (path === "/v1/pairing/status" && req.method === "GET") {
      return handlePairingStatus(url, this.pairingContext);
    }

    // Chrome extension capability-token pair endpoint — unauthenticated but
    // restricted to loopback peers + an extension-id allowlist. Used by the
    // native messaging helper to bootstrap a scoped token.
    if (path === "/v1/browser-extension-pair") {
      return await handleBrowserExtensionPair(req, server);
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

    // When auth is enabled we parse the JWT sub to extract the actor
    // principal ID, which we use as the guardianId key for the
    // ChromeExtensionRegistry. When auth is disabled (dev bypass),
    // guardianId remains undefined and the registration is skipped —
    // host_browser_request routing requires an authenticated guardian.
    //
    // Gateway path: when the WebSocket upgrade is proxied through the
    // gateway, the upstream token minted by `mintServiceToken()` has
    // `sub=svc:gateway:self` with no actor principal id. In that case
    // we fall back to an explicit `x-guardian-id` header / query param
    // so the runtime can still register the connection under the real
    // guardian. TODO(gateway-plumbing): the gateway's
    // `browser-relay-websocket.ts` does not yet forward this header —
    // once it does (resolving the actor from the downstream edge token
    // at upgrade time), the service-token branch below will start
    // picking up the guardianId. Until then, cloud-path registration
    // silently no-ops, which is a known limitation tracked for Phase 3.
    let guardianId: string | undefined;
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
      const subResult = parseSub(jwtResult.claims.sub);
      if (subResult.ok && subResult.actorPrincipalId) {
        // Direct actor principal — this is the loopback / desktop path.
        guardianId = subResult.actorPrincipalId;
      } else {
        // Service-token path (gateway-forwarded). Look for an explicit
        // guardian id plumbed by the gateway as a header or query
        // param. Header takes precedence because headers are easier
        // for the gateway to forward without rewriting the URL.
        const headerGuardianId = req.headers.get("x-guardian-id")?.trim() ?? "";
        const queryGuardianId =
          wsUrl.searchParams.get("guardianId")?.trim() ?? "";
        const fallbackGuardianId = headerGuardianId || queryGuardianId;
        if (fallbackGuardianId) {
          guardianId = fallbackGuardianId;
        }
      }
    }

    const connectionId = crypto.randomUUID();
    const upgraded = server.upgrade(req, {
      data: {
        wsType: "browser-relay",
        connectionId,
        guardianId,
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

  private buildAssistantAttention(attentionState: AttentionState | undefined):
    | {
        hasUnseenLatestAssistantMessage: boolean;
        latestAssistantMessageAt?: number;
        lastSeenAssistantMessageAt?: number;
        lastSeenConfidence?: Confidence;
        lastSeenSignalType?: SignalType;
      }
    | undefined {
    if (!attentionState) return undefined;

    return {
      hasUnseenLatestAssistantMessage:
        attentionState.latestAssistantMessageAt != null &&
        (attentionState.lastSeenAssistantMessageAt == null ||
          attentionState.lastSeenAssistantMessageAt <
            attentionState.latestAssistantMessageAt),
      ...(attentionState.latestAssistantMessageAt != null
        ? {
            latestAssistantMessageAt: attentionState.latestAssistantMessageAt,
          }
        : {}),
      ...(attentionState.lastSeenAssistantMessageAt != null
        ? {
            lastSeenAssistantMessageAt:
              attentionState.lastSeenAssistantMessageAt,
          }
        : {}),
      ...(attentionState.lastSeenConfidence != null
        ? { lastSeenConfidence: attentionState.lastSeenConfidence }
        : {}),
      ...(attentionState.lastSeenSignalType != null
        ? { lastSeenSignalType: attentionState.lastSeenSignalType }
        : {}),
    };
  }

  private buildForkParent(
    conversation: ConversationRow,
    parentCache: Map<string, ConversationRow | null>,
  ): { conversationId: string; messageId: string; title: string } | undefined {
    const parentConversationId = conversation.forkParentConversationId;
    const parentMessageId = conversation.forkParentMessageId;
    if (!parentConversationId || !parentMessageId) return undefined;

    let parentConversation: ConversationRow | null | undefined =
      parentCache.get(parentConversationId);
    if (parentConversation === undefined) {
      parentConversation = getConversation(parentConversationId);
      parentCache.set(parentConversationId, parentConversation);
    }
    if (
      !parentConversation ||
      parentConversation.conversationType === "private"
    ) {
      return undefined;
    }

    return {
      conversationId: parentConversationId,
      messageId: parentMessageId,
      title: parentConversation.title ?? "Untitled",
    };
  }

  private serializeConversationSummary(params: {
    conversation: ConversationRow;
    binding?: ExternalConversationBinding | null;
    attentionState?: AttentionState;
    displayMeta?: {
      displayOrder: number | null;
      isPinned: boolean;
      groupId: string | null;
    };
    parentCache: Map<string, ConversationRow | null>;
  }) {
    const { conversation, binding, attentionState, displayMeta, parentCache } =
      params;
    const originChannel = parseChannelId(conversation.originChannel);
    const assistantAttention = this.buildAssistantAttention(attentionState);
    const forkParent = this.buildForkParent(conversation, parentCache);

    return {
      id: conversation.id,
      title: conversation.title ?? "Untitled",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastMessageAt: conversation.lastMessageAt,
      conversationType: conversation.conversationType ?? "standard",
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
      ...(originChannel ? { conversationOriginChannel: originChannel } : {}),
      ...(assistantAttention ? { assistantAttention } : {}),
      ...(displayMeta?.isPinned
        ? {
            isPinned: true as const,
            displayOrder: displayMeta.displayOrder,
          }
        : displayMeta?.displayOrder != null
          ? {
              displayOrder: displayMeta.displayOrder,
            }
          : {}),
      groupId: displayMeta?.groupId ?? null,
      ...(forkParent ? { forkParent } : {}),
    };
  }

  private buildConversationDetailResponse(conversationId: string) {
    const conversation = getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    const bindings = externalConversationStore.getBindingsForConversations([
      conversation.id,
    ]);
    const attentionStates = getAttentionStateByConversationIds([
      conversation.id,
    ]);
    const displayMeta = getDisplayMetaForConversations([conversation.id]);
    const parentCache = new Map<string, ConversationRow | null>();

    return {
      conversation: this.serializeConversationSummary({
        conversation,
        binding: bindings.get(conversation.id),
        attentionState: attentionStates.get(conversation.id),
        displayMeta: displayMeta.get(conversation.id),
        parentCache,
      }),
    };
  }

  private getConversationManagementRouteDeps(): ConversationManagementDeps | null {
    if (!this.conversationManagementDeps) {
      return null;
    }

    return {
      ...this.conversationManagementDeps,
      forkConversation:
        this.conversationManagementDeps.forkConversation ??
        (async ({ conversationId, throughMessageId }) => {
          const forkedConversation = forkConversationInStore({
            conversationId,
            throughMessageId,
          });
          const detail = this.buildConversationDetailResponse(
            forkedConversation.id,
          );
          if (!detail) {
            throw new Error(
              `Forked conversation ${forkedConversation.id} could not be loaded`,
            );
          }
          return detail.conversation;
        }),
    };
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
    const conversationManagementDeps =
      this.getConversationManagementRouteDeps();

    return [
      ...pairingRouteDefinitions({
        getPairingContext: () => this.pairingContext,
      }),
      ...appRouteDefinitions(),
      ...appManagementRouteDefinitions(),
      ...secretRouteDefinitions({
        getCesClient: this.getCesClient,
        onProviderCredentialsChanged: this.onProviderCredentialsChanged,
      }),
      ...identityRouteDefinitions(),
      ...upgradeBroadcastRouteDefinitions(),
      ...workspaceCommitRouteDefinitions(),
      ...migrationRollbackRouteDefinitions(),
      ...debugRouteDefinitions(),
      ...usageRouteDefinitions(),
      ...telemetryRouteDefinitions(),
      ...workspaceRouteDefinitions(),
      ...memoryItemRouteDefinitions(),
      ...conversationStarterRouteDefinitions(),
      ...settingsRouteDefinitions(),
      ...avatarRouteDefinitions(),
      ...scheduleRouteDefinitions({
        sendMessageDeps: this.sendMessageDeps,
      }),
      ...heartbeatRouteDefinitions({
        getHeartbeatService: this.getHeartbeatService,
      }),
      ...notificationRouteDefinitions(),
      ...diagnosticsRouteDefinitions(),
      ...logExportRouteDefinitions(),
      ...profilerRouteDefinitions(),
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
      ...ttsRouteDefinitions(),

      // Conversation list and seen signal — kept inline because they
      // depend on multiple cross-cutting stores that aren't grouped
      // into a single domain module.
      {
        endpoint: "conversations",
        method: "GET",
        handler: ({ url }) => {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const backgroundOnly =
            url.searchParams.get("conversationType") === "background";
          let rows = listConversations(limit, backgroundOnly, offset);
          const totalCount = countConversations(backgroundOnly);
          // On the first page, ensure all pinned conversations are included
          // even if they fall outside the paginated window.
          if (offset === 0 && !backgroundOnly) {
            const pinned = listPinnedConversations();
            const seen = new Set(rows.map((c) => c.id));
            const missing = pinned.filter((c) => !seen.has(c.id));
            if (missing.length > 0) {
              rows = [...rows, ...missing];
            }
          }
          const conversationIds = rows.map((c) => c.id);
          const displayMeta = getDisplayMetaForConversations(conversationIds);
          const bindings =
            externalConversationStore.getBindingsForConversations(
              conversationIds,
            );
          const attentionStates =
            getAttentionStateByConversationIds(conversationIds);
          const parentCache = new Map<string, ConversationRow | null>();
          const nextOffset = offset + limit;
          const response: Record<string, unknown> = {
            conversations: rows.map((conversation) =>
              this.serializeConversationSummary({
                conversation,
                binding: bindings.get(conversation.id),
                attentionState: attentionStates.get(conversation.id),
                displayMeta: displayMeta.get(conversation.id),
                parentCache,
              }),
            ),
            nextOffset,
            hasMore: nextOffset < totalCount,
          };
          // Include groups array on first page only
          if (offset === 0) {
            const groups = listGroups();
            response.groups = groups.map((g) => ({
              id: g.id,
              name: g.name,
              sortPosition: g.sortPosition,
              isSystemGroup: g.isSystemGroup,
            }));
          }
          return Response.json(response);
        },
      },
      ...conversationAttentionRouteDefinitions(),

      ...(conversationManagementDeps
        ? conversationManagementRouteDefinitions(conversationManagementDeps)
        : []),

      ...(this.sendMessageDeps
        ? conversationAnalysisRouteDefinitions({
            sendMessageDeps: this.sendMessageDeps,
            buildConversationDetailResponse: (id) =>
              this.buildConversationDetailResponse(id),
          })
        : []),

      ...groupRouteDefinitions(),

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
          const detail = this.buildConversationDetailResponse(params.id);
          if (!detail) {
            return httpError(
              "NOT_FOUND",
              `Conversation ${params.id} not found`,
              404,
            );
          }
          return Response.json(detail);
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
        getHeartbeatService: this.getHeartbeatService,
      }),
      ...globalSearchRouteDefinitions(),
      ...approvalRouteDefinitions(),
      ...hostBashRouteDefinitions(),
      ...hostBrowserRouteDefinitions(),
      ...browserCdpRouteDefinitions(),
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
      ...vercelRouteDefinitions(),
      ...channelReadinessRouteDefinitions(),
      ...oauthProvidersRouteDefinitions(),
      ...oauthAppsRouteDefinitions(),
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
        getHeartbeatService: this.getHeartbeatService,
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
      ...traceEventRouteDefinitions(),
      ...migrationRouteDefinitions(),

      // User-defined routes under /x/* — must be LAST so built-in routes
      // always take priority.
      ...userRouteDefinitions(),

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
