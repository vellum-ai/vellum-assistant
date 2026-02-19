/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ConfigError, IngressBlockedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
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
  handleAddTrustRule,
} from './routes/run-routes.js';
import {
  handleDeleteConversation,
  handleChannelInbound,
  handleChannelDeliveryAck,
  handleListDeadLetters,
  handleReplayDeadLetters,
} from './routes/channel-routes.js';
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import {
  handleServePage,
  handleShareApp,
  handleDownloadSharedApp,
  handleGetSharedAppMetadata,
  handleDeleteSharedApp,
} from './routes/app-routes.js';
import { handleAddSecret } from './routes/secret-routes.js';

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

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req) => this.handleRequest(req),
    });

    // Sweep failed channel inbound events for retry every 30 seconds
    if (this.processMessage) {
      this.retrySweepTimer = setInterval(() => {
        if (this.sweepInProgress) return;
        this.sweepInProgress = true;
        this.sweepFailedEvents().finally(() => { this.sweepInProgress = false; });
      }, 30_000);
    }

    log.info({ port: this.port, hostname: this.hostname, auth: !!this.bearerToken }, 'Runtime HTTP server listening');
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

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health checks are unauthenticated — they expose no sensitive data.
    if (path === '/healthz' && req.method === 'GET') {
      return this.handleHealth();
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

      // Match runs/:runId, runs/:runId/decision, runs/:runId/trust-rule
      const runsMatch = endpoint.match(/^runs\/([^/]+)(\/decision|\/trust-rule)?$/);
      if (runsMatch) {
        if (!this.runOrchestrator) {
          return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
        }
        const runId = runsMatch[1];
        if (runsMatch[2] === '/decision' && req.method === 'POST') {
          return await handleRunDecision(runId, req, this.runOrchestrator);
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

      if (endpoint === 'channels/inbound' && req.method === 'POST') {
        return await handleChannelInbound(req, this.processMessage);
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
          event.assistantId,
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
      } catch (err) {
        log.error({ err, eventId: event.id }, 'Retry failed for channel event');
        channelDeliveryStore.recordProcessingFailure(event.id, err);
      }
    }
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
