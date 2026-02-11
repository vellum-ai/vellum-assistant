/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getLogger } from '../util/logger.js';
import {
  getConversationByKey,
  getOrCreateConversation,
} from '../memory/conversation-key-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as attachmentsStore from '../memory/attachments-store.js';
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import { renderHistoryContent, mergeToolResults } from '../daemon/handlers.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;

export type MessageProcessor = (
  assistantId: string,
  conversationId: string,
  content: string,
  attachmentIds?: string[],
) => Promise<void>;

export interface RuntimeHttpServerOptions {
  port?: number;
  processMessage?: MessageProcessor;
}

interface RuntimeMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: unknown[];
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>;
}

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private processMessage?: MessageProcessor;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.processMessage = options.processMessage;
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

      if (endpoint === 'attachments' && req.method === 'POST') {
        return await this.handleUploadAttachment(assistantId, req);
      }

      if (endpoint === 'attachments' && req.method === 'DELETE') {
        return await this.handleDeleteAttachment(assistantId, req);
      }

      if (endpoint === 'suggestion' && req.method === 'GET') {
        return await this.handleGetSuggestion(assistantId, url);
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

    const mapping = getConversationByKey(assistantId, conversationKey);
    if (!mapping) {
      return Response.json({ messages: [] });
    }
    const rawMessages = conversationStore.getMessages(mapping.conversationId);

    // Parse content blocks and extract text + tool calls
    const parsed = rawMessages.map((msg) => {
      let content: unknown;
      try { content = JSON.parse(msg.content); } catch { content = msg.content; }
      const rendered = renderHistoryContent(content);
      return {
        role: msg.role,
        text: rendered.text,
        timestamp: msg.createdAt,
        toolCalls: rendered.toolCalls,
        id: msg.id,
      };
    });

    // Merge tool_result data from internal user messages into the
    // preceding assistant message's toolCalls, and suppress those
    // internal user messages from the visible history.
    const merged = mergeToolResults(parsed);

    const messages: RuntimeMessagePayload[] = merged.map((m) => ({
      id: m.id ?? '',
      role: m.role,
      content: m.text,
      timestamp: new Date(m.timestamp).toISOString(),
      attachments: [],
      ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
    }));

    return Response.json({ messages });
  }

  private async handleGetSuggestion(assistantId: string, url: URL): Promise<Response> {
    const conversationKey = url.searchParams.get('conversationKey');
    if (!conversationKey) {
      return Response.json(
        { error: 'conversationKey query parameter is required' },
        { status: 400 },
      );
    }

    const mapping = getConversationByKey(assistantId, conversationKey);
    if (!mapping) {
      return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
    }

    const rawMessages = conversationStore.getMessages(mapping.conversationId);
    if (rawMessages.length === 0) {
      return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
    }

    // Walk backwards to find the last assistant message with text content
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = rawMessages[i];
      if (msg.role !== 'assistant') continue;

      let content: unknown;
      try { content = JSON.parse(msg.content); } catch { content = msg.content; }
      const rendered = renderHistoryContent(content);
      const text = rendered.text.trim();
      if (!text) continue;

      // Skip if a specific messageId was requested and doesn't match
      const requestedMessageId = url.searchParams.get('messageId');
      if (requestedMessageId && msg.id !== requestedMessageId) {
        return Response.json({ suggestion: null, messageId: null, source: 'none' as const, stale: true });
      }

      // Try LLM suggestion if ANTHROPIC_API_KEY is available
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const llmSuggestion = await this.generateLlmSuggestion(apiKey, text);
          if (llmSuggestion) {
            return Response.json({
              suggestion: llmSuggestion,
              messageId: msg.id,
              source: 'llm' as const,
            });
          }
        } catch (err) {
          log.warn({ err }, 'LLM suggestion failed');
        }
      }

      return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
    }

    return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
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

    const { conversationKey, content, attachmentIds } = body;

    if (!conversationKey) {
      return Response.json(
        { error: 'conversationKey is required' },
        { status: 400 },
      );
    }

    const trimmedContent = typeof content === 'string' ? content.trim() : '';
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

    if (trimmedContent.length === 0 && !hasAttachments) {
      return Response.json(
        { error: 'content or attachmentIds is required' },
        { status: 400 },
      );
    }

    const mapping = getOrCreateConversation(assistantId, conversationKey);

    // Trigger agent processing in the background. session.processMessage
    // saves the user message and runs the agent loop; the web UI polls
    // for results via GET /messages.
    if (this.processMessage) {
      this.processMessage(assistantId, mapping.conversationId, content ?? '', hasAttachments ? attachmentIds : undefined).catch((err) => {
        log.error({ err, conversationId: mapping.conversationId }, 'Failed to process message');
      });
    }

    return Response.json({ accepted: true });
  }

  private async handleUploadAttachment(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      filename?: string;
      mimeType?: string;
      data?: string;
    };

    const { filename, mimeType, data } = body;

    if (!filename || typeof filename !== 'string') {
      return Response.json(
        { error: 'filename is required' },
        { status: 400 },
      );
    }

    if (!mimeType || typeof mimeType !== 'string') {
      return Response.json(
        { error: 'mimeType is required' },
        { status: 400 },
      );
    }

    if (!data || typeof data !== 'string') {
      return Response.json(
        { error: 'data (base64) is required' },
        { status: 400 },
      );
    }

    const attachment = attachmentsStore.uploadAttachment(
      assistantId,
      filename,
      mimeType,
      data,
    );

    return Response.json({
      id: attachment.id,
      original_filename: attachment.originalFilename,
      mime_type: attachment.mimeType,
      size_bytes: attachment.sizeBytes,
      kind: attachment.kind,
    });
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

    const { attachmentId } = body;

    if (!attachmentId || typeof attachmentId !== 'string') {
      return Response.json(
        { error: 'attachmentId is required' },
        { status: 400 },
      );
    }

    const deleted = attachmentsStore.deleteAttachment(assistantId, attachmentId);

    if (!deleted) {
      return Response.json(
        { error: 'Attachment not found' },
        { status: 404 },
      );
    }

    return new Response(null, { status: 204 });
  }

  private async handleChannelInbound(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      sourceChannel?: string;
      externalChatId?: string;
      externalMessageId?: string;
      content?: string;
      senderName?: string;
    };

    const { sourceChannel, externalChatId, externalMessageId, content } = body;

    if (!sourceChannel || typeof sourceChannel !== 'string') {
      return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
    }
    if (!externalChatId || typeof externalChatId !== 'string') {
      return Response.json({ error: 'externalChatId is required' }, { status: 400 });
    }
    if (!externalMessageId || typeof externalMessageId !== 'string') {
      return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
    }
    if (!content || typeof content !== 'string') {
      return Response.json({ error: 'content is required' }, { status: 400 });
    }

    const result = channelDeliveryStore.recordInbound(
      assistantId,
      sourceChannel,
      externalChatId,
      externalMessageId,
      content,
    );

    // For new (non-duplicate) messages, run the agent loop to generate a reply.
    if (!result.duplicate && this.processMessage) {
      try {
        await this.processMessage(result.conversationId, content);
      } catch (err) {
        log.error({ err, conversationId: result.conversationId }, 'Failed to process channel inbound message');
      }
    }

    // Look up the latest assistant message in the conversation to return it.
    let assistantMessage: RuntimeMessagePayload | undefined;
    const msgs = conversationStore.getMessages(result.conversationId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        let parsed: unknown;
        try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
        const rendered = renderHistoryContent(parsed);
        if (rendered.text) {
          assistantMessage = {
            id: msgs[i].id,
            role: 'assistant',
            content: rendered.text,
            timestamp: new Date(msgs[i].createdAt).toISOString(),
            attachments: [],
          };
        }
        break;
      }
    }

    return Response.json({
      accepted: result.accepted,
      duplicate: result.duplicate,
      eventId: result.eventId,
      ...(assistantMessage ? { assistantMessage } : {}),
    });
  }

  private async handleChannelDeliveryAck(assistantId: string, req: Request): Promise<Response> {
    const body = await req.json() as {
      sourceChannel?: string;
      externalChatId?: string;
      externalMessageId?: string;
    };

    const { sourceChannel, externalChatId, externalMessageId } = body;

    if (!sourceChannel || typeof sourceChannel !== 'string') {
      return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
    }
    if (!externalChatId || typeof externalChatId !== 'string') {
      return Response.json({ error: 'externalChatId is required' }, { status: 400 });
    }
    if (!externalMessageId || typeof externalMessageId !== 'string') {
      return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
    }

    const acked = channelDeliveryStore.acknowledgeDelivery(
      assistantId,
      sourceChannel,
      externalChatId,
      externalMessageId,
    );

    if (!acked) {
      return Response.json({ error: 'Inbound event not found' }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  }
}
