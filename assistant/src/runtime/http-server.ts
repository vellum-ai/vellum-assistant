/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
} from './routes/channel-routes.js';
import {
  handleServePage,
  handleShareApp,
  handleDownloadSharedApp,
  handleGetSharedAppMetadata,
  handleDeleteSharedApp,
} from './routes/app-routes.js';

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

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private processMessage?: MessageProcessor;
  private persistAndProcessMessage?: NonBlockingMessageProcessor;
  private runOrchestrator?: RunOrchestrator;
  private interfacesDir: string | null;
  private suggestionCache = new Map<string, string>();
  private suggestionInFlight = new Map<string, Promise<string | null>>();

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.processMessage = options.processMessage;
    this.persistAndProcessMessage = options.persistAndProcessMessage;
    this.runOrchestrator = options.runOrchestrator;
    this.interfacesDir = options.interfacesDir ?? null;
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });

    log.info({ port: this.port }, 'Runtime HTTP server listening');
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
      log.info('Runtime HTTP server stopped');
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

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

    // Match /v1/assistants/:assistantId/<endpoint>
    const match = path.match(/^\/v1\/assistants\/([^/]+)\/(.+)$/);
    if (!match) {
      if (path === '/healthz' && req.method === 'GET') {
        return this.handleHealth();
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const assistantId = match[1];
    const endpoint = match[2];

    try {
      if (endpoint === 'health' && req.method === 'GET') {
        return this.handleHealth();
      }

      if (endpoint === 'messages' && req.method === 'GET') {
        return handleListMessages(assistantId, url, this.interfacesDir);
      }

      if (endpoint === 'messages' && req.method === 'POST') {
        return await handleSendMessage(assistantId, req, {
          processMessage: this.processMessage,
          persistAndProcessMessage: this.persistAndProcessMessage,
        });
      }

      if (endpoint === 'attachments' && req.method === 'POST') {
        return await handleUploadAttachment(assistantId, req);
      }

      if (endpoint === 'attachments' && req.method === 'DELETE') {
        return await handleDeleteAttachment(assistantId, req);
      }

      // Match attachments/:attachmentId
      const attachmentMatch = endpoint.match(/^attachments\/([^/]+)$/);
      if (attachmentMatch && req.method === 'GET') {
        return handleGetAttachment(assistantId, attachmentMatch[1]);
      }

      if (endpoint === 'suggestion' && req.method === 'GET') {
        return await handleGetSuggestion(assistantId, url, {
          suggestionCache: this.suggestionCache,
          suggestionInFlight: this.suggestionInFlight,
        });
      }

      if (endpoint === 'runs' && req.method === 'POST') {
        if (!this.runOrchestrator) {
          return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
        }
        return await handleCreateRun(assistantId, req, this.runOrchestrator);
      }

      // Match runs/:runId, runs/:runId/decision, runs/:runId/trust-rule
      const runsMatch = endpoint.match(/^runs\/([^/]+)(\/decision|\/trust-rule)?$/);
      if (runsMatch) {
        if (!this.runOrchestrator) {
          return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
        }
        const runId = runsMatch[1];
        if (runsMatch[2] === '/decision' && req.method === 'POST') {
          return await handleRunDecision(assistantId, runId, req, this.runOrchestrator);
        }
        if (runsMatch[2] === '/trust-rule' && req.method === 'POST') {
          const run = this.runOrchestrator.getRun(runId);
          if (!run || run.assistantId !== assistantId) {
            return Response.json({ error: 'Run not found' }, { status: 404 });
          }
          return await handleAddTrustRule(req);
        }
        if (req.method === 'GET') {
          return handleGetRun(assistantId, runId, this.runOrchestrator);
        }
      }

      const interfacesMatch = endpoint.match(/^interfaces\/(.+)$/);
      if (interfacesMatch && req.method === 'GET') {
        return this.handleGetInterface(interfacesMatch[1]);
      }

      if (endpoint === 'channels/conversation' && req.method === 'DELETE') {
        return await handleDeleteConversation(assistantId, req);
      }

      if (endpoint === 'channels/inbound' && req.method === 'POST') {
        return await handleChannelInbound(assistantId, req, this.processMessage);
      }

      if (endpoint === 'channels/delivery-ack' && req.method === 'POST') {
        return await handleChannelDeliveryAck(assistantId, req);
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      log.error({ err, endpoint, assistantId }, 'Runtime HTTP handler error');
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  private handleHealth(): Response {
    return Response.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  }

  private handleGetInterface(interfacePath: string): Response {
    if (!this.interfacesDir) {
      return Response.json({ error: 'Interface not found' }, { status: 404 });
    }
    const fullPath = resolve(this.interfacesDir, interfacePath);
    if (!fullPath.startsWith(this.interfacesDir) || !existsSync(fullPath)) {
      return Response.json({ error: 'Interface not found' }, { status: 404 });
    }
    const source = readFileSync(fullPath, 'utf-8');
    return new Response(source, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
