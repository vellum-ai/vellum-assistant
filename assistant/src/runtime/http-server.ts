/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Always started on the
 * configured port (default: 7821).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ServerWebSocket } from 'bun';

import type { BrowserRelayWebSocketData } from '../browser-extension-relay/server.js';
import { extensionRelayServer } from '../browser-extension-relay/server.js';
import {
  startGuardianActionSweep,
  stopGuardianActionSweep,
} from '../calls/guardian-action-sweep.js';
import type { RelayWebSocketData } from '../calls/relay-server.js';
import { activeRelayConnections,RelayConnection } from '../calls/relay-server.js';
import {
  handleConnectAction,
  handleStatusCallback,
  handleVoiceWebhook,
} from '../calls/twilio-routes.js';
import { parseChannelId } from '../channels/types.js';
import {
  getGatewayInternalBaseUrl,
  getRuntimeGatewayOriginSecret,
  hasUngatedHttpAuthDisabled,
  isHttpAuthDisabled,
} from '../config/env.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';
import { PairingStore } from '../daemon/pairing-store.js';
import { type Confidence, getAttentionStateByConversationIds, recordConversationSeenSignal,type SignalType } from '../memory/conversation-attention-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as externalConversationStore from '../memory/external-conversation-store.js';
import { consumeCallback, consumeCallbackError } from '../security/oauth-callback-registry.js';
import { getLogger } from '../util/logger.js';
import { buildAssistantEvent } from './assistant-event.js';
import { assistantEventHub } from './assistant-event-hub.js';
import { sweepFailedEvents } from './channel-retry-sweep.js';
import { httpError } from './http-errors.js';
// Middleware
import {
  extractBearerToken,
  isLoopbackHost,
  isPrivateNetworkOrigin,
  isPrivateNetworkPeer,
  verifyBearerToken,
} from './middleware/auth.js';
import { withErrorHandling } from './middleware/error-handler.js';
import {
  apiRateLimiter,
  extractClientIp,
  ipRateLimiter,
  rateLimitHeaders,
  rateLimitResponse,
} from './middleware/rate-limiter.js';
import { withRequestLogging } from './middleware/request-logger.js';
import {
  cloneRequestWithBody,
  GATEWAY_ONLY_BLOCKED_SUBPATHS,
  GATEWAY_SUBPATH_MAP,
  TWILIO_GATEWAY_WEBHOOK_RE,
  TWILIO_WEBHOOK_RE,
  validateTwilioWebhook,
} from './middleware/twilio-validation.js';
import {
  handleDeleteSharedApp,
  handleDownloadSharedApp,
  handleGetSharedAppMetadata,
  handleServePage,
  handleShareApp,
} from './routes/app-routes.js';
import {
  handleConfirm,
  handleListPendingInteractions,
  handleSecret,
  handleTrustRule,
} from './routes/approval-routes.js';
import {
  handleDeleteAttachment,
  handleGetAttachment,
  handleGetAttachmentContent,
  handleUploadAttachment,
} from './routes/attachment-routes.js';
import {
  handleAnswerCall,
  handleCancelCall,
  handleGetCallStatus,
  handleInstructionCall,
  handleStartCall,
} from './routes/call-routes.js';
import { canonicalChannelAssistantId } from './routes/channel-route-shared.js';
import {
  handleChannelDeliveryAck,
  handleChannelInbound,
  handleDeleteConversation,
  handleListDeadLetters,
  handleReplayDeadLetters,
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
} from './routes/channel-routes.js';
import {
  handleGetContact,
  handleListContacts,
  handleMergeContacts,
} from './routes/contact-routes.js';
import { handleListConversationAttention } from './routes/conversation-attention-routes.js';
// Route handlers — grouped by domain
import {
  handleGetSuggestion,
  handleListMessages,
  handleSearchConversations,
  handleSendMessage,
} from './routes/conversation-routes.js';
import { handleDebug } from './routes/debug-routes.js';
import { handleSubscribeAssistantEvents } from './routes/events-routes.js';
import {
  handleGuardianActionDecision,
  handleGuardianActionsPending,
} from './routes/guardian-action-routes.js';
import { handleGetIdentity,handleHealth } from './routes/identity-routes.js';
import {
  handleBlockMember,
  handleCreateInvite,
  handleListInvites,
  handleListMembers,
  handleRedeemInvite,
  handleRevokeInvite,
  handleRevokeMember,
  handleUpsertMember,
} from './routes/ingress-routes.js';
import {
  handleCancelOutbound,
  handleClearSlackChannelConfig,
  handleClearTelegramConfig,
  handleCreateGuardianChallenge,
  handleGetGuardianStatus,
  handleGetSlackChannelConfig,
  handleGetTelegramConfig,
  handleResendOutbound,
  handleSetSlackChannelConfig,
  handleSetTelegramCommands,
  handleSetTelegramConfig,
  handleSetupTelegram,
  handleStartOutbound,
} from './routes/integration-routes.js';
import type { PairingHandlerContext } from './routes/pairing-routes.js';
// Extracted route handlers
import {
  handlePairingRegister,
  handlePairingRequest,
  handlePairingStatus,
} from './routes/pairing-routes.js';
import { handleAddSecret } from './routes/secret-routes.js';

// Re-export for consumers
export { isPrivateAddress } from './middleware/auth.js';

// Re-export shared types so existing consumers don't need to update imports
export type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
  NonBlockingMessageProcessor,
  RuntimeAttachmentMetadata,
  RuntimeHttpServerOptions,
  RuntimeMessageSessionOptions,
  SendMessageDeps,
} from './http-types.js';

import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
  NonBlockingMessageProcessor,
  RuntimeHttpServerOptions,
  SendMessageDeps,
} from './http-types.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;
const DEFAULT_HOSTNAME = '127.0.0.1';

/** Global hard cap on request body size (50 MB). */
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private hostname: string;
  private bearerToken: string | undefined;
  private processMessage?: MessageProcessor;
  private persistAndProcessMessage?: NonBlockingMessageProcessor;
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

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;
    this.bearerToken = options.bearerToken;
    this.processMessage = options.processMessage;
    this.persistAndProcessMessage = options.persistAndProcessMessage;
    this.approvalCopyGenerator = options.approvalCopyGenerator;
    this.approvalConversationGenerator = options.approvalConversationGenerator;
    this.guardianActionCopyGenerator = options.guardianActionCopyGenerator;
    this.guardianFollowUpConversationGenerator = options.guardianFollowUpConversationGenerator;
    this.interfacesDir = options.interfacesDir ?? null;
    this.sendMessageDeps = options.sendMessageDeps;
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
      const tokenPath = join(baseDir, '.vellum', 'feature-flag-token');
      const token = readFileSync(tokenPath, 'utf-8').trim();
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
            void assistantEventHub.publish(buildAssistantEvent('self', msg));
          }
        : undefined,
    };
  }

  async start(): Promise<void> {
    type AllWebSocketData = RelayWebSocketData | BrowserRelayWebSocketData;
    this.server = Bun.serve<AllWebSocketData>({
      port: this.port,
      hostname: this.hostname,
      idleTimeout: 1800,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open(ws) {
          const data = ws.data as AllWebSocketData;
          if ('wsType' in data && data.wsType === 'browser-relay') {
            extensionRelayServer.handleOpen(ws as ServerWebSocket<BrowserRelayWebSocketData>);
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          log.info({ callSessionId }, 'ConversationRelay WebSocket opened');
          if (callSessionId) {
            const connection = new RelayConnection(ws as ServerWebSocket<RelayWebSocketData>, callSessionId);
            activeRelayConnections.set(callSessionId, connection);
          }
        },
        message(ws, message) {
          const data = ws.data as AllWebSocketData;
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
          if ('wsType' in data && data.wsType === 'browser-relay') {
            extensionRelayServer.handleMessage(ws as ServerWebSocket<BrowserRelayWebSocketData>, raw);
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
          if ('wsType' in data && data.wsType === 'browser-relay') {
            extensionRelayServer.handleClose(ws as ServerWebSocket<BrowserRelayWebSocketData>, code, reason?.toString());
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          log.info({ callSessionId, code, reason: reason?.toString() }, 'ConversationRelay WebSocket closed');
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
      const bt = this.bearerToken;
      this.retrySweepTimer = setInterval(() => {
        if (this.sweepInProgress) return;
        this.sweepInProgress = true;
        sweepFailedEvents(pm, bt).finally(() => { this.sweepInProgress = false; });
      }, 30_000);
    }

    startGuardianExpirySweep(getGatewayInternalBaseUrl(), this.bearerToken, this.approvalCopyGenerator);
    log.info('Guardian approval expiry sweep started');

    startGuardianActionSweep(getGatewayInternalBaseUrl(), this.bearerToken, this.guardianActionCopyGenerator);
    log.info('Guardian action expiry sweep started');

    log.info('Running in gateway-only ingress mode. Direct webhook routes disabled.');
    if (!isLoopbackHost(this.hostname)) {
      log.warn('RUNTIME_HTTP_HOST is not bound to loopback. This may expose the runtime to direct public access.');
    }

    this.pairingStore.start();

    if (hasUngatedHttpAuthDisabled()) {
      log.warn('DISABLE_HTTP_AUTH is set but VELLUM_UNSAFE_AUTH_BYPASS=1 is not — auth bypass is IGNORED and HTTP authentication remains enabled. Set VELLUM_UNSAFE_AUTH_BYPASS=1 to confirm the bypass.');
    } else if (isHttpAuthDisabled()) {
      log.warn('DISABLE_HTTP_AUTH is set — HTTP API authentication is DISABLED. All API endpoints are accessible without a bearer token. Do not use in production.');
    }

    log.info({ port: this.actualPort, hostname: this.hostname, auth: !!this.bearerToken }, 'Runtime HTTP server listening');
  }

  async stop(): Promise<void> {
    this.pairingStore.stop();
    stopGuardianExpirySweep();
    stopGuardianActionSweep();
    if (this.retrySweepTimer) {
      clearInterval(this.retrySweepTimer);
      this.retrySweepTimer = null;
    }
    if (this.server) {
      this.server.stop(true);
      this.server = null;
      log.info('Runtime HTTP server stopped');
    }
  }

  private async handleRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    return withRequestLogging(req, () => this.routeRequest(req, server));
  }

  private async routeRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/healthz' && req.method === 'GET') {
      return handleHealth();
    }

    // WebSocket upgrade for the Chrome extension browser relay.
    if (path === '/v1/browser-relay' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.handleBrowserRelayUpgrade(req, server);
    }

    // WebSocket upgrade for ConversationRelay — before auth check because
    // Twilio WebSocket connections don't use bearer tokens.
    if (path.startsWith('/v1/calls/relay') && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.handleRelayUpgrade(req, server);
    }

    // Twilio webhook endpoints — before auth check because Twilio
    // webhook POSTs don't include bearer tokens.
    const twilioResponse = await this.handleTwilioWebhook(req, path);
    if (twilioResponse) return twilioResponse;

    // Pairing endpoints (unauthenticated, secret-gated)
    if (path === '/v1/pairing/request' && req.method === 'POST') {
      return await handlePairingRequest(req, this.pairingContext);
    }
    if (path === '/v1/pairing/status' && req.method === 'GET') {
      return handlePairingStatus(url, this.pairingContext);
    }

    // Require bearer token when configured
    if (!isHttpAuthDisabled() && this.bearerToken) {
      const token = extractBearerToken(req);
      if (!token || !verifyBearerToken(token, this.bearerToken)) {
        return httpError('UNAUTHORIZED', 'Unauthorized', 401);
      }
    }

    // Per-client-IP rate limiting for /v1/* endpoints. Authenticated requests
    // get a higher limit; unauthenticated requests get a lower limit to reduce
    // abuse surface. We key on IP rather than bearer token because the gateway
    // uses a single shared token for all proxied requests, which would collapse
    // all users into one bucket.
    if (path.startsWith('/v1/')) {
      const clientIp = extractClientIp(req, server);
      const token = extractBearerToken(req);
      const result = token
        ? apiRateLimiter.check(clientIp)
        : ipRateLimiter.check(clientIp);
      if (!result.allowed) {
        return rateLimitResponse(result);
      }
      // Attach rate limit headers to the eventual response
      const originalResponse = await this.handleAuthenticatedRequest(req, url, path);
      const headers = new Headers(originalResponse.headers);
      for (const [k, v] of Object.entries(rateLimitHeaders(result))) {
        headers.set(k, v);
      }
      return new Response(originalResponse.body, {
        status: originalResponse.status,
        statusText: originalResponse.statusText,
        headers,
      });
    }

    return this.handleAuthenticatedRequest(req, url, path);
  }

  /**
   * Handle requests that have already passed auth and rate limiting.
   */
  private async handleAuthenticatedRequest(req: Request, url: URL, path: string): Promise<Response> {
    // Pairing registration (bearer-authenticated)
    if (path === '/v1/pairing/register' && req.method === 'POST') {
      return await handlePairingRegister(req, this.pairingContext);
    }

    // Serve shareable app pages
    const pagesMatch = path.match(/^\/pages\/([^/]+)$/);
    if (pagesMatch && req.method === 'GET') {
      try {
        return handleServePage(pagesMatch[1]);
      } catch (err) {
        log.error({ err, appId: pagesMatch[1] }, 'Runtime HTTP handler error serving page');
        return httpError('INTERNAL_ERROR', 'Internal server error', 500);
      }
    }

    // Cloud sharing endpoints
    if (path === '/v1/apps/share' && req.method === 'POST') {
      try { return await handleShareApp(req); } catch (err) {
        log.error({ err }, 'Runtime HTTP handler error sharing app');
        return httpError('INTERNAL_ERROR', 'Internal server error', 500);
      }
    }

    const sharedTokenMatch = path.match(/^\/v1\/apps\/shared\/([^/]+)$/);
    if (sharedTokenMatch) {
      const shareToken = sharedTokenMatch[1];
      if (req.method === 'GET') {
        try { return handleDownloadSharedApp(shareToken); } catch (err) {
          log.error({ err, shareToken }, 'Runtime HTTP handler error downloading shared app');
          return httpError('INTERNAL_ERROR', 'Internal server error', 500);
        }
      }
      if (req.method === 'DELETE') {
        try { return handleDeleteSharedApp(shareToken); } catch (err) {
          log.error({ err, shareToken }, 'Runtime HTTP handler error deleting shared app');
          return httpError('INTERNAL_ERROR', 'Internal server error', 500);
        }
      }
    }

    const sharedMetadataMatch = path.match(/^\/v1\/apps\/shared\/([^/]+)\/metadata$/);
    if (sharedMetadataMatch && req.method === 'GET') {
      try { return handleGetSharedAppMetadata(sharedMetadataMatch[1]); } catch (err) {
        log.error({ err, shareToken: sharedMetadataMatch[1] }, 'Runtime HTTP handler error getting shared app metadata');
        return httpError('INTERNAL_ERROR', 'Internal server error', 500);
      }
    }

    // Secret management endpoint
    if (path === '/v1/secrets' && req.method === 'POST') {
      try { return await handleAddSecret(req); } catch (err) {
        log.error({ err }, 'Runtime HTTP handler error adding secret');
        return httpError('INTERNAL_ERROR', 'Internal server error', 500);
      }
    }

    // New assistant-less runtime routes: /v1/<endpoint>
    const newRouteMatch = path.match(/^\/v1\/(?!assistants\/)(.+)$/);
    if (newRouteMatch) {
      return this.dispatchEndpoint(newRouteMatch[1], req, url);
    }

    // Legacy: /v1/assistants/:assistantId/<endpoint>
    const match = path.match(/^\/v1\/assistants\/([^/]+)\/(.+)$/);
    if (!match) {
      return httpError('NOT_FOUND', 'Not found', 404);
    }

    const assistantId = canonicalChannelAssistantId(match[1]);
    const endpoint = match[2];
    log.warn({ endpoint, assistantId }, '[deprecated] /v1/assistants/:assistantId/... route used; migrate to /v1/...');
    return this.dispatchEndpoint(endpoint, req, url, assistantId);
  }

  private handleBrowserRelayUpgrade(req: Request, server: ReturnType<typeof Bun.serve>): Response {
    if (!isLoopbackHost(new URL(req.url).hostname) && !isPrivateNetworkPeer(server, req)) {
      return httpError('FORBIDDEN', 'Browser relay only accepts connections from localhost', 403);
    }

    if (!isHttpAuthDisabled() && this.bearerToken) {
      const wsUrl = new URL(req.url);
      const token = wsUrl.searchParams.get('token');
      if (!token || !verifyBearerToken(token, this.bearerToken)) {
        return httpError('UNAUTHORIZED', 'Unauthorized', 401);
      }
    }

    const connectionId = crypto.randomUUID();
    const upgraded = server.upgrade(req, {
      data: { wsType: 'browser-relay', connectionId } satisfies BrowserRelayWebSocketData,
    });
    if (!upgraded) {
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  private handleRelayUpgrade(req: Request, server: ReturnType<typeof Bun.serve>): Response {
    if (!isPrivateNetworkPeer(server, req) || !isPrivateNetworkOrigin(req)) {
      return httpError('FORBIDDEN', 'Direct relay access disabled — only private network peers allowed', 403);
    }

    const wsUrl = new URL(req.url);
    const callSessionId = wsUrl.searchParams.get('callSessionId');
    if (!callSessionId) {
      return new Response('Missing callSessionId', { status: 400 });
    }
    const upgraded = server.upgrade(req, { data: { callSessionId } });
    if (!upgraded) {
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
    // Bun's WebSocket upgrade consumes the request — no Response is sent.
    return undefined!;
  }

  private async handleTwilioWebhook(req: Request, path: string): Promise<Response | null> {
    const twilioMatch = path.match(TWILIO_WEBHOOK_RE);
    const gatewayTwilioMatch = !twilioMatch ? path.match(TWILIO_GATEWAY_WEBHOOK_RE) : null;
    const resolvedTwilioSubpath = twilioMatch
      ? twilioMatch[1]
      : gatewayTwilioMatch
        ? GATEWAY_SUBPATH_MAP[gatewayTwilioMatch[1]]
        : null;
    if (!resolvedTwilioSubpath || req.method !== 'POST') return null;

    const twilioSubpath = resolvedTwilioSubpath;

    if (GATEWAY_ONLY_BLOCKED_SUBPATHS.has(twilioSubpath)) {
      return httpError('GONE', 'Direct webhook access disabled. Use the gateway.', 410);
    }

    const validation = await validateTwilioWebhook(req);
    if (validation instanceof Response) return validation;

    const validatedReq = cloneRequestWithBody(req, validation.body);

    if (twilioSubpath === 'voice-webhook') return await handleVoiceWebhook(validatedReq);
    if (twilioSubpath === 'status') return await handleStatusCallback(validatedReq);
    if (twilioSubpath === 'connect-action') return await handleConnectAction(validatedReq);

    return null;
  }

  /**
   * Dispatch a request to the appropriate endpoint handler.
   */
  private async dispatchEndpoint(
    endpoint: string,
    req: Request,
    url: URL,
    assistantId: string = 'self',
  ): Promise<Response> {
    return withErrorHandling(endpoint, async () => {
      if (endpoint === 'health' && req.method === 'GET') return handleHealth();
      if (endpoint === 'debug' && req.method === 'GET') return handleDebug();

      if (endpoint === 'browser-relay/status' && req.method === 'GET') {
        return Response.json(extensionRelayServer.getStatus());
      }

      if (endpoint === 'browser-relay/command' && req.method === 'POST') {
        try {
          const body = await req.json() as Record<string, unknown>;
          const resp = await extensionRelayServer.sendCommand(body as Omit<import('../browser-extension-relay/protocol.js').ExtensionCommand, 'id'>);
          return Response.json(resp);
        } catch (err) {
          return httpError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err), 500);
        }
      }

      if (endpoint === 'conversations' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const conversations = conversationStore.listConversations(limit, false, offset);
        const totalCount = conversationStore.countConversations();
        const conversationIds = conversations.map((c) => c.id);
        const bindings = externalConversationStore.getBindingsForConversations(conversationIds);
        const attentionStates = getAttentionStateByConversationIds(conversationIds);
        return Response.json({
          sessions: conversations.map((c) => {
            const binding = bindings.get(c.id);
            const originChannel = parseChannelId(c.originChannel);
            const attn = attentionStates.get(c.id);
            const assistantAttention = attn ? {
              hasUnseenLatestAssistantMessage: attn.latestAssistantMessageAt != null &&
                (attn.lastSeenAssistantMessageAt == null || attn.lastSeenAssistantMessageAt < attn.latestAssistantMessageAt),
              ...(attn.latestAssistantMessageAt != null ? { latestAssistantMessageAt: attn.latestAssistantMessageAt } : {}),
              ...(attn.lastSeenAssistantMessageAt != null ? { lastSeenAssistantMessageAt: attn.lastSeenAssistantMessageAt } : {}),
              ...(attn.lastSeenConfidence != null ? { lastSeenConfidence: attn.lastSeenConfidence } : {}),
              ...(attn.lastSeenSignalType != null ? { lastSeenSignalType: attn.lastSeenSignalType } : {}),
            } : undefined;
            return {
              id: c.id,
              title: c.title ?? 'Untitled',
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
              threadType: c.threadType === 'private' ? 'private' : 'standard',
              source: c.source ?? 'user',
              ...(binding ? {
                channelBinding: {
                  sourceChannel: binding.sourceChannel,
                  externalChatId: binding.externalChatId,
                  externalUserId: binding.externalUserId,
                  displayName: binding.displayName,
                  username: binding.username,
                },
              } : {}),
              ...(originChannel ? { conversationOriginChannel: originChannel } : {}),
              ...(assistantAttention ? { assistantAttention } : {}),
            };
          }),
          hasMore: offset + conversations.length < totalCount,
        });
      }

      if (endpoint === 'conversations/attention' && req.method === 'GET') return handleListConversationAttention(url);

      if (endpoint === 'conversations/seen' && req.method === 'POST') {
        const body = await req.json() as Record<string, unknown>;
        const conversationId = body.conversationId as string | undefined;
        if (!conversationId) return httpError('BAD_REQUEST', 'Missing conversationId', 400);
        try {
          recordConversationSeenSignal({
            conversationId,
            assistantId: 'self',
            sourceChannel: (body.sourceChannel as string) ?? 'vellum',
            signalType: (body.signalType as string ?? 'macos_conversation_opened') as SignalType,
            confidence: (body.confidence as string ?? 'explicit') as Confidence,
            source: (body.source as string) ?? 'http-api',
            evidenceText: body.evidenceText as string | undefined,
            metadata: body.metadata as Record<string, unknown> | undefined,
            observedAt: body.observedAt as number | undefined,
          });
          return Response.json({ ok: true });
        } catch (err) {
          log.error({ err, conversationId }, 'POST /v1/conversations/seen: failed');
          return httpError('INTERNAL_ERROR', 'Failed to record seen signal', 500);
        }
      }

      if (endpoint === 'messages' && req.method === 'GET') return handleListMessages(url, this.interfacesDir);
      if (endpoint === 'search' && req.method === 'GET') return handleSearchConversations(url);

      if (endpoint === 'messages' && req.method === 'POST') {
        return await handleSendMessage(req, {
          processMessage: this.processMessage,
          persistAndProcessMessage: this.persistAndProcessMessage,
          sendMessageDeps: this.sendMessageDeps,
        });
      }

      // Standalone approval endpoints — keyed by requestId, orthogonal to message sending
      if (endpoint === 'confirm' && req.method === 'POST') return await handleConfirm(req);
      if (endpoint === 'secret' && req.method === 'POST') return await handleSecret(req);
      if (endpoint === 'trust-rules' && req.method === 'POST') return await handleTrustRule(req);
      if (endpoint === 'pending-interactions' && req.method === 'GET') return handleListPendingInteractions(url);

      // Guardian action endpoints — deterministic button-based decisions
      if (endpoint === 'guardian-actions/pending' && req.method === 'GET') return handleGuardianActionsPending(req);
      if (endpoint === 'guardian-actions/decision' && req.method === 'POST') return await handleGuardianActionDecision(req);

      // Contacts
      if (endpoint === 'contacts' && req.method === 'GET') return handleListContacts(url);
      if (endpoint === 'contacts/merge' && req.method === 'POST') return await handleMergeContacts(req);
      const contactMatch = endpoint.match(/^contacts\/([^/]+)$/);
      if (contactMatch && req.method === 'GET') return handleGetContact(contactMatch[1]);

      // Ingress members
      if (endpoint === 'ingress/members' && req.method === 'GET') return handleListMembers(url);
      if (endpoint === 'ingress/members' && req.method === 'POST') return await handleUpsertMember(req);
      const memberBlockMatch = endpoint.match(/^ingress\/members\/([^/]+)\/block$/);
      if (memberBlockMatch && req.method === 'POST') return await handleBlockMember(req, memberBlockMatch[1]);
      const memberMatch = endpoint.match(/^ingress\/members\/([^/]+)$/);
      if (memberMatch && req.method === 'DELETE') return await handleRevokeMember(req, memberMatch[1]);

      // Ingress invites
      if (endpoint === 'ingress/invites' && req.method === 'GET') return handleListInvites(url);
      if (endpoint === 'ingress/invites' && req.method === 'POST') return await handleCreateInvite(req);
      if (endpoint === 'ingress/invites/redeem' && req.method === 'POST') return await handleRedeemInvite(req);
      const inviteMatch = endpoint.match(/^ingress\/invites\/([^/]+)$/);
      if (inviteMatch && req.method === 'DELETE') return handleRevokeInvite(inviteMatch[1]);

      // Integrations — Telegram config
      if (endpoint === 'integrations/telegram/config' && req.method === 'GET') return handleGetTelegramConfig();
      if (endpoint === 'integrations/telegram/config' && req.method === 'POST') return await handleSetTelegramConfig(req);
      if (endpoint === 'integrations/telegram/config' && req.method === 'DELETE') return await handleClearTelegramConfig();
      if (endpoint === 'integrations/telegram/commands' && req.method === 'POST') return await handleSetTelegramCommands(req);
      if (endpoint === 'integrations/telegram/setup' && req.method === 'POST') return await handleSetupTelegram(req);

      // Integrations — Slack channel config
      if (endpoint === 'integrations/slack/channel/config' && req.method === 'GET') return handleGetSlackChannelConfig();
      if (endpoint === 'integrations/slack/channel/config' && req.method === 'POST') return await handleSetSlackChannelConfig(req);
      if (endpoint === 'integrations/slack/channel/config' && req.method === 'DELETE') return handleClearSlackChannelConfig();

      // Integrations — Guardian verification
      if (endpoint === 'integrations/guardian/challenge' && req.method === 'POST') return await handleCreateGuardianChallenge(req);
      if (endpoint === 'integrations/guardian/status' && req.method === 'GET') return handleGetGuardianStatus(url);
      if (endpoint === 'integrations/guardian/outbound/start' && req.method === 'POST') return await handleStartOutbound(req);
      if (endpoint === 'integrations/guardian/outbound/resend' && req.method === 'POST') return await handleResendOutbound(req);
      if (endpoint === 'integrations/guardian/outbound/cancel' && req.method === 'POST') return await handleCancelOutbound(req);

      if (endpoint === 'attachments' && req.method === 'POST') return await handleUploadAttachment(req);
      if (endpoint === 'attachments' && req.method === 'DELETE') return await handleDeleteAttachment(req);

      const attachmentContentMatch = endpoint.match(/^attachments\/([^/]+)\/content$/);
      if (attachmentContentMatch && req.method === 'GET') return handleGetAttachmentContent(attachmentContentMatch[1], req);

      const attachmentMatch = endpoint.match(/^attachments\/([^/]+)$/);
      if (attachmentMatch && req.method === 'GET') return handleGetAttachment(attachmentMatch[1]);

      if (endpoint === 'suggestion' && req.method === 'GET') {
        return await handleGetSuggestion(url, {
          suggestionCache: this.suggestionCache,
          suggestionInFlight: this.suggestionInFlight,
        });
      }

      const interfacesMatch = endpoint.match(/^interfaces\/(.+)$/);
      if (interfacesMatch && req.method === 'GET') return this.handleGetInterface(interfacesMatch[1]);

      if (endpoint === 'channels/conversation' && req.method === 'DELETE') return await handleDeleteConversation(req, assistantId);

      if (endpoint === 'channels/inbound' && req.method === 'POST') {
        const gatewayOriginSecret = getRuntimeGatewayOriginSecret();
        return await handleChannelInbound(req, this.processMessage, this.bearerToken, assistantId, gatewayOriginSecret, this.approvalCopyGenerator, this.approvalConversationGenerator, this.guardianActionCopyGenerator, this.guardianFollowUpConversationGenerator);
      }

      if (endpoint === 'channels/delivery-ack' && req.method === 'POST') return await handleChannelDeliveryAck(req);
      if (endpoint === 'channels/dead-letters' && req.method === 'GET') return handleListDeadLetters();
      if (endpoint === 'channels/replay' && req.method === 'POST') return await handleReplayDeadLetters(req);

      if (endpoint === 'calls/start' && req.method === 'POST') return await handleStartCall(req, assistantId);

      const callsMatch = endpoint.match(/^calls\/([^/]+?)(\/cancel|\/answer|\/instruction)?$/);
      if (callsMatch) {
        const callSessionId = callsMatch[1];
        if (callSessionId !== 'twilio' && callSessionId !== 'relay' && callSessionId !== 'start') {
          if (callsMatch[2] === '/cancel' && req.method === 'POST') return await handleCancelCall(req, callSessionId);
          if (callsMatch[2] === '/answer' && req.method === 'POST') return await handleAnswerCall(req, callSessionId);
          if (callsMatch[2] === '/instruction' && req.method === 'POST') return await handleInstructionCall(req, callSessionId);
          if (!callsMatch[2] && req.method === 'GET') return handleGetCallStatus(callSessionId);
        }
      }

      // Internal Twilio forwarding endpoints (gateway -> runtime)
      if (endpoint === 'internal/twilio/voice-webhook' && req.method === 'POST') {
        const json = await req.json() as { params: Record<string, string>; originalUrl?: string; assistantId?: string };
        const formBody = new URLSearchParams(json.params).toString();
        const reconstructedUrl = json.originalUrl ?? req.url;
        const fakeReq = new Request(reconstructedUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody });
        return await handleVoiceWebhook(fakeReq, json.assistantId);
      }

      if (endpoint === 'internal/twilio/status' && req.method === 'POST') {
        const json = await req.json() as { params: Record<string, string> };
        const formBody = new URLSearchParams(json.params).toString();
        const fakeReq = new Request(req.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody });
        return await handleStatusCallback(fakeReq);
      }

      if (endpoint === 'internal/twilio/connect-action' && req.method === 'POST') {
        const json = await req.json() as { params: Record<string, string> };
        const formBody = new URLSearchParams(json.params).toString();
        const fakeReq = new Request(req.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody });
        return await handleConnectAction(fakeReq);
      }

      if (endpoint === 'identity' && req.method === 'GET') return handleGetIdentity();
      if (endpoint === 'events' && req.method === 'GET') return handleSubscribeAssistantEvents(req, url);

      // Internal OAuth callback endpoint (gateway -> runtime)
      if (endpoint === 'internal/oauth/callback' && req.method === 'POST') {
        const json = await req.json() as { state: string; code?: string; error?: string };
        if (!json.state) return httpError('BAD_REQUEST', 'Missing state parameter', 400);
        if (json.error) {
          const consumed = consumeCallbackError(json.state, json.error);
          return consumed ? Response.json({ ok: true }) : httpError('NOT_FOUND', 'Unknown state', 404);
        }
        if (json.code) {
          const consumed = consumeCallback(json.state, json.code);
          return consumed ? Response.json({ ok: true }) : httpError('NOT_FOUND', 'Unknown state', 404);
        }
        return httpError('BAD_REQUEST', 'Missing code or error parameter', 400);
      }

      return httpError('NOT_FOUND', 'Not found', 404);
    });
  }

  private handleGetInterface(interfacePath: string): Response {
    if (!this.interfacesDir) {
      return httpError('NOT_FOUND', 'Interface not found', 404);
    }
    const fullPath = resolve(this.interfacesDir, interfacePath);
    if (
      (fullPath !== this.interfacesDir && !fullPath.startsWith(this.interfacesDir + '/')) ||
      !existsSync(fullPath)
    ) {
      return httpError('NOT_FOUND', 'Interface not found', 404);
    }
    const source = readFileSync(fullPath, 'utf-8');
    return new Response(source, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
