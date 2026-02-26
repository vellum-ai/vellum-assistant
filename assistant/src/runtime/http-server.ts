/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Always started on the
 * configured port (default: 7821).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  isHttpAuthDisabled,
} from '../config/env.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';
import { PairingStore } from '../daemon/pairing-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as externalConversationStore from '../memory/external-conversation-store.js';
import { consumeCallback, consumeCallbackError } from '../security/oauth-callback-registry.js';
import { getLogger } from '../util/logger.js';
import { buildAssistantEvent } from './assistant-event.js';
import { assistantEventHub } from './assistant-event-hub.js';
import { sweepFailedEvents } from './channel-retry-sweep.js';
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
// Route handlers — grouped by domain
import {
  handleGetSuggestion,
  handleListMessages,
  handleSearchConversations,
  handleSendMessage,
} from './routes/conversation-routes.js';
import { handleSubscribeAssistantEvents } from './routes/events-routes.js';
import { handleGetIdentity,handleHealth } from './routes/identity-routes.js';
import {
  handleCancelOutbound,
  handleClearTelegramConfig,
  handleCreateGuardianChallenge,
  handleGetGuardianStatus,
  handleGetTelegramConfig,
  handleResendOutbound,
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

  private get pairingContext(): PairingHandlerContext {
    const ipcBroadcast = this.pairingBroadcast;
    return {
      pairingStore: this.pairingStore,
      bearerToken: this.bearerToken,
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
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open(ws) {
          const data = ws.data as AllWebSocketData;
          if ('wsType' in data && data.wsType === 'browser-relay') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            extensionRelayServer.handleOpen(ws as any);
            return;
          }
          const callSessionId = (data as RelayWebSocketData).callSessionId;
          log.info({ callSessionId }, 'ConversationRelay WebSocket opened');
          if (callSessionId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const connection = new RelayConnection(ws as any, callSessionId);
            activeRelayConnections.set(callSessionId, connection);
          }
        },
        message(ws, message) {
          const data = ws.data as AllWebSocketData;
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
          if ('wsType' in data && data.wsType === 'browser-relay') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            extensionRelayServer.handleMessage(ws as any, raw);
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            extensionRelayServer.handleClose(ws as any, code, reason?.toString());
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

    startGuardianActionSweep(getGatewayInternalBaseUrl(), this.bearerToken);
    log.info('Guardian action expiry sweep started');

    log.info('Running in gateway-only ingress mode. Direct webhook routes disabled.');
    if (!isLoopbackHost(this.hostname)) {
      log.warn('RUNTIME_HTTP_HOST is not bound to loopback. This may expose the runtime to direct public access.');
    }

    this.pairingStore.start();

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
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

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
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    // Cloud sharing endpoints
    if (path === '/v1/apps/share' && req.method === 'POST') {
      try { return await handleShareApp(req); } catch (err) {
        log.error({ err }, 'Runtime HTTP handler error sharing app');
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    const sharedTokenMatch = path.match(/^\/v1\/apps\/shared\/([^/]+)$/);
    if (sharedTokenMatch) {
      const shareToken = sharedTokenMatch[1];
      if (req.method === 'GET') {
        try { return handleDownloadSharedApp(shareToken); } catch (err) {
          log.error({ err, shareToken }, 'Runtime HTTP handler error downloading shared app');
          return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
      }
      if (req.method === 'DELETE') {
        try { return handleDeleteSharedApp(shareToken); } catch (err) {
          log.error({ err, shareToken }, 'Runtime HTTP handler error deleting shared app');
          return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
      }
    }

    const sharedMetadataMatch = path.match(/^\/v1\/apps\/shared\/([^/]+)\/metadata$/);
    if (sharedMetadataMatch && req.method === 'GET') {
      try { return handleGetSharedAppMetadata(sharedMetadataMatch[1]); } catch (err) {
        log.error({ err, shareToken: sharedMetadataMatch[1] }, 'Runtime HTTP handler error getting shared app metadata');
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    // Secret management endpoint
    if (path === '/v1/secrets' && req.method === 'POST') {
      try { return await handleAddSecret(req); } catch (err) {
        log.error({ err }, 'Runtime HTTP handler error adding secret');
        return Response.json({ error: 'Internal server error' }, { status: 500 });
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
      return Response.json({ error: 'Not found', source: 'runtime' }, { status: 404 });
    }

    const assistantId = canonicalChannelAssistantId(match[1]);
    const endpoint = match[2];
    log.warn({ endpoint, assistantId }, '[deprecated] /v1/assistants/:assistantId/... route used; migrate to /v1/...');
    return this.dispatchEndpoint(endpoint, req, url, assistantId);
  }

  private handleBrowserRelayUpgrade(req: Request, server: ReturnType<typeof Bun.serve>): Response {
    if (!isLoopbackHost(new URL(req.url).hostname) && !isPrivateNetworkPeer(server, req)) {
      return Response.json(
        { error: 'Browser relay only accepts connections from localhost', code: 'LOCALHOST_ONLY' },
        { status: 403 },
      );
    }

    if ((process.env.DISABLE_HTTP_AUTH ?? '').toLowerCase() !== 'true' && this.bearerToken) {
      const wsUrl = new URL(req.url);
      const token = wsUrl.searchParams.get('token');
      if (!token || !verifyBearerToken(token, this.bearerToken)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const connectionId = crypto.randomUUID();
    const upgraded = server.upgrade(req, {
      data: { wsType: 'browser-relay', connectionId } satisfies BrowserRelayWebSocketData,
    });
    if (!upgraded) {
      return new Response('WebSocket upgrade failed', { status: 500 });
    }
    return undefined as unknown as Response;
  }

  private handleRelayUpgrade(req: Request, server: ReturnType<typeof Bun.serve>): Response {
    if (!isPrivateNetworkPeer(server, req) || !isPrivateNetworkOrigin(req)) {
      return Response.json(
        { error: 'Direct relay access disabled — only private network peers allowed', code: 'GATEWAY_ONLY' },
        { status: 403 },
      );
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
    return undefined as unknown as Response;
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
      return Response.json(
        { error: 'Direct webhook access disabled. Use the gateway.', code: 'GATEWAY_ONLY' },
        { status: 410 },
      );
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

      if (endpoint === 'browser-relay/status' && req.method === 'GET') {
        return Response.json(extensionRelayServer.getStatus());
      }

      if (endpoint === 'browser-relay/command' && req.method === 'POST') {
        try {
          const body = await req.json() as Record<string, unknown>;
          const resp = await extensionRelayServer.sendCommand(body as Omit<import('../browser-extension-relay/protocol.js').ExtensionCommand, 'id'>);
          return Response.json(resp);
        } catch (err) {
          return Response.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      }

      if (endpoint === 'conversations' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const conversations = conversationStore.listConversations(limit, false, offset);
        const totalCount = conversationStore.countConversations();
        const bindings = externalConversationStore.getBindingsForConversations(
          conversations.map((c) => c.id),
        );
        return Response.json({
          sessions: conversations.map((c) => {
            const binding = bindings.get(c.id);
            const originChannel = parseChannelId(c.originChannel);
            return {
              id: c.id,
              title: c.title ?? 'Untitled',
              updatedAt: c.updatedAt,
              threadType: c.threadType === 'private' ? 'private' : 'standard',
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
            };
          }),
          hasMore: offset + conversations.length < totalCount,
        });
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

      // Contacts
      if (endpoint === 'contacts' && req.method === 'GET') return handleListContacts(url);
      if (endpoint === 'contacts/merge' && req.method === 'POST') return await handleMergeContacts(req);
      const contactMatch = endpoint.match(/^contacts\/([^/]+)$/);
      if (contactMatch && req.method === 'GET') return handleGetContact(contactMatch[1]);

      // Integrations — Telegram config
      if (endpoint === 'integrations/telegram/config' && req.method === 'GET') return handleGetTelegramConfig();
      if (endpoint === 'integrations/telegram/config' && req.method === 'POST') return await handleSetTelegramConfig(req);
      if (endpoint === 'integrations/telegram/config' && req.method === 'DELETE') return await handleClearTelegramConfig();
      if (endpoint === 'integrations/telegram/commands' && req.method === 'POST') return await handleSetTelegramCommands(req);
      if (endpoint === 'integrations/telegram/setup' && req.method === 'POST') return await handleSetupTelegram(req);

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
        return await handleChannelInbound(req, this.processMessage, this.bearerToken, assistantId, gatewayOriginSecret, this.approvalCopyGenerator, this.approvalConversationGenerator);
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
        if (!json.state) return Response.json({ error: 'Missing state parameter' }, { status: 400 });
        if (json.error) {
          const consumed = consumeCallbackError(json.state, json.error);
          return consumed ? Response.json({ ok: true }) : Response.json({ error: 'Unknown state' }, { status: 404 });
        }
        if (json.code) {
          const consumed = consumeCallback(json.state, json.code);
          return consumed ? Response.json({ ok: true }) : Response.json({ error: 'Unknown state' }, { status: 404 });
        }
        return Response.json({ error: 'Missing code or error parameter' }, { status: 400 });
      }

      return Response.json({ error: 'Not found', source: 'runtime' }, { status: 404 });
    });
  }

  private handleGetInterface(interfacePath: string): Response {
    if (!this.interfacesDir) {
      return Response.json({ error: 'Interface not found' }, { status: 404 });
    }
    const fullPath = resolve(this.interfacesDir, interfacePath);
    if (
      (fullPath !== this.interfacesDir && !fullPath.startsWith(this.interfacesDir + '/')) ||
      !existsSync(fullPath)
    ) {
      return Response.json({ error: 'Interface not found' }, { status: 404 });
    }
    const source = readFileSync(fullPath, 'utf-8');
    return new Response(source, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
