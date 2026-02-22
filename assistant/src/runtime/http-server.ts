/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { ConfigError, IngressBlockedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { getWorkspacePromptPath } from '../util/platform.js';
import { TwilioConversationRelayProvider } from '../calls/twilio-provider.js';
import { loadConfig } from '../config/loader.js';
import { getPublicBaseUrl } from '../inbound/public-ingress-urls.js';
import type { RunOrchestrator } from './run-orchestrator.js';

// Route handlers — grouped by domain
import {
  handleListMessages,
  handleSendMessage,
  handleGetSuggestion,
} from './routes/conversation-routes.js';
import {
  handleUploadAttachment,
  handleDeleteAttachment,
  handleGetAttachment,
} from './routes/attachment-routes.js';
import {
  handleCreateRun,
  handleGetRun,
  handleRunDecision,
  handleRunSecret,
  handleAddTrustRule,
} from './routes/run-routes.js';
import {
  handleDeleteConversation,
  handleMoveSync,
  handleChannelInbound,
  handleChannelDeliveryAck,
  handleListDeadLetters,
  handleReplayDeadLetters,
} from './routes/channel-routes.js';
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as externalConversationStore from '../memory/external-conversation-store.js';
import * as attachmentsStore from '../memory/attachments-store.js';
import { renderHistoryContent } from '../daemon/handlers.js';
import { deliverChannelReply } from './gateway-client.js';
import {
  handleServePage,
  handleShareApp,
  handleDownloadSharedApp,
  handleGetSharedAppMetadata,
  handleDeleteSharedApp,
} from './routes/app-routes.js';
import { handleAddSecret } from './routes/secret-routes.js';
import {
  handleStartCall,
  handleGetCallStatus,
  handleCancelCall,
  handleAnswerCall,
  handleInstructionCall,
} from './routes/call-routes.js';
import {
  handleVoiceWebhook,
  handleStatusCallback,
  handleConnectAction,
} from '../calls/twilio-routes.js';
import { RelayConnection, activeRelayConnections } from '../calls/relay-server.js';
import type { RelayWebSocketData } from '../calls/relay-server.js';
import { handleSubscribeAssistantEvents } from './routes/events-routes.js';
import { consumeCallback, consumeCallbackError } from '../security/oauth-callback-registry.js';

// Re-export shared types so existing consumers don't need to update imports
export type {
  RuntimeMessageSessionOptions,
  MessageProcessor,
  NonBlockingMessageProcessor,
  RuntimeHttpServerOptions,
  RuntimeAttachmentMetadata,
} from './http-types.js';

import type {
  MessageProcessor,
  NonBlockingMessageProcessor,
  RuntimeHttpServerOptions,
} from './http-types.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;
const DEFAULT_HOSTNAME = '127.0.0.1';

/** Global hard cap on request body size (50 MB). Bun rejects larger payloads before they reach handlers. */
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

interface DiskSpaceInfo {
  path: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

function getDiskSpaceInfo(): DiskSpaceInfo | null {
  try {
    const baseDataDir = process.env.BASE_DATA_DIR?.trim();
    const diskPath = baseDataDir && existsSync(baseDataDir) ? baseDataDir : '/';
    const stats = statfsSync(diskPath);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
    return {
      path: diskPath,
      totalMb: bytesToMb(totalBytes),
      usedMb: bytesToMb(totalBytes - freeBytes),
      freeMb: bytesToMb(freeBytes),
    };
  } catch {
    return null;
  }
}

/**
 * Regex to extract the Twilio webhook subpath from both top-level and
 * assistant-scoped route shapes:
 *   /v1/calls/twilio/<subpath>
 *   /v1/assistants/<id>/calls/twilio/<subpath>
 */
const TWILIO_WEBHOOK_RE = /^\/v1\/(?:assistants\/[^/]+\/)?calls\/twilio\/(.+)$/;

/**
 * Gateway-compatible Twilio webhook paths:
 *   /webhooks/twilio/<subpath>
 *
 * Maps gateway path segments to the internal subpath names used by the
 * dispatcher below (e.g. "voice" -> "voice-webhook").
 */
const TWILIO_GATEWAY_WEBHOOK_RE = /^\/webhooks\/twilio\/(.+)$/;
const GATEWAY_SUBPATH_MAP: Record<string, string> = {
  voice: 'voice-webhook',
  status: 'status',
  'connect-action': 'connect-action',
};

/**
 * Direct Twilio webhook subpaths that are blocked in gateway_only mode.
 * Internal forwarding endpoints (gateway→runtime) are unaffected.
 */
const GATEWAY_ONLY_BLOCKED_SUBPATHS = new Set(['voice-webhook', 'status', 'connect-action']);

/**
 * Check if a request origin is from a private/internal network address.
 * Extracts the hostname from the Origin header and validates it against
 * isPrivateAddress(), consistent with the isPrivateNetworkPeer check.
 */
function isPrivateNetworkOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  // No origin header (e.g., server-initiated or same-origin) — allow
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === 'localhost') return true;
    // URL.hostname wraps IPv6 addresses in brackets (e.g. "[::1]") — strip them
    const rawHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return isPrivateAddress(rawHost);
  } catch {
    return false;
  }
}

/**
 * Check if a hostname is a loopback address.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

/**
 * Check if the actual peer/remote address of a connection is from a
 * private/internal network. Uses Bun's server.requestIP() to get the
 * real peer address, which cannot be spoofed unlike the Origin header.
 *
 * Accepts loopback, RFC 1918 private IPv4, link-local, and RFC 4193
 * unique-local IPv6 — including their IPv4-mapped IPv6 forms. This
 * supports container/pod deployments (e.g. Kubernetes sidecars) where
 * gateway and runtime communicate over pod-internal private IPs.
 */
function isPrivateNetworkPeer(server: { requestIP(req: Request): { address: string; family: string; port: number } | null }, req: Request): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false;
  return isPrivateAddress(ip.address);
}

/**
 * @internal Exported for testing.
 *
 * Determine whether an IP address string belongs to a private/internal
 * network range:
 *   - Loopback: 127.0.0.0/8, ::1
 *   - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Link-local: 169.254.0.0/16
 *   - IPv6 unique local: fc00::/7 (fc00::–fdff::)
 *   - IPv4-mapped IPv6 variants of all of the above (::ffff:x.x.x.x)
 */
export function isPrivateAddress(addr: string): boolean {
  // Handle IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.1) — extract the IPv4 part
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  // IPv4 checks
  if (normalized.includes('.')) {
    const parts = normalized.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;

    // Loopback: 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // Link-local: 169.254.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;

    return false;
  }

  // IPv6 checks
  const lower = normalized.toLowerCase();
  // Loopback
  if (lower === '::1') return true;
  // Unique local: fc00::/7 (fc00:: through fdff::)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Link-local: fe80::/10
  if (lower.startsWith('fe80')) return true;

  return false;
}

/**
 * Validate a Twilio webhook request's X-Twilio-Signature header.
 *
 * Returns the raw body text on success so callers can reconstruct the Request
 * for downstream handlers (which also need to read the body).
 * Returns a 403 Response if signature validation fails.
 *
 * Fail-closed: if the auth token is not configured, the request is rejected
 * with 403 rather than silently skipping validation. An explicit local-dev
 * bypass is available via TWILIO_WEBHOOK_VALIDATION_DISABLED=true.
 */
async function validateTwilioWebhook(
  req: Request,
): Promise<{ body: string } | Response> {
  const rawBody = await req.text();

  // Allow explicit local-dev bypass — must be exactly "true"
  if (process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED === 'true') {
    log.warn('Twilio webhook signature validation explicitly disabled via TWILIO_WEBHOOK_VALIDATION_DISABLED');
    return { body: rawBody };
  }

  const authToken = TwilioConversationRelayProvider.getAuthToken();

  // Fail-closed: reject if no auth token is configured
  if (!authToken) {
    log.error('Twilio auth token not configured — rejecting webhook request (fail-closed)');
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const signature = req.headers.get('x-twilio-signature');
  if (!signature) {
    log.warn('Twilio webhook request missing X-Twilio-Signature header');
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Parse form-urlencoded body into key-value params for signature computation
  const params: Record<string, string> = {};
  const formData = new URLSearchParams(rawBody);
  for (const [key, value] of formData.entries()) {
    params[key] = value;
  }

  // Reconstruct the public-facing URL that Twilio signed against.
  // Behind proxies/gateways, req.url is the local server URL (e.g.
  // http://127.0.0.1:7821/...) which differs from the public URL Twilio
  // used to compute the HMAC-SHA1 signature.
  let publicBaseUrl: string | undefined;
  try {
    publicBaseUrl = getPublicBaseUrl(loadConfig());
  } catch {
    // No webhook base URL configured — fall back to using req.url as-is
  }
  const parsedUrl = new URL(req.url);
  const publicUrl = publicBaseUrl
    ? publicBaseUrl + parsedUrl.pathname + parsedUrl.search
    : req.url;

  const isValid = TwilioConversationRelayProvider.verifyWebhookSignature(
    publicUrl,
    params,
    signature,
    authToken,
  );

  if (!isValid) {
    log.warn('Twilio webhook signature validation failed');
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  return { body: rawBody };
}

/**
 * Re-create a Request with the same method, headers, and URL but with a
 * pre-read body string so downstream handlers can call req.text() again.
 */
function cloneRequestWithBody(original: Request, body: string): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body,
  });
}

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private hostname: string;
  private bearerToken: string | undefined;
  private processMessage?: MessageProcessor;
  private persistAndProcessMessage?: NonBlockingMessageProcessor;
  private runOrchestrator?: RunOrchestrator;
  private interfacesDir: string | null;
  private suggestionCache = new Map<string, string>();
  private suggestionInFlight = new Map<string, Promise<string | null>>();
  private retrySweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInProgress = false;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;
    this.bearerToken = options.bearerToken;
    this.processMessage = options.processMessage;
    this.persistAndProcessMessage = options.persistAndProcessMessage;
    this.runOrchestrator = options.runOrchestrator;
    this.interfacesDir = options.interfacesDir ?? null;
  }

  /** The port the server is actually listening on (resolved after start). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  async start(): Promise<void> {
    this.server = Bun.serve<RelayWebSocketData>({
      port: this.port,
      hostname: this.hostname,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open(ws) {
          const callSessionId = ws.data?.callSessionId;
          log.info({ callSessionId }, 'ConversationRelay WebSocket opened');
          if (callSessionId) {
            const connection = new RelayConnection(ws, callSessionId);
            activeRelayConnections.set(callSessionId, connection);
          }
        },
        message(ws, message) {
          const callSessionId = ws.data?.callSessionId;
          if (callSessionId) {
            const connection = activeRelayConnections.get(callSessionId);
            connection?.handleMessage(typeof message === 'string' ? message : new TextDecoder().decode(message));
          }
        },
        close(ws, code, reason) {
          const callSessionId = ws.data?.callSessionId;
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

    // Sweep failed channel inbound events for retry every 30 seconds
    if (this.processMessage) {
      this.retrySweepTimer = setInterval(() => {
        if (this.sweepInProgress) return;
        this.sweepInProgress = true;
        this.sweepFailedEvents().finally(() => { this.sweepInProgress = false; });
      }, 30_000);
    }

    // Startup guard: log gateway-only mode warnings
    log.info('Running in gateway-only ingress mode. Direct webhook routes disabled.');
    if (!isLoopbackHost(this.hostname)) {
      log.warn('RUNTIME_HTTP_HOST is not bound to loopback. This may expose the runtime to direct public access.');
    }

    log.info({ port: this.actualPort, hostname: this.hostname, auth: !!this.bearerToken }, 'Runtime HTTP server listening');
  }

  async stop(): Promise<void> {
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

  /**
   * Constant-time comparison of two bearer tokens to prevent timing attacks.
   */
  private verifyToken(provided: string): boolean {
    const expected = this.bearerToken!;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private async handleRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health checks are unauthenticated — they expose no sensitive data.
    if (path === '/healthz' && req.method === 'GET') {
      return this.handleHealth();
    }

    // WebSocket upgrade for ConversationRelay — before auth check because
    // Twilio WebSocket connections don't use bearer tokens.
    if (path.startsWith('/v1/calls/relay') && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      // Only allow relay connections from private network peers.
      // Primary check: actual peer address (cannot be spoofed) — accepts loopback
      // and RFC 1918/4193 private addresses to support container deployments.
      // Secondary check: Origin header (defense in depth).
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
      // Bun handles the response after a successful upgrade.
      // The RelayConnection is created in the websocket.open handler.
      return undefined as unknown as Response;
    }

    // ── Twilio webhook endpoints — before auth check because Twilio
    //    webhook POSTs don't include bearer tokens.
    //    Supports /v1/calls/twilio/*, /v1/assistants/:id/calls/twilio/*,
    //    and gateway-compatible /webhooks/twilio/* paths.
    //    Validates X-Twilio-Signature to prevent unauthorized access. ──
    const twilioMatch = path.match(TWILIO_WEBHOOK_RE);
    const gatewayTwilioMatch = !twilioMatch ? path.match(TWILIO_GATEWAY_WEBHOOK_RE) : null;
    const resolvedTwilioSubpath = twilioMatch
      ? twilioMatch[1]
      : gatewayTwilioMatch
        ? GATEWAY_SUBPATH_MAP[gatewayTwilioMatch[1]]
        : null;
    if (resolvedTwilioSubpath && req.method === 'POST') {
      const twilioSubpath = resolvedTwilioSubpath;

      // Block direct Twilio webhook routes — must go through the gateway
      if (GATEWAY_ONLY_BLOCKED_SUBPATHS.has(twilioSubpath)) {
        return Response.json(
          { error: 'Direct webhook access disabled. Use the gateway.', code: 'GATEWAY_ONLY' },
          { status: 410 },
        );
      }

      // Validate Twilio request signature before dispatching
      const validation = await validateTwilioWebhook(req);
      if (validation instanceof Response) return validation;

      // Reconstruct request so handlers can read the body
      const validatedReq = cloneRequestWithBody(req, validation.body);

      if (twilioSubpath === 'voice-webhook') {
        return await handleVoiceWebhook(validatedReq);
      }
      if (twilioSubpath === 'status') {
        return await handleStatusCallback(validatedReq);
      }
      if (twilioSubpath === 'connect-action') {
        return await handleConnectAction(validatedReq);
      }
    }

    // Require bearer token when configured
    if ((process.env.DISABLE_HTTP_AUTH ?? "").toLowerCase() !== "true" && this.bearerToken) {
      const authHeader = req.headers.get('authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token || !this.verifyToken(token)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
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

    // ── Cloud sharing endpoints ───────────────────────────────────────
    if (path === '/v1/apps/share' && req.method === 'POST') {
      try {
        return await handleShareApp(req);
      } catch (err) {
        log.error({ err }, 'Runtime HTTP handler error sharing app');
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    const sharedTokenMatch = path.match(/^\/v1\/apps\/shared\/([^/]+)$/);
    if (sharedTokenMatch) {
      const shareToken = sharedTokenMatch[1];
      if (req.method === 'GET') {
        try {
          return handleDownloadSharedApp(shareToken);
        } catch (err) {
          log.error({ err, shareToken }, 'Runtime HTTP handler error downloading shared app');
          return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
      }
      if (req.method === 'DELETE') {
        try {
          return handleDeleteSharedApp(shareToken);
        } catch (err) {
          log.error({ err, shareToken }, 'Runtime HTTP handler error deleting shared app');
          return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
      }
    }

    const sharedMetadataMatch = path.match(/^\/v1\/apps\/shared\/([^/]+)\/metadata$/);
    if (sharedMetadataMatch && req.method === 'GET') {
      try {
        return handleGetSharedAppMetadata(sharedMetadataMatch[1]);
      } catch (err) {
        log.error({ err, shareToken: sharedMetadataMatch[1] }, 'Runtime HTTP handler error getting shared app metadata');
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    // ── Secret management endpoint ─────────────────────────────────────
    if (path === '/v1/secrets' && req.method === 'POST') {
      try {
        return await handleAddSecret(req);
      } catch (err) {
        log.error({ err }, 'Runtime HTTP handler error adding secret');
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    // New assistant-less runtime routes: /v1/<endpoint>
    // These supersede the legacy /v1/assistants/:assistantId/... shape.
    // Paths already handled above (/v1/apps/..., /v1/secrets) will never reach here.
    const newRouteMatch = path.match(/^\/v1\/(?!assistants\/)(.+)$/);
    if (newRouteMatch) {
      return this.dispatchEndpoint(newRouteMatch[1], req, url);
    }

    // Legacy: /v1/assistants/:assistantId/<endpoint>
    const match = path.match(/^\/v1\/assistants\/([^/]+)\/(.+)$/);
    if (!match) {
      return Response.json({ error: 'Not found', source: 'runtime' }, { status: 404 });
    }

    const assistantId = match[1];
    const endpoint = match[2];
    log.warn({ endpoint, assistantId }, '[deprecated] /v1/assistants/:assistantId/... route used; migrate to /v1/...');
    return this.dispatchEndpoint(endpoint, req, url);
  }

  /**
   * Dispatch a request to the appropriate endpoint handler.
   * Used by both the new assistant-less routes (/v1/<endpoint>) and the
   * legacy assistant-scoped routes (/v1/assistants/:assistantId/<endpoint>).
   */
  private async dispatchEndpoint(
    endpoint: string,
    req: Request,
    url: URL,
  ): Promise<Response> {
    try {
      if (endpoint === 'health' && req.method === 'GET') {
        return this.handleHealth();
      }

      if (endpoint === 'conversations' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const conversations = conversationStore.listConversations(limit);
        const bindings = externalConversationStore.getBindingsForConversations(
          conversations.map((c) => c.id),
        );
        return Response.json({
          sessions: conversations.map((c) => {
            const binding = bindings.get(c.id);
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
            };
          }),
        });
      }

      if (endpoint === 'messages' && req.method === 'GET') {
        return handleListMessages(url, this.interfacesDir);
      }

      if (endpoint === 'messages' && req.method === 'POST') {
        return await handleSendMessage(req, {
          processMessage: this.processMessage,
          persistAndProcessMessage: this.persistAndProcessMessage,
        });
      }

      if (endpoint === 'attachments' && req.method === 'POST') {
        return await handleUploadAttachment(req);
      }

      if (endpoint === 'attachments' && req.method === 'DELETE') {
        return await handleDeleteAttachment(req);
      }

      // Match attachments/:attachmentId
      const attachmentMatch = endpoint.match(/^attachments\/([^/]+)$/);
      if (attachmentMatch && req.method === 'GET') {
        return handleGetAttachment(attachmentMatch[1]);
      }

      if (endpoint === 'suggestion' && req.method === 'GET') {
        return await handleGetSuggestion(url, {
          suggestionCache: this.suggestionCache,
          suggestionInFlight: this.suggestionInFlight,
        });
      }

      if (endpoint === 'runs' && req.method === 'POST') {
        if (!this.runOrchestrator) {
          return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
        }
        return await handleCreateRun(req, this.runOrchestrator);
      }

      // Match runs/:runId, runs/:runId/decision, runs/:runId/trust-rule, runs/:runId/secret
      const runsMatch = endpoint.match(/^runs\/([^/]+)(\/decision|\/trust-rule|\/secret)?$/);
      if (runsMatch) {
        if (!this.runOrchestrator) {
          return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
        }
        const runId = runsMatch[1];
        if (runsMatch[2] === '/decision' && req.method === 'POST') {
          return await handleRunDecision(runId, req, this.runOrchestrator);
        }
        if (runsMatch[2] === '/secret' && req.method === 'POST') {
          return await handleRunSecret(runId, req, this.runOrchestrator);
        }
        if (runsMatch[2] === '/trust-rule' && req.method === 'POST') {
          const run = this.runOrchestrator.getRun(runId);
          if (!run) {
            return Response.json({ error: 'Run not found' }, { status: 404 });
          }
          return await handleAddTrustRule(runId, req);
        }
        if (req.method === 'GET') {
          return handleGetRun(runId, this.runOrchestrator);
        }
      }

      const interfacesMatch = endpoint.match(/^interfaces\/(.+)$/);
      if (interfacesMatch && req.method === 'GET') {
        return this.handleGetInterface(interfacesMatch[1]);
      }

      if (endpoint === 'channels/conversation' && req.method === 'DELETE') {
        return await handleDeleteConversation(req);
      }

      if (endpoint === 'channels/move-sync' && req.method === 'POST') {
        return await handleMoveSync(req);
      }

      if (endpoint === 'channels/inbound' && req.method === 'POST') {
        return await handleChannelInbound(req, this.processMessage, this.bearerToken);
      }

      if (endpoint === 'channels/delivery-ack' && req.method === 'POST') {
        return await handleChannelDeliveryAck(req);
      }

      if (endpoint === 'channels/dead-letters' && req.method === 'GET') {
        return handleListDeadLetters();
      }

      if (endpoint === 'channels/replay' && req.method === 'POST') {
        return await handleReplayDeadLetters(req);
      }

      // ── Call API routes ───────────────────────────────────────────
      if (endpoint === 'calls/start' && req.method === 'POST') {
        return await handleStartCall(req);
      }

      // Match calls/:callSessionId and calls/:callSessionId/cancel, calls/:callSessionId/answer, calls/:callSessionId/instruction
      const callsMatch = endpoint.match(/^calls\/([^/]+?)(\/cancel|\/answer|\/instruction)?$/);
      if (callsMatch) {
        const callSessionId = callsMatch[1];
        // Skip known sub-paths that are handled elsewhere (twilio, relay)
        if (callSessionId !== 'twilio' && callSessionId !== 'relay' && callSessionId !== 'start') {
          if (callsMatch[2] === '/cancel' && req.method === 'POST') {
            return await handleCancelCall(req, callSessionId);
          }
          if (callsMatch[2] === '/answer' && req.method === 'POST') {
            return await handleAnswerCall(req, callSessionId);
          }
          if (callsMatch[2] === '/instruction' && req.method === 'POST') {
            return await handleInstructionCall(req, callSessionId);
          }
          if (!callsMatch[2] && req.method === 'GET') {
            return handleGetCallStatus(callSessionId);
          }
        }
      }

      // ── Internal Twilio forwarding endpoints (gateway → runtime) ──
      // These accept JSON payloads from the gateway (which already validated
      // the Twilio signature) and reconstruct requests for the existing
      // Twilio route handlers.
      if (endpoint === 'internal/twilio/voice-webhook' && req.method === 'POST') {
        const json = await req.json() as { params: Record<string, string>; originalUrl?: string };
        const formBody = new URLSearchParams(json.params).toString();
        // Reconstruct request URL: keep the original URL query string (callSessionId)
        const reconstructedUrl = json.originalUrl ?? req.url;
        const fakeReq = new Request(reconstructedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody,
        });
        return await handleVoiceWebhook(fakeReq);
      }

      if (endpoint === 'internal/twilio/status' && req.method === 'POST') {
        const json = await req.json() as { params: Record<string, string> };
        const formBody = new URLSearchParams(json.params).toString();
        const fakeReq = new Request(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody,
        });
        return await handleStatusCallback(fakeReq);
      }

      if (endpoint === 'internal/twilio/connect-action' && req.method === 'POST') {
        const json = await req.json() as { params: Record<string, string> };
        const formBody = new URLSearchParams(json.params).toString();
        const fakeReq = new Request(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody,
        });
        return await handleConnectAction(fakeReq);
      }

      if (endpoint === 'identity' && req.method === 'GET') {
        return this.handleGetIdentity();
      }

      if (endpoint === 'events' && req.method === 'GET') {
        return handleSubscribeAssistantEvents(req, url);
      }

      // ── Internal OAuth callback endpoint (gateway → runtime) ──
      if (endpoint === 'internal/oauth/callback' && req.method === 'POST') {
        const json = await req.json() as { state: string; code?: string; error?: string };
        if (!json.state) {
          return Response.json({ error: 'Missing state parameter' }, { status: 400 });
        }
        if (json.error) {
          const consumed = consumeCallbackError(json.state, json.error);
          return consumed
            ? Response.json({ ok: true })
            : Response.json({ error: 'Unknown state' }, { status: 404 });
        }
        if (json.code) {
          const consumed = consumeCallback(json.state, json.code);
          return consumed
            ? Response.json({ ok: true })
            : Response.json({ error: 'Unknown state' }, { status: 404 });
        }
        return Response.json({ error: 'Missing code or error parameter' }, { status: 400 });
      }

      return Response.json({ error: 'Not found', source: 'runtime' }, { status: 404 });
    } catch (err) {
      if (err instanceof IngressBlockedError) {
        log.warn({ endpoint, detectedTypes: err.detectedTypes }, 'Blocked HTTP request containing secrets');
        return Response.json({ error: err.message, code: err.code }, { status: 422 });
      }
      if (err instanceof ConfigError) {
        log.warn({ err, endpoint }, 'Runtime HTTP config error');
        return Response.json({ error: err.message, code: err.code }, { status: 422 });
      }
      log.error({ err, endpoint }, 'Runtime HTTP handler error');
      const message = err instanceof Error ? err.message : 'Internal server error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /**
   * Periodically retry failed channel inbound events that have passed
   * their exponential backoff delay.
   */
  private async sweepFailedEvents(): Promise<void> {
    if (!this.processMessage) return;

    const events = channelDeliveryStore.getRetryableEvents();
    if (events.length === 0) return;

    log.info({ count: events.length }, 'Retrying failed channel inbound events');

    for (const event of events) {
      if (!event.rawPayload) {
        // No payload stored — can't replay, move to dead letter
        channelDeliveryStore.recordProcessingFailure(
          event.id,
          new Error('No raw payload stored for replay'),
        );
        continue;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
      } catch {
        channelDeliveryStore.recordProcessingFailure(
          event.id,
          new Error('Failed to parse stored raw payload'),
        );
        continue;
      }

      const content = typeof payload.content === 'string' ? payload.content.trim() : '';
      const attachmentIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds as string[] : undefined;
      const sourceChannel = payload.sourceChannel as string;
      const sourceMetadata = payload.sourceMetadata as Record<string, unknown> | undefined;

      const metadataHintsRaw = sourceMetadata?.hints;
      const metadataHints = Array.isArray(metadataHintsRaw)
        ? metadataHintsRaw.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
        : [];
      const metadataUxBrief = typeof sourceMetadata?.uxBrief === 'string' && sourceMetadata.uxBrief.trim().length > 0
        ? sourceMetadata.uxBrief.trim()
        : undefined;

      try {
        const { messageId: userMessageId } = await this.processMessage(
          event.conversationId,
          content,
          attachmentIds,
          {
            transport: {
              channelId: sourceChannel,
              hints: metadataHints.length > 0 ? metadataHints : undefined,
              uxBrief: metadataUxBrief,
            },
          },
        );
        channelDeliveryStore.linkMessage(event.id, userMessageId);
        channelDeliveryStore.markProcessed(event.id);
        log.info({ eventId: event.id }, 'Successfully replayed failed channel event');

        const replyCallbackUrl = typeof payload.replyCallbackUrl === 'string'
          ? payload.replyCallbackUrl
          : undefined;
        if (replyCallbackUrl) {
          const externalChatId = typeof payload.externalChatId === 'string'
            ? payload.externalChatId
            : undefined;
          if (externalChatId) {
            await this.deliverReplyViaCallback(event.conversationId, externalChatId, replyCallbackUrl);
          }
        }
      } catch (err) {
        log.error({ err, eventId: event.id }, 'Retry failed for channel event');
        channelDeliveryStore.recordProcessingFailure(event.id, err);
      }
    }
  }

  private async deliverReplyViaCallback(
    conversationId: string,
    externalChatId: string,
    callbackUrl: string,
  ): Promise<void> {
    const msgs = conversationStore.getMessages(conversationId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        let parsed: unknown;
        try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
        const rendered = renderHistoryContent(parsed);

        const linked = attachmentsStore.getAttachmentMetadataForMessage(msgs[i].id);
        const replyAttachments = linked.map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          kind: a.kind,
        }));

        if (rendered.text || replyAttachments.length > 0) {
          await deliverChannelReply(callbackUrl, {
            chatId: externalChatId,
            text: rendered.text || undefined,
            attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
          }, this.bearerToken);
        }
        break;
      }
    }
  }

  private handleGetIdentity(): Response {
    const identityPath = getWorkspacePromptPath('IDENTITY.md');
    if (!existsSync(identityPath)) {
      return Response.json({ error: 'IDENTITY.md not found' }, { status: 404 });
    }

    const content = readFileSync(identityPath, 'utf-8');
    const fields: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      const extract = (prefix: string): string | null => {
        if (!lower.startsWith(prefix)) return null;
        return trimmed.split(':**').pop()?.trim() ?? null;
      };

      const name = extract('- **name:**');
      if (name) { fields.name = name; continue; }
      const role = extract('- **role:**');
      if (role) { fields.role = role; continue; }
      const personality = extract('- **personality:**') ?? extract('- **vibe:**');
      if (personality) { fields.personality = personality; continue; }
      const emoji = extract('- **emoji:**');
      if (emoji) { fields.emoji = emoji; continue; }
      const home = extract('- **home:**');
      if (home) { fields.home = home; continue; }
    }

    // Read version from package.json
    let version: string | undefined;
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version;
    } catch {
      // ignore
    }

    // Read createdAt from IDENTITY.md file birthtime
    let createdAt: string | undefined;
    try {
      const stats = statSync(identityPath);
      createdAt = stats.birthtime.toISOString();
    } catch {
      // ignore
    }

    // Read lockfile for assistantId, cloud, and originSystem
    let assistantId: string | undefined;
    let cloud: string | undefined;
    let originSystem: string | undefined;
    try {
      const homedir = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const lockfilePaths = [
        join(homedir, '.vellum.lock.json'),
        join(homedir, '.vellum.lockfile.json'),
      ];
      for (const lockPath of lockfilePaths) {
        if (!existsSync(lockPath)) continue;
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const assistants = lockData.assistants as Array<Record<string, unknown>> | undefined;
        if (assistants && assistants.length > 0) {
          // Use the most recently hatched assistant
          const sorted = [...assistants].sort((a, b) => {
            const dateA = new Date(a.hatchedAt as string || 0).getTime();
            const dateB = new Date(b.hatchedAt as string || 0).getTime();
            return dateB - dateA;
          });
          const latest = sorted[0];
          assistantId = latest.assistantId as string | undefined;
          cloud = latest.cloud as string | undefined;
          originSystem = cloud === 'local' ? 'local' : cloud;
        }
        break;
      }
    } catch {
      // ignore — lockfile may not exist
    }

    return Response.json({
      name: fields.name ?? '',
      role: fields.role ?? '',
      personality: fields.personality ?? '',
      emoji: fields.emoji ?? '',
      home: fields.home ?? '',
      version,
      assistantId,
      createdAt,
      originSystem,
    });
  }

  private handleHealth(): Response {
    return Response.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      disk: getDiskSpaceInfo(),
    });
  }

  private handleGetInterface(interfacePath: string): Response {
    if (!this.interfacesDir) {
      return Response.json({ error: 'Interface not found' }, { status: 404 });
    }
    const fullPath = resolve(this.interfacesDir, interfacePath);
    // Enforce directory boundary so prefix-sibling paths (e.g. "interfaces-other/") are rejected
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
