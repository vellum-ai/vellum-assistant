/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getLogger } from '../util/logger.js';
import { getConfig } from '../config/loader.js';
import type { RunOrchestrator } from './run-orchestrator.js';
import { renderHistoryContent } from '../daemon/handlers.js';
import { getConversationByKey } from '../memory/conversation-key-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import {
  handleHealth,
  handleListMessages,
  handleSendMessage,
  handleUploadAttachment,
  handleDeleteAttachment,
  handleGetRun,
  handleCreateRun,
  handleRunDecision,
  handleChannelInbound,
  handleChannelDeliveryAck,
  handleGetSuggestion,
  HandlerException,
  type HandlerResponse,
} from './handlers/index.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;

/**
 * Convert a HandlerResponse to an HTTP Response.
 */
function toHttpResponse<T>(result: HandlerResponse<T>): Response {
  if (result.status === 204) {
    return new Response(null, { status: 204 });
  }
  return Response.json(result.body, { status: result.status });
}

/**
 * Execute a handler function and convert the result or error to an HTTP Response.
 */
async function executeHandler<T>(
  fn: () => Promise<HandlerResponse<T>> | HandlerResponse<T>,
): Promise<Response> {
  try {
    const result = await fn();
    return toHttpResponse(result);
  } catch (err: unknown) {
    if (err instanceof HandlerException) {
      return Response.json(
        { error: err.error.message, code: err.error.code, ...err.error.details },
        { status: err.error.status },
      );
    }
    throw err;
  }
}

export type MessageProcessor = (
  assistantId: string,
  conversationId: string,
  content: string,
  attachmentIds?: string[],
) => Promise<{ messageId: string }>;

/**
 * Non-blocking message processor that persists the user message and
 * starts the agent loop in the background, returning the messageId
 * immediately.
 */
export type NonBlockingMessageProcessor = (
  assistantId: string,
  conversationId: string,
  content: string,
  attachmentIds?: string[],
) => Promise<{ messageId: string }>;

export interface RuntimeHttpServerOptions {
  port?: number;
  processMessage?: MessageProcessor;
  /** Non-blocking processor for POST /messages (persists + fires agent loop). */
  persistAndProcessMessage?: NonBlockingMessageProcessor;
  /** Run orchestrator for the approval-flow run endpoints. */
  runOrchestrator?: RunOrchestrator;
}

interface RuntimeMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: unknown[];
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>;
}

const SUGGESTION_CACHE_MAX = 100;

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private processMessage?: MessageProcessor;
  private persistAndProcessMessage?: NonBlockingMessageProcessor;
  private runOrchestrator?: RunOrchestrator;
  private suggestionCache = new Map<string, string>();
  private suggestionInFlight = new Map<string, Promise<string | null>>();

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.processMessage = options.processMessage;
    this.persistAndProcessMessage = options.persistAndProcessMessage;
    this.runOrchestrator = options.runOrchestrator;
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
        return await this.handleListMessages(assistantId, url);
      }

      if (endpoint === 'messages' && req.method === 'POST') {
        return await this.handleSendMessage(assistantId, req);
      }

      if (endpoint === 'attachments' && req.method === 'POST') {
        return await this.handleUploadAttachment(assistantId, req);
      }

      if (endpoint === 'attachments' && req.method === 'DELETE') {
        return await this.handleDeleteAttachment(assistantId, req);
      }

      if (endpoint === 'suggestion' && req.method === 'GET') {
        return await this.handleGetSuggestion(assistantId, url);
      }

      if (endpoint === 'runs' && req.method === 'POST') {
        return await this.handleCreateRun(assistantId, req);
      }

      // Match runs/:runId and runs/:runId/decision
      const runsMatch = endpoint.match(/^runs\/([^/]+)(\/decision)?$/);
      if (runsMatch) {
        const runId = runsMatch[1];
        if (runsMatch[2] === '/decision' && req.method === 'POST') {
          return await this.handleRunDecision(assistantId, runId, req);
        }
        if (req.method === 'GET') {
          return await this.handleGetRun(assistantId, runId);
        }
      }

      if (endpoint === 'channels/inbound' && req.method === 'POST') {
        return await this.handleChannelInbound(assistantId, req);
      }

      if (endpoint === 'channels/delivery-ack' && req.method === 'POST') {
        return await this.handleChannelDeliveryAck(assistantId, req);
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      log.error({ err, endpoint, assistantId }, 'Runtime HTTP handler error');
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  private handleHealth(): Response {
    return toHttpResponse(handleHealth());
  }

  private async handleListMessages(assistantId: string, url: URL): Promise<Response> {
    const conversationKey = url.searchParams.get('conversationKey');
    if (!conversationKey) {
      return Response.json(
        { error: 'conversationKey query parameter is required' },
        { status: 400 },
      );
    }

    return executeHandler(() => handleListMessages({ assistantId, conversationKey }));
  }

  private async handleGetSuggestion(assistantId: string, url: URL): Promise<Response> {
    const conversationKey = url.searchParams.get('conversationKey');
    if (!conversationKey) {
      return Response.json(
        { error: 'conversationKey query parameter is required' },
        { status: 400 },
      );
    }

    const messageId = url.searchParams.get('messageId') ?? undefined;

    // Try the shared handler first (checks cache and validates)
    const result = await executeHandler(() =>
      handleGetSuggestion(
        { assistantId, conversationKey, messageId },
        this.suggestionCache,
      ),
    );

    // If the shared handler returned a cached result or error, return it
    const body = await result.json();
    if (body.source === 'llm' || body.stale || !body.messageId) {
      return Response.json(body, { status: result.status });
    }

    // Otherwise, try LLM generation for this uncached message
    const apiKey = getConfig().apiKeys.anthropic;
    if (!apiKey) {
      return Response.json(body, { status: result.status });
    }

    // Get the message text for LLM generation
    const mapping = getConversationByKey(assistantId, conversationKey);
    if (!mapping) {
      return Response.json(body, { status: result.status });
    }

    const rawMessages = conversationStore.getMessages(mapping.conversationId);
    const msg = rawMessages.find((m) => m.id === body.messageId && m.role === 'assistant');
    if (!msg) {
      return Response.json(body, { status: result.status });
    }

    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) {
      return Response.json(body, { status: result.status });
    }

    try {
      // Deduplicate concurrent requests
      let promise = this.suggestionInFlight.get(body.messageId);
      if (!promise) {
        promise = this.generateLlmSuggestion(apiKey, text);
        this.suggestionInFlight.set(body.messageId, promise);
      }

      const llmSuggestion = await promise;
      this.suggestionInFlight.delete(body.messageId);

      if (llmSuggestion) {
        // Evict oldest entries if cache is at capacity
        if (this.suggestionCache.size >= SUGGESTION_CACHE_MAX) {
          const oldest = this.suggestionCache.keys().next().value!;
          this.suggestionCache.delete(oldest);
        }
        this.suggestionCache.set(body.messageId, llmSuggestion);

        return Response.json({
          suggestion: llmSuggestion,
          messageId: body.messageId,
          source: 'llm' as const,
        });
      }
    } catch (err) {
      this.suggestionInFlight.delete(body.messageId);
      log.warn({ err }, 'LLM suggestion failed');
    }

    return Response.json(body, { status: result.status });
  }

  private async generateLlmSuggestion(apiKey: string, assistantText: string): Promise<string | null> {
    const client = new Anthropic({ apiKey });

    const truncated = assistantText.length > 2000
      ? assistantText.slice(-2000)
      : assistantText;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: `The AI assistant just said the following to the user. Suggest a single short follow-up message (max 200 chars) the user might want to send next. Reply with ONLY the suggested message text, nothing else.\n\nAssistant's message:\n${truncated}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    if (!raw || raw.length > 200) return null;

    // Take first line only
    const firstLine = raw.split('\n')[0].trim();
    return firstLine || null;
  }

  private async handleSendMessage(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      conversationKey?: string;
      content?: string;
      attachmentIds?: string[];
    };

    const processor = this.persistAndProcessMessage ?? this.processMessage;

    return executeHandler(() =>
      handleSendMessage(
        {
          assistantId,
          conversationKey: body.conversationKey ?? '',
          content: body.content,
          attachmentIds: body.attachmentIds,
        },
        processor,
      ),
    );
  }

  // ── Run endpoints ────────────────────────────────────────────────────

  private async handleCreateRun(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      conversationKey?: string;
      content?: string;
      attachmentIds?: string[];
    };

    return executeHandler(() =>
      handleCreateRun(
        {
          assistantId,
          conversationKey: body.conversationKey ?? '',
          content: body.content,
          attachmentIds: body.attachmentIds,
        },
        this.runOrchestrator,
      ),
    );
  }

  private async handleGetRun(assistantId: string, runId: string): Promise<Response> {
    return executeHandler(() =>
      handleGetRun({ assistantId, runId }, this.runOrchestrator),
    );
  }

  private async handleRunDecision(assistantId: string, runId: string, req: Request): Promise<Response> {
    const body = await req.json() as { decision?: string };

    return executeHandler(() =>
      handleRunDecision(
        {
          assistantId,
          runId,
          decision: body.decision ?? '',
        },
        this.runOrchestrator,
      ),
    );
  }

  // ── Attachment endpoints ────────────────────────────────────────────

  private async handleUploadAttachment(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      filename?: string;
      mimeType?: string;
      data?: string;
    };

    return executeHandler(() =>
      handleUploadAttachment({
        assistantId,
        filename: body.filename ?? '',
        mimeType: body.mimeType ?? '',
        data: body.data ?? '',
      }),
    );
  }

  private async handleDeleteAttachment(assistantId: string, req: Request): Promise<Response> {
    let body: { attachmentId?: string };
    try {
      body = await req.json() as { attachmentId?: string };
    } catch {
      return Response.json(
        { error: 'Invalid or missing JSON body' },
        { status: 400 },
      );
    }

    return executeHandler(() =>
      handleDeleteAttachment({
        assistantId,
        attachmentId: body.attachmentId ?? '',
      }),
    );
  }

  private async handleChannelInbound(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      sourceChannel?: string;
      externalChatId?: string;
      externalMessageId?: string;
      content?: string;
      attachmentIds?: string[];
    };

    return executeHandler(() =>
      handleChannelInbound(
        {
          assistantId,
          sourceChannel: body.sourceChannel ?? '',
          externalChatId: body.externalChatId ?? '',
          externalMessageId: body.externalMessageId ?? '',
          content: body.content,
          attachmentIds: body.attachmentIds,
        },
        this.processMessage,
      ),
    );
  }

  private async handleChannelDeliveryAck(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      sourceChannel?: string;
      externalChatId?: string;
      externalMessageId?: string;
    };

    return executeHandler(() =>
      handleChannelDeliveryAck({
        assistantId,
        sourceChannel: body.sourceChannel ?? '',
        externalChatId: body.externalChatId ?? '',
        externalMessageId: body.externalMessageId ?? '',
      }),
    );
  }
}
