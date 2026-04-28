/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Always started on the
 * configured port (default: 7821).
 */


import type { ServerWebSocket } from "bun";

import {
  startGuardianActionSweep,
  stopGuardianActionSweep,
} from "../calls/guardian-action-sweep.js";
import {
  activeMediaStreamSessions,
  MediaStreamCallSession,
} from "../calls/media-stream-server.js";
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
import {
  hasUngatedHttpAuthDisabled,
  isHttpAuthDisabled,
} from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { processMessage } from "../daemon/process-message.js";
import { createLiveVoiceSession } from "../live-voice/live-voice-session.js";
import { LiveVoiceSessionManager } from "../live-voice/live-voice-session-manager.js";
import {
  type LiveVoiceClientFrame,
  type LiveVoiceProtocolError,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFrame,
  parseLiveVoiceBinaryAudioFrame,
  parseLiveVoiceClientTextFrame,
} from "../live-voice/protocol.js";
import { resolveStreamingTranscriber } from "../providers/speech-to-text/resolve.js";
import {
  activeSttStreamSessions,
  SttStreamSession,
} from "../stt/stt-stream-session.js";
import { getLogger } from "../util/logger.js";
// Auth
import {
  authenticateHostBrowserResultRequest,
  authenticateRequest,
} from "./auth/middleware.js";
import { parseSub } from "./auth/subject.js";
import { verifyToken } from "./auth/token-service.js";
import { verifyHostBrowserCapability } from "./capability-tokens.js";
import { sweepFailedEvents } from "./channel-retry-sweep.js";
import { getChromeExtensionRegistry } from "./chrome-extension-registry.js";
import { httpError, type HttpErrorCode } from "./http-errors.js";
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
import { ROUTES as APP_ROUTES } from "./routes/app-routes.js";
import { ROUTES as AUDIO_ROUTES } from "./routes/audio-routes.js";
import {
  startCanonicalGuardianExpirySweep,
  stopCanonicalGuardianExpirySweep,
} from "./routes/canonical-guardian-expiry-sweep.js";
import {
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
} from "./routes/channel-guardian-routes.js";
import { RouteError } from "./routes/errors.js";
import {
  resolveHostBrowserEvent,
  resolveHostBrowserResultByRequestId,
  resolveHostBrowserSessionInvalidated,
} from "./routes/host-browser-routes.js";
import { handleHealth, handleReadyz } from "./routes/identity-routes.js";
import { matchSkillRoute } from "./skill-route-registry.js";

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
} from "./http-types.js";

import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  RuntimeHttpServerOptions,
} from "./http-types.js";

const log = getLogger("runtime-http");

const DEFAULT_PORT = 7821;
const DEFAULT_HOSTNAME = "127.0.0.1";

/** Global hard cap on request body size (512 MB — accommodates large .vbundle backup imports). */
const MAX_REQUEST_BODY_BYTES = 512 * 1024 * 1024;

/**
 * WebSocket data attached to `/v1/browser-relay` connections. The route
 * is used exclusively by the chrome-extension CDP proxy — outbound
 * `host_browser_request` frames are pushed through the
 * {@link ChromeExtensionRegistry}, and inbound `host_browser_result`
 * frames are dispatched through
 * `resolveHostBrowserResultByRequestId`. The extension may also submit
 * results via `POST /v1/host-browser-result` (both transports resolve
 * through the same core function).
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
  /**
   * Stable per-extension-install identifier supplied by the client on
   * the WebSocket handshake (via the `clientInstanceId` query param or
   * the `x-client-instance-id` header). Plumbed into the
   * ChromeExtensionRegistry so multiple parallel installs for the same
   * guardian (e.g. two Chrome profiles, two desktops) don't evict each
   * other on register/unregister. Undefined on older extension builds
   * — the registry synthesizes a connection-scoped fallback key in
   * that case for backwards-compatible single-instance semantics.
   */
  clientInstanceId?: string;
}

/**
 * WebSocket data attached to `/v1/calls/media-stream` connections.
 * The `wsType` discriminator routes frames to the media-stream call
 * session instead of the ConversationRelay or browser-relay handlers.
 */
interface MediaStreamWebSocketData {
  wsType: "media-stream";
  callSessionId: string;
  /** Bound at open time so the close handler tears down the exact session
   *  that owns *this* socket, avoiding races with reconnects. */
  session?: MediaStreamCallSession;
}

/**
 * WebSocket data attached to `/v1/stt/stream` connections.
 * The `wsType` discriminator routes frames to the STT streaming
 * session orchestrator instead of the other WebSocket handlers.
 *
 * `provider` is optional compatibility metadata from the client/gateway.
 * The runtime is config-authoritative — it always resolves the streaming
 * transcriber from `services.stt.provider` in the assistant config.
 */
interface SttStreamWebSocketData {
  wsType: "stt-stream";
  /** Optional requested provider — metadata only; runtime uses config. */
  provider?: string;
  mimeType: string;
  sampleRate?: number;
  /** The session ID for tracking in the active sessions registry. */
  sessionId: string;
  /** Bound at open time so the close handler tears down the exact session. */
  session?: SttStreamSession;
}

/**
 * WebSocket data attached to `/v1/live-voice` connections. The `wsType`
 * discriminator routes frames to the live voice protocol shell instead of
 * the other WebSocket handlers.
 */
interface LiveVoiceWebSocketData {
  wsType: "live-voice";
  sessionId?: string;
  lastSeq: number;
}

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private hostname: string;

  private approvalCopyGenerator?: ApprovalCopyGenerator;
  private approvalConversationGenerator?: ApprovalConversationGenerator;
  private guardianActionCopyGenerator?: GuardianActionCopyGenerator;
  private guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator;
  private retrySweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInProgress = false;

  private readonly liveVoiceSessionManager: LiveVoiceSessionManager;
  private router: HttpRouter;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;

    this.approvalCopyGenerator = options.approvalCopyGenerator;
    this.approvalConversationGenerator = options.approvalConversationGenerator;
    this.guardianActionCopyGenerator = options.guardianActionCopyGenerator;
    this.guardianFollowUpConversationGenerator =
      options.guardianFollowUpConversationGenerator;
    this.liveVoiceSessionManager = new LiveVoiceSessionManager({
      createSession: (context) => createLiveVoiceSession(context),
    });
    this.router = new HttpRouter();
  }

  /** The port the server is actually listening on (resolved after start). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  async start(): Promise<void> {
    type AllWebSocketData =
      | RelayWebSocketData
      | BrowserRelayWebSocketData
      | MediaStreamWebSocketData
      | SttStreamWebSocketData
      | LiveVoiceWebSocketData;
    this.server = Bun.serve<AllWebSocketData>({
      port: this.port,
      hostname: this.hostname,
      idleTimeout: 0,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open: (ws) => {
          const data = ws.data as AllWebSocketData;
          if ("wsType" in data && data.wsType === "browser-relay") {
            // When the JWT sub resolved to a guardian principal at upgrade
            // time, register this connection with the chrome-extension
            // registry so host_browser_request frames can be routed to it.
            if (data.guardianId) {
              const now = Date.now();
              getChromeExtensionRegistry().register({
                id: data.connectionId,
                guardianId: data.guardianId,
                clientInstanceId: data.clientInstanceId,
                ws,
                connectedAt: now,
                lastActiveAt: now,
              });
            }
            return;
          }
          if ("wsType" in data && data.wsType === "media-stream") {
            const msData = data as MediaStreamWebSocketData;
            log.info(
              { callSessionId: msData.callSessionId },
              "Media-stream WebSocket opened",
            );
            const session = new MediaStreamCallSession(
              ws,
              msData.callSessionId,
            );
            activeMediaStreamSessions.set(msData.callSessionId, session);
            // Bind the session instance to the websocket so the close
            // handler tears down *this* session, not a replacement that
            // a reconnect may have inserted under the same callSessionId.
            msData.session = session;
            return;
          }
          if ("wsType" in data && data.wsType === "stt-stream") {
            const sttData = data as SttStreamWebSocketData;

            // The runtime is config-authoritative: always resolve the
            // provider from `services.stt.provider` regardless of what
            // the client/gateway requested.
            //
            // getConfig() can throw (e.g. after invalidateConfigCache()
            // when config.json is temporarily invalid). Wrap in try/catch
            // so the session still starts normally — resolveStreamingTranscriber
            // reads config inside SttStreamSession.start()'s own guarded path.
            let configuredProvider: string | undefined;
            try {
              configuredProvider = getConfig().services.stt.provider;

              // Mismatch telemetry: when the optional requested provider
              // disagrees with the configured provider, log a warning so
              // operators can detect stale client builds.
              if (sttData.provider && sttData.provider !== configuredProvider) {
                log.warn(
                  {
                    requestedProvider: sttData.provider,
                    configuredProvider,
                    sessionId: sttData.sessionId,
                  },
                  "STT stream provider mismatch — requested provider differs from configured provider; using configured provider",
                );
              }
            } catch (err) {
              log.warn(
                {
                  error: err instanceof Error ? err.message : String(err),
                  sessionId: sttData.sessionId,
                },
                "Failed to read config for STT provider mismatch telemetry — proceeding without mismatch check",
              );
            }

            // Fall back to the requested provider (or "unknown") when
            // config reading failed, so the session constructor still
            // gets a usable label for logging/error messages.
            const effectiveProvider =
              configuredProvider ?? sttData.provider ?? "unknown";

            log.info(
              {
                requestedProvider: sttData.provider ?? "(none)",
                configuredProvider: effectiveProvider,
                mimeType: sttData.mimeType,
                sessionId: sttData.sessionId,
              },
              "STT stream WebSocket opened",
            );
            const session = new SttStreamSession(
              ws,
              effectiveProvider,
              sttData.mimeType,
              { sampleRate: sttData.sampleRate },
            );
            sttData.session = session;
            activeSttStreamSessions.set(sttData.sessionId, session);

            // Start the session asynchronously — resolves the streaming
            // transcriber and sends a `ready` event on success.
            void session.start(() =>
              resolveStreamingTranscriber({
                sampleRate: sttData.sampleRate,
              }),
            );
            return;
          }
          if ("wsType" in data && data.wsType === "live-voice") {
            log.info("Live voice WebSocket opened");
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
        message: (ws, message) => {
          const data = ws.data as AllWebSocketData;
          const raw =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          if ("wsType" in data && data.wsType === "browser-relay") {
            // Inbound frames on `/v1/browser-relay` carry one of:
            //   - `host_browser_result` — paired response to an outbound
            //     `host_browser_request` (see PR2).
            //   - `host_browser_event` — unsolicited CDP event forwarded
            //     from the extension's `chrome.debugger.onEvent`
            //     subscription (PR10).
            //   - `host_browser_session_invalidated` — detach
            //     notification forwarded from the extension's
            //     `chrome.debugger.onDetach` subscription (PR10).
            //
            // Every supported frame type delegates into a shared
            // resolver exported from `host-browser-routes.ts` so the
            // validation and resolution semantics stay in lockstep
            // with the HTTP path. Malformed or unsupported frames are
            // logged at debug and swallowed — we never throw out of a
            // WebSocket `message` handler because an uncaught
            // exception would tear down the whole socket for an
            // attacker-controlled payload.
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              log.debug(
                {
                  connectionId: data.connectionId,
                  error: err instanceof Error ? err.message : String(err),
                },
                "browser-relay: dropped non-JSON inbound frame",
              );
              return;
            }
            if (!parsed || typeof parsed !== "object") {
              log.debug(
                { connectionId: data.connectionId },
                "browser-relay: dropped non-object inbound frame",
              );
              return;
            }
            const frame = parsed as Record<string, unknown>;
            switch (frame.type) {
              case "host_browser_result": {
                const resolution = resolveHostBrowserResultByRequestId({
                  requestId: frame.requestId,
                  content: frame.content,
                  isError: frame.isError,
                });
                if (!resolution.ok) {
                  log.warn(
                    {
                      connectionId: data.connectionId,
                      requestId:
                        typeof frame.requestId === "string"
                          ? frame.requestId
                          : undefined,
                      code: resolution.code,
                      message: resolution.message,
                    },
                    "browser-relay: host_browser_result frame rejected",
                  );
                }
                return;
              }
              case "host_browser_event": {
                const resolution = resolveHostBrowserEvent({
                  method: frame.method,
                  params: frame.params,
                  cdpSessionId: frame.cdpSessionId,
                });
                if (!resolution.ok) {
                  log.warn(
                    {
                      connectionId: data.connectionId,
                      method:
                        typeof frame.method === "string"
                          ? frame.method
                          : undefined,
                      code: resolution.code,
                      message: resolution.message,
                    },
                    "browser-relay: host_browser_event frame rejected",
                  );
                }
                return;
              }
              case "host_browser_session_invalidated": {
                const resolution = resolveHostBrowserSessionInvalidated({
                  targetId: frame.targetId,
                  reason: frame.reason,
                });
                if (!resolution.ok) {
                  log.warn(
                    {
                      connectionId: data.connectionId,
                      targetId:
                        typeof frame.targetId === "string"
                          ? frame.targetId
                          : undefined,
                      code: resolution.code,
                      message: resolution.message,
                    },
                    "browser-relay: host_browser_session_invalidated frame rejected",
                  );
                }
                return;
              }
              case "keepalive": {
                // Extension keepalive frames refresh the connection's
                // activity timestamp without producing log noise or
                // altering routing semantics. Unknown extra keys on
                // the frame are silently ignored (lenient validation).
                getChromeExtensionRegistry().touch(data.connectionId);
                return;
              }
              default: {
                log.debug(
                  { connectionId: data.connectionId, type: frame.type },
                  "browser-relay: dropped unsupported inbound frame type",
                );
                return;
              }
            }
          }
          if ("wsType" in data && data.wsType === "media-stream") {
            const msData = data as MediaStreamWebSocketData;
            msData.session?.handleMessage(raw);
            return;
          }
          if ("wsType" in data && data.wsType === "stt-stream") {
            const sttData = data as SttStreamWebSocketData;
            const session = sttData.session;
            if (!session) return;

            if (typeof message === "string") {
              session.handleMessage(message);
            } else {
              // Binary frame — raw audio bytes.
              const buffer =
                message instanceof ArrayBuffer
                  ? Buffer.from(new Uint8Array(message))
                  : Buffer.from(message);
              session.handleBinaryAudio(buffer);
            }
            return;
          }
          if ("wsType" in data && data.wsType === "live-voice") {
            void this.handleLiveVoiceMessage(
              ws as ServerWebSocket<LiveVoiceWebSocketData>,
              message,
            ).catch((err) => {
              log.warn(
                { error: err instanceof Error ? err.message : String(err) },
                "Live voice WebSocket message handler failed",
              );
              this.sendLiveVoiceError(
                ws as ServerWebSocket<LiveVoiceWebSocketData>,
                {
                  code: LiveVoiceProtocolErrorCode.InvalidFrame,
                  message: "Live voice frame handling failed",
                },
              );
            });
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          if (callSessionId) {
            const connection = activeRelayConnections.get(callSessionId);
            connection?.handleMessage(raw);
          }
        },
        close: (ws, code, reason) => {
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
          if ("wsType" in data && data.wsType === "media-stream") {
            const msData = data as MediaStreamWebSocketData;
            log.info(
              {
                callSessionId: msData.callSessionId,
                code,
                reason: reason?.toString(),
              },
              "Media-stream WebSocket closed",
            );
            // Use the session bound at open time so we tear down the
            // exact session that owns *this* socket, not a replacement
            // that a reconnect may have inserted under the same key.
            const msSession = msData.session;
            if (msSession) {
              msSession.handleTransportClosed(code, reason?.toString());
              msSession.destroy();
              // Only delete from the map if *our* session is still the
              // registered one — a reconnect may have already replaced it.
              if (
                activeMediaStreamSessions.get(msData.callSessionId) ===
                msSession
              ) {
                activeMediaStreamSessions.delete(msData.callSessionId);
              }
            }
            return;
          }
          if ("wsType" in data && data.wsType === "stt-stream") {
            const sttData = data as SttStreamWebSocketData;
            log.info(
              {
                provider: sttData.provider,
                sessionId: sttData.sessionId,
                code,
                reason: reason?.toString(),
              },
              "STT stream WebSocket closed",
            );
            const session = sttData.session;
            if (session) {
              session.handleClose(code, reason?.toString());
              // Only delete from the map if our session is still the
              // registered one — avoids races with reconnects.
              if (activeSttStreamSessions.get(sttData.sessionId) === session) {
                activeSttStreamSessions.delete(sttData.sessionId);
              }
            }
            return;
          }
          if ("wsType" in data && data.wsType === "live-voice") {
            log.info(
              {
                sessionId: data.sessionId,
                code,
                reason: reason?.toString(),
              },
              "Live voice WebSocket closed",
            );
            this.releaseLiveVoiceSession(data, "websocket_close");
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

    this.startBackgroundSweeps();

    log.info(
      "Running in gateway-only ingress mode. Direct webhook routes disabled.",
    );
    if (!isLoopbackHost(this.hostname)) {
      log.warn(
        "RUNTIME_HTTP_HOST is not bound to loopback. This may expose the runtime to direct public access.",
      );
    }

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
      },
      "Runtime HTTP server listening",
    );
  }

  /**
   * Start background sweep timers: retry sweep for failed channel events,
   * guardian approval/action expiry sweeps, and canonical guardian expiry.
   * Extracted from start() to allow future callers to defer sweep startup.
   */
  private startBackgroundSweeps(): void {
    if (!this.retrySweepTimer) {
      this.retrySweepTimer = setInterval(() => {
        if (this.sweepInProgress) return;
        this.sweepInProgress = true;
        sweepFailedEvents(processMessage).finally(() => {
          this.sweepInProgress = false;
        });
      }, 30_000);
    }

    startGuardianExpirySweep(this.approvalCopyGenerator);
    log.info("Guardian approval expiry sweep started");

    startGuardianActionSweep(this.guardianActionCopyGenerator);
    log.info("Guardian action expiry sweep started");

    startCanonicalGuardianExpirySweep();
    log.info("Canonical guardian request expiry sweep started");
  }

  async stop(): Promise<void> {
    stopGuardianExpirySweep();
    stopGuardianActionSweep();
    stopCanonicalGuardianExpirySweep();
    if (this.retrySweepTimer) {
      clearInterval(this.retrySweepTimer);
      this.retrySweepTimer = null;
    }

    // Deterministic teardown of active STT streaming sessions before
    // stopping the HTTP server so provider sessions are cleaned up
    // and clients receive proper close frames.
    for (const [sessionId, session] of activeSttStreamSessions) {
      session.destroy();
      activeSttStreamSessions.delete(sessionId);
    }

    const liveVoiceSessionId = this.liveVoiceSessionManager.activeSessionId;
    if (liveVoiceSessionId) {
      await this.liveVoiceSessionManager.releaseSession(
        liveVoiceSessionId,
        "manager_shutdown",
      );
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
      return handleReadyz();
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

    // WebSocket upgrade for Twilio Media Streams — same private-network
    // restrictions as relay upgrades.
    if (
      path.startsWith("/v1/calls/media-stream") &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.handleMediaStreamUpgrade(req, server);
    }

    // WebSocket upgrade for STT streaming — private-network restrictions
    // and explicit gateway-service token verification before upgrade.
    if (
      path === "/v1/stt/stream" &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.handleSttStreamUpgrade(req, server);
    }

    // WebSocket upgrade for live voice — same private-network restrictions
    // and gateway-service token verification as STT streaming.
    if (
      path === "/v1/live-voice" &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.handleLiveVoiceUpgrade(req, server);
    }

    // Twilio webhook endpoints — before auth check because Twilio
    // webhook POSTs don't include bearer tokens.
    const twilioResponse = await this.handleTwilioWebhook(req, path);
    if (twilioResponse) return twilioResponse;

    // Audio serving endpoint — before auth check because Twilio
    // fetches these URLs directly (isPublic route, ATL-314).
    const audioMatch = path.match(/^\/v1\/audio\/([^/]+)$/);
    if (audioMatch && req.method === "GET") {
      const audioDef = AUDIO_ROUTES.find((r) => r.operationId === "audio_get")!;
      const args = { pathParams: { audioId: audioMatch[1] } };
      try {
        const result = await audioDef.handler(args);
        const headers =
          typeof audioDef.responseHeaders === "function"
            ? audioDef.responseHeaders(args)
            : audioDef.responseHeaders;
        if (result instanceof ReadableStream) {
          return new Response(result as ReadableStream<Uint8Array>, {
            headers,
          });
        }
        return new Response(result as BodyInit, { headers });
      } catch (err) {
        if (err instanceof RouteError) {
          return httpError(
            err.code as HttpErrorCode,
            err.message,
            err.statusCode,
          );
        }
        throw err;
      }
    }

    // Skill-registered routes (e.g. meet-bot event ingress). Handled before
    // JWT auth because skills may use their own auth (e.g. per-meeting bearer
    // tokens minted by a session manager).
    const skillMatch = matchSkillRoute(path, req.method);
    if (skillMatch) {
      if (skillMatch.kind === "methodMismatch") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: skillMatch.allow.join(", ") },
        });
      }
      return await skillMatch.route.handler(req, skillMatch.match);
    }

    // JWT bearer authentication — replaces the old shared-secret comparison.
    // authenticateRequest handles dev bypass (DISABLE_HTTP_AUTH) internally.
    //
    // Special-case: /v1/host-browser-result POST accepts either a
    // daemon-minted JWT (legacy/cloud) or a host_browser capability
    // token (self-hosted chrome extension). The chrome extension's
    // HTTP fallback (`postHostBrowserResult`) hands over the same
    // capability token it presented to `/v1/browser-relay`, so the
    // POST route must understand both auth shapes. Every other route
    // keeps the JWT-only flow via `authenticateRequest`.
    const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;
    const authResult =
      normalizedPath === "/v1/host-browser-result" && req.method === "POST"
        ? await authenticateHostBrowserResultRequest(req)
        : authenticateRequest(req);
    if (!authResult.ok) {
      return authResult.response;
    }
    const authContext = authResult.context;

    // Serve shareable app pages (outside /v1/ namespace, no rate limiting)
    const pagesMatch = path.match(/^\/pages\/([^/]+)$/);
    if (pagesMatch && req.method === "GET") {
      return withErrorHandling("pages", async () => {
        const pageDef = APP_ROUTES.find(
          (r) => r.operationId === "pages_serve",
        )!;
        const args = { pathParams: { appId: pagesMatch[1] } };
        const body = pageDef.handler(args) as string;
        const headers =
          typeof pageDef.responseHeaders === "function"
            ? pageDef.responseHeaders(args)
            : pageDef.responseHeaders;
        return new Response(body, { headers });
      });
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

  private async handleBrowserRelayUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Promise<Response> {
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

    // When auth is enabled we accept two different kinds of token on the
    // `/v1/browser-relay` handshake:
    //
    //   1. **Capability token** — a signed `host_browser_command`
    //      capability minted by the gateway and handed to the chrome
    //      extension by the native-messaging pair flow
    //      (`/v1/browser-extension-pair`). This is the preferred,
    //      self-hosted default: the extension never has to touch a
    //      gateway JWT.
    //   2. **JWT** (audience `vellum-daemon`) — the legacy path used by
    //      the gateway-proxied cloud flow and by any compatibility
    //      callers that still hold a daemon-bound JWT. In that case we
    //      parse the JWT `sub` to extract the actor principal id and
    //      fall back to the explicit `x-guardian-id` / `guardianId`
    //      query param for service-token paths (see below).
    //
    // When auth is disabled (dev bypass), guardianId remains undefined
    // and the registration is skipped — host_browser_request routing
    // requires an authenticated guardian.
    //
    // Gateway path: when the WebSocket upgrade is proxied through the
    // gateway, the upstream token minted by `mintServiceToken()` has
    // `sub=svc:gateway:self` with no actor principal id. The gateway
    // parses the downstream edge token's `actorPrincipalId` and forwards
    // it as an explicit `guardianId` query parameter (and/or header) so
    // we can register the connection under the real guardian. Missing
    // guardian context on this path is rejected (fail closed).
    // Read the client-supplied stable instance id off the handshake.
    // The extension generates this on first run and persists it in
    // chrome.storage so it survives service-worker restarts and
    // browser restarts. The header form is preferred so gateway
    // forwarding and proxy logs don't surface instance ids in the
    // URL, but we also accept a query param for fetch-based clients
    // that can't mutate headers. An empty string is treated as absent
    // so sparse clients don't end up all sharing the same legacy key.
    const rawInstanceHeader = req.headers.get("x-client-instance-id")?.trim();
    const rawInstanceQuery = new URL(req.url).searchParams
      .get("clientInstanceId")
      ?.trim();
    const clientInstanceId =
      (rawInstanceHeader ?? "") || (rawInstanceQuery ?? "") || undefined;

    let guardianId: string | undefined;
    if (!isHttpAuthDisabled()) {
      const wsUrl = new URL(req.url);
      const token = wsUrl.searchParams.get("token");
      if (!token) {
        return httpError("UNAUTHORIZED", "Unauthorized", 401);
      }
      // 1) Capability-token path (self-hosted default). The chrome
      //    extension presents the token it received from the native
      //    messaging pair flow. We derive `guardianId` from the
      //    capability claims directly — the claims are HMAC-signed by
      //    the same daemon so there is no cross-tenant risk.
      const capabilityClaims = await verifyHostBrowserCapability(token);
      if (capabilityClaims) {
        guardianId = capabilityClaims.guardianId;
      } else {
        // 2) JWT compatibility path (gateway / legacy). Fall back to the
        //    existing verifyToken+parseSub flow so cloud callers and any
        //    old self-hosted clients still holding a daemon JWT
        //    continue to work during the cutover.
        const jwtResult = verifyToken(token, "vellum-daemon");
        if (!jwtResult.ok) {
          return httpError("UNAUTHORIZED", "Unauthorized", 401);
        }
        const subResult = parseSub(jwtResult.claims.sub);
        if (subResult.ok && subResult.actorPrincipalId) {
          // Direct actor principal — this is the loopback / desktop path.
          guardianId = subResult.actorPrincipalId;
        } else {
          // Service-token path (gateway-forwarded). The gateway must plumb
          // the resolved actor principal as an explicit `x-guardian-id`
          // header or `guardianId` query param. Header takes precedence
          // because headers are easier for the gateway to forward without
          // rewriting the URL.
          const headerGuardianId =
            req.headers.get("x-guardian-id")?.trim() ?? "";
          const queryGuardianId =
            wsUrl.searchParams.get("guardianId")?.trim() ?? "";
          const fallbackGuardianId = headerGuardianId || queryGuardianId;
          if (fallbackGuardianId) {
            guardianId = fallbackGuardianId;
          } else {
            // Fail closed: a service-token relay upgrade without a
            // guardian context cannot be routed safely. Allowing the
            // upgrade to proceed creates an unscoped socket that never
            // registers in the ChromeExtensionRegistry.
            log.warn(
              {
                principalType: subResult.ok
                  ? subResult.principalType
                  : "unknown",
                sub: jwtResult.claims.sub,
              },
              "Browser relay upgrade denied: missing guardian context on service-token path",
            );
            return httpError(
              "UNAUTHORIZED",
              "Browser relay requires guardian context",
              401,
            );
          }
        }
      }
    }

    const connectionId = crypto.randomUUID();
    const upgraded = server.upgrade(req, {
      data: {
        wsType: "browser-relay",
        connectionId,
        guardianId,
        clientInstanceId,
      } satisfies BrowserRelayWebSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  private verifyGatewayServiceToken(req: Request): Response | null {
    if (isHttpAuthDisabled()) return null;

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
    if (!subResult.ok || subResult.principalType !== "svc_gateway") {
      return httpError("UNAUTHORIZED", "Unauthorized", 401);
    }

    return null;
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

    // Verify the gateway service token before accepting the upgrade.
    const tokenError = this.verifyGatewayServiceToken(req);
    if (tokenError) return tokenError;

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

  private handleMediaStreamUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Response {
    if (!isPrivateNetworkPeer(server, req) || !isPrivateNetworkOrigin(req)) {
      return httpError(
        "FORBIDDEN",
        "Direct media-stream access disabled — only private network peers allowed",
        403,
      );
    }

    // Verify the gateway service token before accepting the upgrade.
    const tokenError = this.verifyGatewayServiceToken(req);
    if (tokenError) return tokenError;

    const wsUrl = new URL(req.url);
    const callSessionId = wsUrl.searchParams.get("callSessionId");
    if (!callSessionId) {
      return new Response("Missing callSessionId", { status: 400 });
    }
    // Media-stream connections use a distinct wsType so the open/message/close
    // handlers route them to MediaStreamCallSession instead of RelayConnection.
    const upgraded = server.upgrade(req, {
      data: {
        wsType: "media-stream",
        callSessionId,
      } satisfies MediaStreamWebSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  /**
   * Handle WebSocket upgrade for `/v1/stt/stream`.
   *
   * Private-network restrictions apply (same as relay/media-stream) so the
   * runtime remains unreachable from the public internet. The gateway
   * authenticates the downstream client and proxies the upgrade with a
   * short-lived gateway service token.
   */
  private handleSttStreamUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Response {
    if (!isPrivateNetworkPeer(server, req) || !isPrivateNetworkOrigin(req)) {
      return httpError(
        "FORBIDDEN",
        "Direct STT stream access disabled — only private network peers allowed",
        403,
      );
    }

    // Verify the gateway service token before accepting the upgrade.
    const tokenError = this.verifyGatewayServiceToken(req);
    if (tokenError) return tokenError;

    const wsUrl = new URL(req.url);
    // provider is optional compatibility metadata — the runtime resolves
    // the streaming transcriber from config (`services.stt.provider`).
    const provider = wsUrl.searchParams.get("provider") ?? undefined;
    const mimeType = wsUrl.searchParams.get("mimeType");
    if (!mimeType) {
      return new Response("Missing required query parameter: mimeType", {
        status: 400,
      });
    }

    const sampleRateRaw = wsUrl.searchParams.get("sampleRate");
    const sampleRate = sampleRateRaw ? parseInt(sampleRateRaw, 10) : undefined;

    const sessionId = crypto.randomUUID();
    const upgraded = server.upgrade(req, {
      data: {
        wsType: "stt-stream",
        provider,
        mimeType,
        sampleRate,
        sessionId,
      } satisfies SttStreamWebSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  /**
   * Handle WebSocket upgrade for `/v1/live-voice`.
   *
   * The gateway owns downstream client auth and forwards this upstream with
   * a short-lived gateway service token. The runtime accepts only private
   * network peers/origins so the shell is not publicly reachable.
   */
  private handleLiveVoiceUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Response {
    if (!isPrivateNetworkPeer(server, req) || !isPrivateNetworkOrigin(req)) {
      return httpError(
        "FORBIDDEN",
        "Direct live voice access disabled — only private network peers allowed",
        403,
      );
    }

    const tokenError = this.verifyGatewayServiceToken(req);
    if (tokenError) return tokenError;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "live-voice",
        lastSeq: 0,
      } satisfies LiveVoiceWebSocketData,
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined!;
  }

  private async handleLiveVoiceMessage(
    ws: ServerWebSocket<LiveVoiceWebSocketData>,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    if (typeof message === "string") {
      const result = parseLiveVoiceClientTextFrame(message);
      if (!result.ok) {
        this.sendLiveVoiceError(ws, result.error);
        return;
      }
      await this.dispatchLiveVoiceClientFrame(ws, result.frame);
      return;
    }

    const result = parseLiveVoiceBinaryAudioFrame(message);
    if (!result.ok) {
      this.sendLiveVoiceError(ws, result.error);
      return;
    }

    const sessionId = ws.data.sessionId;
    if (!sessionId) {
      this.sendLiveVoiceStateError(
        ws,
        "Live voice binary audio received before start",
      );
      return;
    }

    const handled = await this.liveVoiceSessionManager.handleBinaryAudio(
      sessionId,
      result.frame.data,
    );
    if (handled.status === "not_found") {
      ws.data.sessionId = undefined;
      this.sendLiveVoiceStateError(ws, "Live voice session is not active");
    }
  }

  private async dispatchLiveVoiceClientFrame(
    ws: ServerWebSocket<LiveVoiceWebSocketData>,
    frame: LiveVoiceClientFrame,
  ): Promise<void> {
    if (frame.type === "start") {
      if (ws.data.sessionId) {
        this.sendLiveVoiceStateError(ws, "Live voice session already started");
        return;
      }

      const result = await this.liveVoiceSessionManager.startSession(frame, {
        sendFrame: async (serverFrame) => {
          this.sendLiveVoiceFrame(ws, serverFrame);
        },
      });
      if (result.status === "accepted") {
        ws.data.sessionId = result.sessionId;
      }
      return;
    }

    const sessionId = ws.data.sessionId;
    if (!sessionId) {
      this.sendLiveVoiceStateError(
        ws,
        `Live voice ${frame.type} frame received before start`,
      );
      return;
    }

    const handled = await this.liveVoiceSessionManager.handleClientFrame(
      sessionId,
      frame,
    );
    if (handled.status === "not_found") {
      ws.data.sessionId = undefined;
      this.sendLiveVoiceStateError(ws, "Live voice session is not active");
      return;
    }

    if (frame.type === "end") {
      ws.data.sessionId = undefined;
    }
  }

  private sendLiveVoiceStateError(
    ws: ServerWebSocket<LiveVoiceWebSocketData>,
    message: string,
  ): void {
    this.sendLiveVoiceError(ws, {
      code: LiveVoiceProtocolErrorCode.InvalidFrame,
      message,
    });
  }

  private sendLiveVoiceError(
    ws: ServerWebSocket<LiveVoiceWebSocketData>,
    error: Pick<LiveVoiceProtocolError, "code" | "message">,
  ): void {
    this.sendLiveVoiceFrame(ws, {
      type: "error",
      seq: ws.data.lastSeq + 1,
      code: error.code,
      message: error.message,
    });
  }

  private sendLiveVoiceFrame(
    ws: ServerWebSocket<LiveVoiceWebSocketData>,
    frame: LiveVoiceServerFrame,
  ): void {
    ws.data.lastSeq = Math.max(ws.data.lastSeq, frame.seq);
    ws.send(JSON.stringify(frame));
  }

  private releaseLiveVoiceSession(
    data: LiveVoiceWebSocketData,
    reason: "websocket_close",
  ): void {
    const sessionId = data.sessionId;
    data.sessionId = undefined;
    if (!sessionId) return;

    void this.liveVoiceSessionManager
      .releaseSession(sessionId, reason)
      .catch((err) => {
        log.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            sessionId,
          },
          "Failed to release live voice session",
        );
      });
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

}
