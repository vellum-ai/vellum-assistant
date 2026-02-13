/**
 * Shared handler layer for runtime actions.
 *
 * All business logic lives here. HTTP routes and IPC dispatch call these
 * handlers, which return a standard { status, body } response or throw
 * HandlerException.
 */

import { HandlerException, Errors } from './errors.js';
import * as conversationStore from '../../memory/conversation-store.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import { getConversationByKey, getOrCreateConversation } from '../../memory/conversation-key-store.js';
import { renderHistoryContent, mergeToolResults } from '../../daemon/handlers.js';
import type { MessageProcessor } from '../http-server.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('handlers');

/**
 * Standard handler response shape.
 */
export interface HandlerResponse<T = unknown> {
  status: number;
  body: T;
}

// ─── Message handlers ────────────────────────────────────────────────────────

export interface ListMessagesRequest {
  assistantId: string;
  conversationKey: string;
}

export interface MessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: unknown[];
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }>;
}

export function handleListMessages(
  req: ListMessagesRequest,
): HandlerResponse<{ messages: MessagePayload[] }> {
  if (!req.conversationKey || typeof req.conversationKey !== 'string' || req.conversationKey.trim() === '') {
    throw new HandlerException(Errors.badRequest('conversationKey is required'));
  }

  const mapping = getConversationByKey(req.assistantId, req.conversationKey);
  if (!mapping) {
    return { status: 200, body: { messages: [] } };
  }

  const rawMessages = conversationStore.getMessages(mapping.conversationId);

  const parsed = rawMessages.map((msg) => {
    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);
    return {
      role: msg.role,
      text: rendered.text,
      timestamp: msg.createdAt,
      toolCalls: rendered.toolCalls,
      id: msg.id,
    };
  });

  const merged = mergeToolResults(parsed);

  const messages: MessagePayload[] = merged.map((m) => ({
    id: m.id ?? '',
    role: m.role,
    content: m.text,
    timestamp: new Date(m.timestamp).toISOString(),
    attachments: [],
    ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
  }));

  return { status: 200, body: { messages } };
}

// ─── Send message handler ────────────────────────────────────────────────────

export interface SendMessageRequest {
  assistantId: string;
  conversationKey: string;
  content?: string;
  attachmentIds?: string[];
}

export async function handleSendMessage(
  req: SendMessageRequest,
  processor?: MessageProcessor,
): Promise<HandlerResponse<{ accepted: boolean; messageId: string }>> {
  if (!req.conversationKey || typeof req.conversationKey !== 'string' || req.conversationKey.trim() === '') {
    throw new HandlerException(Errors.badRequest('conversationKey is required'));
  }

  // Validate content type
  if (req.content !== undefined && req.content !== null && typeof req.content !== 'string') {
    throw new HandlerException(Errors.badRequest('content must be a string'));
  }

  const trimmedContent = typeof req.content === 'string' ? req.content.trim() : '';
  const hasAttachments = Array.isArray(req.attachmentIds) && req.attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    throw new HandlerException(Errors.badRequest('content or attachmentIds is required'));
  }

  // Validate attachments
  if (hasAttachments && req.attachmentIds) {
    const resolved = attachmentsStore.getAttachmentsByIds(req.assistantId, req.attachmentIds);
    if (resolved.length !== req.attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = req.attachmentIds.filter((id) => !resolvedIds.has(id));
      throw new HandlerException(
        Errors.badRequest(`Attachment IDs not found: ${missing.join(', ')}`),
      );
    }
  }

  const mapping = getOrCreateConversation(req.assistantId, req.conversationKey);

  if (!processor) {
    throw new HandlerException(Errors.serviceUnavailable('Message processing not configured'));
  }

  try {
    const result = await processor(
      req.assistantId,
      mapping.conversationId,
      req.content ?? '',
      hasAttachments ? req.attachmentIds : undefined,
    );
    return { status: 200, body: { accepted: true, messageId: result.messageId } };
  } catch (err) {
    if (err instanceof Error && err.message === 'Session is already processing a message') {
      throw new HandlerException(
        Errors.conflict('Session is busy processing another message. Please retry.'),
      );
    }
    throw err;
  }
}

// ─── Attachment handlers ─────────────────────────────────────────────────────

export interface UploadAttachmentRequest {
  assistantId: string;
  filename: string;
  mimeType: string;
  data: string;
}

export interface AttachmentResponse {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
}

export function handleUploadAttachment(
  req: UploadAttachmentRequest,
): HandlerResponse<AttachmentResponse> {
  if (!req.filename || typeof req.filename !== 'string') {
    throw new HandlerException(Errors.badRequest('filename is required'));
  }

  if (!req.mimeType || typeof req.mimeType !== 'string') {
    throw new HandlerException(Errors.badRequest('mimeType is required'));
  }

  if (!req.data || typeof req.data !== 'string') {
    throw new HandlerException(Errors.badRequest('data (base64) is required'));
  }

  const attachment = attachmentsStore.uploadAttachment(
    req.assistantId,
    req.filename,
    req.mimeType,
    req.data,
  );

  return {
    status: 200,
    body: {
      id: attachment.id,
      original_filename: attachment.originalFilename,
      mime_type: attachment.mimeType,
      size_bytes: attachment.sizeBytes,
      kind: attachment.kind,
    },
  };
}

export interface DeleteAttachmentRequest {
  assistantId: string;
  attachmentId: string;
}

export function handleDeleteAttachment(
  req: DeleteAttachmentRequest,
): HandlerResponse<null> {
  if (!req.attachmentId || typeof req.attachmentId !== 'string') {
    throw new HandlerException(Errors.badRequest('attachmentId is required'));
  }

  const deleted = attachmentsStore.deleteAttachment(req.assistantId, req.attachmentId);

  if (!deleted) {
    throw new HandlerException(Errors.notFound('Attachment'));
  }

  return { status: 204, body: null };
}

// ─── Run handlers ────────────────────────────────────────────────────────────

export interface CreateRunRequest {
  assistantId: string;
  conversationKey: string;
  content?: string;
  attachmentIds?: string[];
}

export interface RunResponse {
  id: string;
  status: string;
  messageId: string;
  createdAt: string;
}

export async function handleCreateRun(
  req: CreateRunRequest,
  runOrchestrator?: {
    startRun: (
      assistantId: string,
      conversationId: string,
      content: string,
      attachmentIds?: string[],
    ) => Promise<{ id: string; status: string; messageId: string; createdAt: number }>;
  },
): Promise<HandlerResponse<RunResponse>> {
  if (!runOrchestrator) {
    throw new HandlerException(Errors.serviceUnavailable('Run orchestration not configured'));
  }

  if (!req.conversationKey || typeof req.conversationKey !== 'string' || req.conversationKey.trim() === '') {
    throw new HandlerException(Errors.badRequest('conversationKey is required'));
  }

  if (req.content !== undefined && req.content !== null && typeof req.content !== 'string') {
    throw new HandlerException(Errors.badRequest('content must be a string'));
  }

  const trimmedContent = typeof req.content === 'string' ? req.content.trim() : '';
  const hasAttachments = Array.isArray(req.attachmentIds) && req.attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    throw new HandlerException(Errors.badRequest('content or attachmentIds is required'));
  }

  if (hasAttachments && req.attachmentIds) {
    const resolved = attachmentsStore.getAttachmentsByIds(req.assistantId, req.attachmentIds);
    if (resolved.length !== req.attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = req.attachmentIds.filter((id) => !resolvedIds.has(id));
      throw new HandlerException(
        Errors.badRequest(`Attachment IDs not found: ${missing.join(', ')}`),
      );
    }
  }

  const mapping = getOrCreateConversation(req.assistantId, req.conversationKey);

  try {
    const run = await runOrchestrator.startRun(
      req.assistantId,
      mapping.conversationId,
      req.content ?? '',
      hasAttachments ? req.attachmentIds : undefined,
    );
    return {
      status: 201,
      body: {
        id: run.id,
        status: run.status,
        messageId: run.messageId,
        createdAt: new Date(run.createdAt).toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'Session is already processing a message') {
      throw new HandlerException(
        Errors.conflict('Session is busy processing another message. Please retry.'),
      );
    }
    throw err;
  }
}

export interface GetRunRequest {
  assistantId: string;
  runId: string;
}

export interface GetRunResponse {
  id: string;
  status: string;
  messageId: string;
  pendingConfirmation?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export function handleGetRun(
  req: GetRunRequest,
  runOrchestrator?: {
    getRun: (runId: string) => {
      id: string;
      status: string;
      messageId: string;
      assistantId: string;
      pendingConfirmation?: unknown;
      error?: string;
      createdAt: number;
      updatedAt: number;
    } | null;
  },
): HandlerResponse<GetRunResponse> {
  if (!runOrchestrator) {
    throw new HandlerException(Errors.serviceUnavailable('Run orchestration not configured'));
  }

  const run = runOrchestrator.getRun(req.runId);
  if (!run || run.assistantId !== req.assistantId) {
    throw new HandlerException(Errors.notFound('Run'));
  }

  return {
    status: 200,
    body: {
      id: run.id,
      status: run.status,
      messageId: run.messageId,
      pendingConfirmation: run.pendingConfirmation,
      error: run.error,
      createdAt: new Date(run.createdAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
    },
  };
}

export interface RunDecisionRequest {
  assistantId: string;
  runId: string;
  decision: string;
}

export async function handleRunDecision(
  req: RunDecisionRequest,
  runOrchestrator?: {
    getRun: (runId: string) => { assistantId: string } | null;
    submitDecision: (runId: string, decision: 'allow' | 'deny') => string;
  },
): Promise<HandlerResponse<{ accepted: boolean }>> {
  if (!runOrchestrator) {
    throw new HandlerException(Errors.serviceUnavailable('Run orchestration not configured'));
  }

  // Verify the run belongs to this assistant
  const run = runOrchestrator.getRun(req.runId);
  if (!run || run.assistantId !== req.assistantId) {
    throw new HandlerException(Errors.notFound('Run'));
  }

  if (req.decision !== 'allow' && req.decision !== 'deny') {
    throw new HandlerException(Errors.badRequest('decision must be "allow" or "deny"'));
  }

  const result = runOrchestrator.submitDecision(req.runId, req.decision);
  if (result === 'run_not_found') {
    throw new HandlerException(Errors.notFound('Run'));
  }
  if (result === 'no_pending_decision') {
    throw new HandlerException(Errors.conflict('No confirmation pending for this run'));
  }

  return { status: 200, body: { accepted: true } };
}

// ─── Channel handlers ────────────────────────────────────────────────────────

export interface ChannelInboundRequest {
  assistantId: string;
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
  content?: string;
  attachmentIds?: string[];
}

export interface ChannelInboundResponse {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  assistantMessage?: {
    id: string;
    role: string;
    content: string;
    timestamp: string;
    attachments: unknown[];
  };
}

export async function handleChannelInbound(
  req: ChannelInboundRequest,
  processor?: MessageProcessor,
): Promise<HandlerResponse<ChannelInboundResponse>> {
  if (!req.sourceChannel || typeof req.sourceChannel !== 'string') {
    throw new HandlerException(Errors.badRequest('sourceChannel is required'));
  }
  if (!req.externalChatId || typeof req.externalChatId !== 'string') {
    throw new HandlerException(Errors.badRequest('externalChatId is required'));
  }
  if (!req.externalMessageId || typeof req.externalMessageId !== 'string') {
    throw new HandlerException(Errors.badRequest('externalMessageId is required'));
  }

  if (req.content !== undefined && req.content !== null && typeof req.content !== 'string') {
    throw new HandlerException(Errors.badRequest('content must be a string'));
  }

  const trimmedContent = typeof req.content === 'string' ? req.content.trim() : '';
  const hasAttachments = Array.isArray(req.attachmentIds) && req.attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    throw new HandlerException(Errors.badRequest('content or attachmentIds is required'));
  }

  if (hasAttachments && req.attachmentIds) {
    const resolved = attachmentsStore.getAttachmentsByIds(req.assistantId, req.attachmentIds);
    if (resolved.length !== req.attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = req.attachmentIds.filter((id) => !resolvedIds.has(id));
      throw new HandlerException(
        Errors.badRequest(`Attachment IDs not found: ${missing.join(', ')}`),
      );
    }
  }

  const result = channelDeliveryStore.recordInbound(
    req.assistantId,
    req.sourceChannel,
    req.externalChatId,
    req.externalMessageId,
  );

  let assistantMessage: ChannelInboundResponse['assistantMessage'];
  if (!result.duplicate && processor) {
    try {
      await processor(
        req.assistantId,
        result.conversationId,
        req.content ?? '',
        hasAttachments ? req.attachmentIds : undefined,
      );

      const msgs = conversationStore.getMessages(result.conversationId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(msgs[i].content);
          } catch {
            parsed = msgs[i].content;
          }
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
    } catch (err) {
      log.error({ err, conversationId: result.conversationId }, 'Failed to process channel inbound message');
    }
  }

  return {
    status: 200,
    body: {
      accepted: result.accepted,
      duplicate: result.duplicate,
      eventId: result.eventId,
      ...(assistantMessage ? { assistantMessage } : {}),
    },
  };
}

export interface ChannelDeliveryAckRequest {
  assistantId: string;
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
}

export function handleChannelDeliveryAck(
  req: ChannelDeliveryAckRequest,
): HandlerResponse<null> {
  if (!req.sourceChannel || typeof req.sourceChannel !== 'string') {
    throw new HandlerException(Errors.badRequest('sourceChannel is required'));
  }
  if (!req.externalChatId || typeof req.externalChatId !== 'string') {
    throw new HandlerException(Errors.badRequest('externalChatId is required'));
  }
  if (!req.externalMessageId || typeof req.externalMessageId !== 'string') {
    throw new HandlerException(Errors.badRequest('externalMessageId is required'));
  }

  const acked = channelDeliveryStore.acknowledgeDelivery(
    req.assistantId,
    req.sourceChannel,
    req.externalChatId,
    req.externalMessageId,
  );

  if (!acked) {
    throw new HandlerException(Errors.notFound('Inbound event'));
  }

  return { status: 204, body: null };
}

// ─── Health handler ──────────────────────────────────────────────────────────

export function handleHealth(): HandlerResponse<{ status: string; timestamp: string }> {
  return {
    status: 200,
    body: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    },
  };
}

// ─── Suggestion handler ──────────────────────────────────────────────────────

export interface GetSuggestionRequest {
  assistantId: string;
  conversationKey: string;
  messageId?: string;
}

export interface SuggestionResponse {
  suggestion: string | null;
  messageId: string | null;
  source: 'llm' | 'none';
  stale?: boolean;
}

export function handleGetSuggestion(
  req: GetSuggestionRequest,
  suggestionCache: Map<string, string>,
): HandlerResponse<SuggestionResponse> {
  if (!req.conversationKey || typeof req.conversationKey !== 'string' || req.conversationKey.trim() === '') {
    throw new HandlerException(Errors.badRequest('conversationKey is required'));
  }
  const mapping = getConversationByKey(req.assistantId, req.conversationKey);
  if (!mapping) {
    return {
      status: 200,
      body: { suggestion: null, messageId: null, source: 'none' as const },
    };
  }

  const rawMessages = conversationStore.getMessages(mapping.conversationId);
  if (rawMessages.length === 0) {
    return {
      status: 200,
      body: { suggestion: null, messageId: null, source: 'none' as const },
    };
  }

  // Staleness check: compare requested messageId against the latest
  // assistant message BEFORE filtering by text content.
  if (req.messageId) {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === 'assistant') {
        if (rawMessages[i].id !== req.messageId) {
          return {
            status: 200,
            body: { suggestion: null, messageId: null, source: 'none' as const, stale: true },
          };
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
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) continue;

    // If a messageId was requested and the first text-bearing assistant
    // message is a different message, the request is stale.
    if (req.messageId && msg.id !== req.messageId) {
      return {
        status: 200,
        body: { suggestion: null, messageId: null, source: 'none' as const, stale: true },
      };
    }

    // Return cached suggestion if available. For non-cached suggestions,
    // return 'none' — the caller is responsible for async generation if desired.
    const cached = suggestionCache.get(msg.id);
    return {
      status: 200,
      body: {
        suggestion: cached ?? null,
        messageId: msg.id,
        source: cached !== undefined ? ('llm' as const) : ('none' as const),
      },
    };
  }

  return {
    status: 200,
    body: { suggestion: null, messageId: null, source: 'none' as const },
  };
}
