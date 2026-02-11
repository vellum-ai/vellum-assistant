/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import { getLogger } from '../util/logger.js';
import {
  getOrCreateConversation,
} from '../memory/conversation-key-store.js';
import * as conversationStore from '../memory/conversation-store.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;

export interface RuntimeHttpServerOptions {
  port?: number;
}

interface RuntimeMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: unknown[];
}

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
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

    // Match /v1/assistants/:assistantId/<endpoint>
    const match = path.match(/^\/v1\/assistants\/([^/]+)\/(.+)$/);
    if (!match) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const assistantId = match[1];
    const endpoint = match[2];

    try {
      if (endpoint === 'health' && req.method === 'GET') {
        return this.handleHealth();
      }

      if (endpoint === 'messages' && req.method === 'GET') {
        return this.handleListMessages(assistantId, url);
      }

      if (endpoint === 'messages' && req.method === 'POST') {
        return await this.handleSendMessage(assistantId, req);
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

  private handleListMessages(assistantId: string, url: URL): Response {
    const conversationKey = url.searchParams.get('conversationKey');
    if (!conversationKey) {
      return Response.json(
        { error: 'conversationKey query parameter is required' },
        { status: 400 },
      );
    }

    const mapping = getOrCreateConversation(assistantId, conversationKey);
    const rawMessages = conversationStore.getMessages(mapping.conversationId);

    const messages: RuntimeMessagePayload[] = rawMessages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: new Date(msg.createdAt).toISOString(),
      attachments: [],
    }));

    return Response.json({ messages });
  }

  private async handleSendMessage(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      conversationKey?: string;
      content?: string;
      attachmentIds?: string[];
    };

    const { conversationKey, content } = body;

    if (!conversationKey) {
      return Response.json(
        { error: 'conversationKey is required' },
        { status: 400 },
      );
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return Response.json(
        { error: 'content is required' },
        { status: 400 },
      );
    }

    const mapping = getOrCreateConversation(assistantId, conversationKey);
    const userMessage = conversationStore.addMessage(
      mapping.conversationId,
      'user',
      content,
    );

    return Response.json({
      messageId: userMessage.id,
    });
  }
}
