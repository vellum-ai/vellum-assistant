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
import { getConfig } from '../config/loader.js';
import { getUsageSummary } from '../usage/summary.js';
import type { RunOrchestrator } from './run-orchestrator.js';
import { recordDirectLlmUsage } from '../usage/recorders.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;

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
          return this.handleGetRun(assistantId, runId);
        }
      }

      if (endpoint === 'channels/inbound' && req.method === 'POST') {
        return await this.handleChannelInbound(assistantId, req);
      }

      if (endpoint === 'channels/delivery-ack' && req.method === 'POST') {
        return await this.handleChannelDeliveryAck(assistantId, req);
      }

      if (endpoint === 'usage' && req.method === 'GET') {
        return this.handleGetUsage(assistantId, url);
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

    // Staleness check: compare requested messageId against the latest
    // assistant message BEFORE filtering by text content.  This ensures
    // that a newer tool-only assistant turn (empty text) still causes
    // older messageId requests to be correctly marked as stale.
    const requestedMessageId = url.searchParams.get('messageId');
    if (requestedMessageId) {
      for (let i = rawMessages.length - 1; i >= 0; i--) {
        if (rawMessages[i].role === 'assistant') {
          if (rawMessages[i].id !== requestedMessageId) {
            return Response.json({ suggestion: null, messageId: null, source: 'none' as const, stale: true });
          }
          break;
        }
      }
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

      // If a messageId was requested and the first text-bearing assistant
      // message is a *different* message, the request is stale.  This
      // prevents returning a suggestion for an older assistant turn when
      // the latest turn was a tool-only message (empty text) that passed
      // the pre-check above.
      if (requestedMessageId && msg.id !== requestedMessageId) {
        return Response.json({ suggestion: null, messageId: null, source: 'none' as const, stale: true });
      }

      // Return cached suggestion if we already generated one for this message
      const cached = this.suggestionCache.get(msg.id);
      if (cached !== undefined) {
        return Response.json({
          suggestion: cached,
          messageId: msg.id,
          source: 'llm' as const,
        });
      }

      // Try LLM suggestion if an Anthropic API key is configured
      const apiKey = getConfig().apiKeys.anthropic;
      if (apiKey) {
        try {
          // Deduplicate concurrent requests: if an LLM call is already
          // in-flight for this messageId, await the same promise instead
          // of starting a duplicate call.
          let promise = this.suggestionInFlight.get(msg.id);
          if (!promise) {
            promise = this.generateLlmSuggestion(apiKey, text);
            this.suggestionInFlight.set(msg.id, promise);
          }

          const llmSuggestion = await promise;
          this.suggestionInFlight.delete(msg.id);

          if (llmSuggestion) {
            // Evict oldest entries if cache is at capacity
            if (this.suggestionCache.size >= SUGGESTION_CACHE_MAX) {
              const oldest = this.suggestionCache.keys().next().value!;
              this.suggestionCache.delete(oldest);
            }
            this.suggestionCache.set(msg.id, llmSuggestion);

            return Response.json({
              suggestion: llmSuggestion,
              messageId: msg.id,
              source: 'llm' as const,
            });
          }
        } catch (err) {
          this.suggestionInFlight.delete(msg.id);
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

    recordDirectLlmUsage(response.usage, 'anthropic', 'claude-haiku-4-5-20251001', 'suggestion_generator');

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

    // P2: Reject non-string content values (numbers, objects, etc.)
    if (content !== undefined && content !== null && typeof content !== 'string') {
      return Response.json(
        { error: 'content must be a string' },
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

    // P1: Validate that all attachment IDs resolve
    if (hasAttachments) {
      const resolved = attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds);
      if (resolved.length !== attachmentIds.length) {
        const resolvedIds = new Set(resolved.map((a) => a.id));
        const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
        return Response.json(
          { error: `Attachment IDs not found: ${missing.join(', ')}` },
          { status: 400 },
        );
      }
    }

    const mapping = getOrCreateConversation(assistantId, conversationKey);

    const processor = this.persistAndProcessMessage ?? this.processMessage;
    if (!processor) {
      return Response.json({ error: 'Message processing not configured' }, { status: 503 });
    }

    try {
      const result = await processor(
        assistantId,
        mapping.conversationId,
        content ?? '',
        hasAttachments ? attachmentIds : undefined,
      );
      return Response.json({ accepted: true, messageId: result.messageId });
    } catch (err) {
      if (err instanceof Error && err.message === 'Session is already processing a message') {
        return Response.json(
          { error: 'Session is busy processing another message. Please retry.' },
          { status: 409 },
        );
      }
      throw err;
    }
  }

  // ── Run endpoints ────────────────────────────────────────────────────

  private async handleCreateRun(assistantId: string, req: Request): Promise<Response> {
    if (!this.runOrchestrator) {
      return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
    }

    const body = await req.json() as {
      conversationKey?: string;
      content?: string;
      attachmentIds?: string[];
    };

    const { conversationKey, content, attachmentIds } = body;

    if (!conversationKey) {
      return Response.json({ error: 'conversationKey is required' }, { status: 400 });
    }

    if (content !== undefined && content !== null && typeof content !== 'string') {
      return Response.json({ error: 'content must be a string' }, { status: 400 });
    }

    const trimmedContent = typeof content === 'string' ? content.trim() : '';
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

    if (trimmedContent.length === 0 && !hasAttachments) {
      return Response.json({ error: 'content or attachmentIds is required' }, { status: 400 });
    }

    if (hasAttachments) {
      const resolved = attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds);
      if (resolved.length !== attachmentIds.length) {
        const resolvedIds = new Set(resolved.map((a) => a.id));
        const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
        return Response.json(
          { error: `Attachment IDs not found: ${missing.join(', ')}` },
          { status: 400 },
        );
      }
    }

    const mapping = getOrCreateConversation(assistantId, conversationKey);

    try {
      const run = await this.runOrchestrator.startRun(
        assistantId,
        mapping.conversationId,
        content ?? '',
        hasAttachments ? attachmentIds : undefined,
      );
      return Response.json({
        id: run.id,
        status: run.status,
        messageId: run.messageId,
        createdAt: new Date(run.createdAt).toISOString(),
      }, { status: 201 });
    } catch (err) {
      if (err instanceof Error && err.message === 'Session is already processing a message') {
        return Response.json(
          { error: 'Session is busy processing another message. Please retry.' },
          { status: 409 },
        );
      }
      throw err;
    }
  }

  private handleGetRun(assistantId: string, runId: string): Response {
    if (!this.runOrchestrator) {
      return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
    }

    const run = this.runOrchestrator.getRun(runId);
    if (!run || run.assistantId !== assistantId) {
      return Response.json({ error: 'Run not found' }, { status: 404 });
    }

    return Response.json({
      id: run.id,
      status: run.status,
      messageId: run.messageId,
      pendingConfirmation: run.pendingConfirmation,
      error: run.error,
      createdAt: new Date(run.createdAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
    });
  }

  private async handleRunDecision(assistantId: string, runId: string, req: Request): Promise<Response> {
    if (!this.runOrchestrator) {
      return Response.json({ error: 'Run orchestration not configured' }, { status: 503 });
    }

    // Verify the run belongs to this assistant before applying a decision
    const run = this.runOrchestrator.getRun(runId);
    if (!run || run.assistantId !== assistantId) {
      return Response.json({ error: 'Run not found' }, { status: 404 });
    }

    const body = await req.json() as { decision?: string };
    const { decision } = body;

    if (decision !== 'allow' && decision !== 'deny') {
      return Response.json(
        { error: 'decision must be "allow" or "deny"' },
        { status: 400 },
      );
    }

    const result = this.runOrchestrator.submitDecision(runId, decision);
    if (result === 'run_not_found') {
      return Response.json(
        { error: 'Run not found' },
        { status: 404 },
      );
    }
    if (result === 'no_pending_decision') {
      return Response.json(
        { error: 'No confirmation pending for this run' },
        { status: 409 },
      );
    }

    return Response.json({ accepted: true });
  }

  // ── Attachment endpoints ────────────────────────────────────────────

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
      attachmentIds?: string[];
      senderExternalUserId?: string;
      senderUsername?: string;
      sourceMetadata?: Record<string, unknown>;
    };

    const { sourceChannel, externalChatId, externalMessageId, content, attachmentIds } = body;

    if (!sourceChannel || typeof sourceChannel !== 'string') {
      return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
    }
    if (!externalChatId || typeof externalChatId !== 'string') {
      return Response.json({ error: 'externalChatId is required' }, { status: 400 });
    }
    if (!externalMessageId || typeof externalMessageId !== 'string') {
      return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
    }

    // Reject non-string content regardless of whether attachments are present.
    if (content !== undefined && content !== null && typeof content !== 'string') {
      return Response.json({ error: 'content must be a string' }, { status: 400 });
    }

    const trimmedContent = typeof content === 'string' ? content.trim() : '';
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

    if (trimmedContent.length === 0 && !hasAttachments) {
      return Response.json({ error: 'content or attachmentIds is required' }, { status: 400 });
    }

    if (hasAttachments) {
      const resolved = attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds);
      if (resolved.length !== attachmentIds.length) {
        const resolvedIds = new Set(resolved.map((a) => a.id));
        const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
        return Response.json(
          { error: `Attachment IDs not found: ${missing.join(', ')}` },
          { status: 400 },
        );
      }
    }

    const result = channelDeliveryStore.recordInbound(
      assistantId,
      sourceChannel,
      externalChatId,
      externalMessageId,
    );

    // For new (non-duplicate) messages, run the agent loop to generate a reply.
    let processingSucceeded = false;
    if (!result.duplicate && this.processMessage) {
      try {
        await this.processMessage(assistantId, result.conversationId, content ?? '', hasAttachments ? attachmentIds : undefined);
        processingSucceeded = true;
      } catch (err) {
        log.error({ err, conversationId: result.conversationId }, 'Failed to process channel inbound message');
      }
    }

    // Only look up the assistant reply when processing succeeded for a new
    // (non-duplicate) message.  For duplicates or failed processing, returning
    // a stale assistant message could cause the caller to resend old replies.
    let assistantMessage: RuntimeMessagePayload | undefined;
    if (processingSucceeded) {
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
    }

    return Response.json({
      accepted: result.accepted,
      duplicate: result.duplicate,
      eventId: result.eventId,
      ...(assistantMessage ? { assistantMessage } : {}),
    });
  }

  // ── Usage endpoint ──────────────────────────────────────────────────

  private handleGetUsage(assistantId: string, url: URL): Response {
    const preset = url.searchParams.get('preset');
    const startParam = url.searchParams.get('start');
    const endParam = url.searchParams.get('end');

    let startAt: number;
    let endAt: number;

    if (preset) {
      const now = Date.now();
      endAt = now;
      switch (preset) {
        case '24h':
          startAt = now - 24 * 60 * 60 * 1000;
          break;
        case '7d':
          startAt = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case '30d':
          startAt = now - 30 * 24 * 60 * 60 * 1000;
          break;
        default:
          return Response.json(
            { error: 'Invalid preset. Must be one of: 24h, 7d, 30d' },
            { status: 400 },
          );
      }
    } else if (startParam && endParam) {
      startAt = Number(startParam);
      endAt = Number(endParam);
      if (isNaN(startAt) || isNaN(endAt)) {
        return Response.json(
          { error: 'start and end must be valid epoch milliseconds' },
          { status: 400 },
        );
      }
      if (startAt >= endAt) {
        return Response.json(
          { error: 'start must be before end' },
          { status: 400 },
        );
      }
    } else {
      return Response.json(
        { error: 'Either preset (24h|7d|30d) or start+end (epoch ms) query params are required' },
        { status: 400 },
      );
    }

    try {
      const summary = getUsageSummary({ startAt, endAt, assistantId });
      return Response.json(summary);
    } catch (err) {
      log.error({ err, assistantId }, 'Failed to fetch usage summary');
      return Response.json({ error: 'Failed to fetch usage summary' }, { status: 500 });
    }
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
