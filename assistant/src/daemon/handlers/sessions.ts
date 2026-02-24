import * as net from 'node:net';
import { silentlyWithLog } from '../../util/silently.js';
import { v4 as uuid } from 'uuid';
import * as conversationStore from '../../memory/conversation-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { classifySessionError, buildSessionErrorMessage } from '../session-error.js';
import { getAttachmentsForMessage, setAttachmentThumbnail } from '../../memory/attachments-store.js';
import { generateVideoThumbnail } from '../video-thumbnail.js';
import type { UserMessageAttachment } from '../ipc-contract.js';
import { normalizeThreadType } from '../ipc-protocol.js';
import type {
  UserMessage,
  ConfirmationResponse,
  SecretResponse,
  SessionCreateRequest,
  SessionSwitchRequest,
  CancelRequest,
  DeleteQueuedMessage,
  HistoryRequest,
  UndoRequest,
  RegenerateRequest,
  UsageRequest,
  SandboxSetRequest,
  ServerMessage,
} from '../ipc-protocol.js';
import { getConfig } from '../../config/loader.js';
import { getSubagentManager } from '../../subagent/index.js';
import {
  log,
  wireEscalationHandler,
  renderHistoryContent,
  mergeToolResults,
  pendingStandaloneSecrets,
  type HandlerContext,
  defineHandlers,
  type HistoryToolCall,
  type HistorySurface,
  type ParsedHistoryMessage,
} from './shared.js';
import { truncate } from '../../util/truncate.js';

export async function handleUserMessage(
  msg: UserMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ sessionId: msg.sessionId, requestId });
  try {
    ctx.socketToSession.set(socket, msg.sessionId);
    const session = await ctx.getOrCreateSession(msg.sessionId, socket, true);
    // Only wire the escalation handler if one isn't already set — handleTaskSubmit
    // sets a handler with the client's actual screen dimensions, and overwriting it
    // here would replace those dimensions with the daemon's defaults.
    if (!session.hasEscalationHandler()) {
      wireEscalationHandler(session, socket, ctx);
    }

    const sendEvent = (event: ServerMessage) => ctx.send(socket, event);

    // Block inbound messages that contain secrets and redirect to secure prompt
    if (!msg.bypassSecretCheck) {
      const ingressCheck = checkIngressForSecrets(msg.content ?? '');
      if (ingressCheck.blocked) {
        rlog.warn({ detectedTypes: ingressCheck.detectedTypes }, 'Blocked user message containing secrets');
        ctx.send(socket, {
          type: 'error',
          message: ingressCheck.userNotice!,
          category: 'secret_blocked',
        });
        // Redirect: trigger a secure prompt so the user can enter the secret safely
        session.redirectToSecurePrompt(ingressCheck.detectedTypes);
        return;
      }
    }

    session.traceEmitter.emit('request_received', 'User message received', {
      requestId,
      status: 'info',
      attributes: { source: 'user_message' },
    });

    const result = session.enqueueMessage(msg.content ?? '', msg.attachments ?? [], sendEvent, requestId, msg.activeSurfaceId, msg.currentPage);
    if (result.rejected) {
      rlog.warn('Message rejected — queue is full');
      session.traceEmitter.emit('request_error', 'Message rejected — queue is full', {
        requestId,
        status: 'error',
        attributes: { reason: 'queue_full', queueDepth: session.getQueueDepth() },
      });
      ctx.send(socket, buildSessionErrorMessage(msg.sessionId, {
        code: 'QUEUE_FULL',
        userMessage: 'Message queue is full (max depth: 10). Please wait for current messages to be processed.',
        retryable: true,
        debugDetails: 'Message rejected — session queue is full',
      }));
      return;
    }
    if (result.queued) {
      const position = session.getQueueDepth();
      rlog.info({ position }, 'Message queued (session busy)');
      session.traceEmitter.emit('request_queued', `Message queued at position ${position}`, {
        requestId,
        status: 'info',
        attributes: { position },
      });
      ctx.send(socket, {
        type: 'message_queued',
        sessionId: msg.sessionId,
        requestId,
        position,
      });
      return; // Don't await — message will be processed when current one finishes
    }

    rlog.info('Processing user message');
    session.setAssistantId('self');
    session.setGuardianContext(null);
    session.setCommandIntent(null);
    // Fire-and-forget: don't block the IPC handler so the connection can
    // continue receiving messages (e.g. cancel, confirmations, or
    // additional user_message that will be queued by the session).
    session.processMessage(msg.content ?? '', msg.attachments ?? [], sendEvent, requestId, msg.activeSurfaceId, msg.currentPage).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      rlog.error({ err }, 'Error processing user message (session or provider failure)');
      ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
      const classified = classifySessionError(err, { phase: 'agent_loop' });
      ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, 'Error setting up user message processing');
    ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
    const classified = classifySessionError(err, { phase: 'handler' });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
  }
}

export function handleConfirmationResponse(
  msg: ConfirmationResponse,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Route by requestId to the session that originated the prompt, not by
  // the current socket-session binding which may have changed since the
  // request was issued (e.g. after a session switch).
  for (const [sessionId, session] of ctx.sessions) {
    if (session.hasPendingConfirmation(msg.requestId)) {
      ctx.touchSession(sessionId);
      session.handleConfirmationResponse(
        msg.requestId,
        msg.decision,
        msg.selectedPattern,
        msg.selectedScope,
      );
      return;
    }
  }

  // Also check computer-use sessions — they have their own PermissionPrompter
  for (const [, cuSession] of ctx.cuSessions) {
    if (cuSession.hasPendingConfirmation(msg.requestId)) {
      cuSession.handleConfirmationResponse(
        msg.requestId,
        msg.decision,
        msg.selectedPattern,
        msg.selectedScope,
      );
      return;
    }
  }

  log.warn({ requestId: msg.requestId }, 'No session found with pending confirmation for requestId');
}

export function handleSecretResponse(
  msg: SecretResponse,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Check standalone (non-session) prompts first, since they use a dedicated
  // requestId that won't collide with session prompts.
  const standalone = pendingStandaloneSecrets.get(msg.requestId);
  if (standalone) {
    clearTimeout(standalone.timer);
    pendingStandaloneSecrets.delete(msg.requestId);
    standalone.resolve({ value: msg.value ?? null, delivery: msg.delivery ?? 'store' });
    return;
  }

  // Route by requestId to the session that originated the prompt, not by
  // the current socket-session binding which may have changed since the
  // request was issued (e.g. after a session switch).
  for (const [sessionId, session] of ctx.sessions) {
    if (session.hasPendingSecret(msg.requestId)) {
      ctx.touchSession(sessionId);
      session.handleSecretResponse(msg.requestId, msg.value, msg.delivery);
      return;
    }
  }
  log.warn({ requestId: msg.requestId }, 'No session found with pending secret prompt for requestId');
}

export function handleSessionList(socket: net.Socket, ctx: HandlerContext, offset = 0, limit = 50): void {
  const conversations = conversationStore.listConversations(limit, false, offset);
  const totalCount = conversationStore.countConversations();
  const bindings = externalConversationStore.getBindingsForConversations(
    conversations.map((c) => c.id),
  );
  ctx.send(socket, {
    type: 'session_list_response',
    sessions: conversations.map((c) => {
      const binding = bindings.get(c.id);
      return {
        id: c.id,
        title: c.title ?? 'Untitled',
        updatedAt: c.updatedAt,
        threadType: normalizeThreadType(c.threadType),
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
      };
    }),
    hasMore: offset + conversations.length < totalCount,
  });
}

export function handleSessionsClear(socket: net.Socket, ctx: HandlerContext): void {
  const cleared = ctx.clearAllSessions();
  // Also clear DB conversations. When a new IPC connection triggers
  // sendInitialSession, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  conversationStore.clearAll();
  ctx.send(socket, { type: 'sessions_clear_response', cleared });
}

export async function handleSessionCreate(
  msg: SessionCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const threadType = normalizeThreadType(msg.threadType);
  const conversation = conversationStore.createConversation({
    title: msg.title ?? 'New Conversation',
    threadType,
  });
  const session = await ctx.getOrCreateSession(conversation.id, socket, true, {
    systemPromptOverride: msg.systemPromptOverride,
    maxResponseTokens: msg.maxResponseTokens,
    transport: msg.transport,
  });
  wireEscalationHandler(session, socket, ctx);

  // Pre-activate skills before sending session_info so they're available
  // for the initial message processing.
  if (msg.preactivatedSkillIds?.length) {
    session.preactivatedSkillIds = msg.preactivatedSkillIds;
  }

  ctx.send(socket, {
    type: 'session_info',
    sessionId: conversation.id,
    title: conversation.title ?? 'New Conversation',
    ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
    threadType: normalizeThreadType(conversation.threadType),
  });

  // Auto-send the initial message if provided, kick-starting the skill.
  if (msg.initialMessage) {
    ctx.socketToSession.set(socket, conversation.id);
    const sendEvent = (event: ServerMessage) => ctx.send(socket, event);
    const requestId = uuid();
    session.processMessage(msg.initialMessage, [], sendEvent, requestId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId: conversation.id }, 'Error processing initial message');
      ctx.send(socket, { type: 'error', message: `Failed to process initial message: ${message}` });
    });
  }
}

export async function handleSessionSwitch(
  msg: SessionSwitchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, { type: 'error', message: `Session ${msg.sessionId} not found` });
    return;
  }

  // If the target session is headless-locked (actively executing a task run),
  // skip rebinding the socket so tool confirmations stay suppressed.
  const existingSession = ctx.sessions.get(msg.sessionId);
  const isHeadlessLocked = existingSession && (existingSession as unknown as { headlessLock?: boolean }).headlessLock;

  ctx.socketToSession.set(socket, msg.sessionId);

  if (isHeadlessLocked) {
    // Load the session without rebinding the client — the session stays headless
    await ctx.getOrCreateSession(msg.sessionId, socket, false);
  } else {
    const session = await ctx.getOrCreateSession(msg.sessionId, socket, true);
    // Only wire the escalation handler if one isn't already set — handleTaskSubmit
    // sets a handler with the client's actual screen dimensions, and overwriting it
    // here would replace those dimensions with the daemon's defaults.
    if (!session.hasEscalationHandler()) {
      wireEscalationHandler(session, socket, ctx);
    }
  }

  ctx.send(socket, {
    type: 'session_info',
    sessionId: conversation.id,
    title: conversation.title ?? 'Untitled',
    threadType: normalizeThreadType(conversation.threadType),
  });
}

export function handleCancel(msg: CancelRequest, socket: net.Socket, ctx: HandlerContext): void {
  const sessionId = msg.sessionId || ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      ctx.touchSession(sessionId);
      session.abort();
      // Also abort any child subagents spawned by this session.
      // Omit sendToClient to suppress parent notifications — the parent is
      // being cancelled, so enqueuing synthetic messages would trigger
      // unwanted model activity after the user pressed stop.
      getSubagentManager().abortAllForParent(sessionId);
    }
  }
}

export function handleHistoryRequest(
  msg: HistoryRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const dbMessages = conversationStore.getMessages(msg.sessionId);
  const parsed: ParsedHistoryMessage[] = dbMessages.map((m) => {
    let text = '';
    let toolCalls: HistoryToolCall[] = [];
    let toolCallsBeforeText = false;
    let textSegments: string[] = [];
    let contentOrder: string[] = [];
    let surfaces: HistorySurface[] = [];
    try {
      const content = JSON.parse(m.content);
      const rendered = renderHistoryContent(content);
      text = rendered.text;
      toolCalls = rendered.toolCalls;
      toolCallsBeforeText = rendered.toolCallsBeforeText;
      textSegments = rendered.textSegments;
      contentOrder = rendered.contentOrder;
      surfaces = rendered.surfaces;
      if (m.role === 'assistant' && toolCalls.length > 0) {
        log.info({ messageId: m.id, toolCallCount: toolCalls.length, text: truncate(text, 100, '') }, 'History message with tool calls');
      }
    } catch (err) {
      log.debug({ err, messageId: m.id }, 'Failed to parse message content as JSON, using raw text');
      text = m.content;
      textSegments = text ? [text] : [];
      contentOrder = text ? ['text:0'] : [];
      surfaces = [];
    }
    let subagentNotification: ParsedHistoryMessage['subagentNotification'];
    if (m.metadata) {
      try {
        subagentNotification = (JSON.parse(m.metadata) as { subagentNotification?: ParsedHistoryMessage['subagentNotification'] }).subagentNotification;
      } catch (err) {
        log.debug({ err, messageId: m.id }, 'Failed to parse message metadata as JSON, ignoring');
      }
    }
    return { id: m.id, role: m.role, text, timestamp: m.createdAt, toolCalls, toolCallsBeforeText, textSegments, contentOrder, surfaces, ...(subagentNotification ? { subagentNotification } : {}) };
  });

  // Merge tool_result data from user messages into the preceding assistant
  // message's toolCalls, and suppress user messages that only contain
  // tool_result blocks (internal agent-loop turns).
  const merged = mergeToolResults(parsed);

  const historyMessages = merged.map((m) => {
    let attachments: UserMessageAttachment[] | undefined;
    if (m.role === 'assistant' && m.id) {
      const linked = getAttachmentsForMessage(m.id);
      if (linked.length > 0) {
        // Skip embedding base64 data for large video attachments to keep the
        // history_response payload small. Only videos have a lazy-fetch path on
        // the client, so non-video attachments always keep their inline data.
        const MAX_INLINE_B64_SIZE = 512 * 1024;
        attachments = linked.map((a) => {
          const omit = a.mimeType.startsWith('video/') && a.dataBase64.length > MAX_INLINE_B64_SIZE;

          // Lazily generate thumbnails for existing video attachments on first history load.
          if (a.mimeType.startsWith('video/') && !a.thumbnailBase64) {
            const attachmentId = a.id;
            const base64 = a.dataBase64;
            silentlyWithLog(
              generateVideoThumbnail(base64).then((thumb) => {
                if (thumb) setAttachmentThumbnail(attachmentId, thumb);
              }),
              'video thumbnail generation',
            );
          }

          return {
            id: a.id,
            filename: a.originalFilename,
            mimeType: a.mimeType,
            data: omit ? '' : a.dataBase64,
            ...(omit ? { sizeBytes: a.sizeBytes } : {}),
            ...(a.thumbnailBase64 ? { thumbnailData: a.thumbnailBase64 } : {}),
          };
        });
      }
    }
    return {
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls, toolCallsBeforeText: m.toolCallsBeforeText } : {}),
      ...(attachments ? { attachments } : {}),
      ...(m.textSegments.length > 0 ? { textSegments: m.textSegments } : {}),
      ...(m.contentOrder.length > 0 ? { contentOrder: m.contentOrder } : {}),
      ...(m.surfaces.length > 0 ? { surfaces: m.surfaces } : {}),
      ...(m.subagentNotification ? { subagentNotification: m.subagentNotification } : {}),
    };
  });
  ctx.send(socket, { type: 'history_response', sessionId: msg.sessionId, messages: historyMessages });

  // Surfaces are now included directly in the history_response message (in the surfaces array),
  // so we no longer emit separate ui_surface_show messages during history loading.
}

export function handleUndo(
  msg: UndoRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: 'error', message: 'No active session' });
    return;
  }
  ctx.touchSession(msg.sessionId);
  const removedCount = session.undo();
  ctx.send(socket, { type: 'undo_complete', removedCount, sessionId: msg.sessionId });
}

export async function handleRegenerate(
  msg: RegenerateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: 'error', message: 'No active session' });
    return;
  }
  ctx.touchSession(msg.sessionId);

  const sendEvent = (event: ServerMessage) => ctx.send(socket, event);
  const requestId = uuid();
  session.traceEmitter.emit('request_received', 'Regenerate requested', {
    requestId,
    status: 'info',
    attributes: { source: 'regenerate' },
  });
  try {
    await session.regenerate(sendEvent, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, sessionId: msg.sessionId }, 'Error regenerating message');
    session.traceEmitter.emit('request_error', truncate(message, 200, ''), {
      requestId,
      status: 'error',
      attributes: { errorClass: err instanceof Error ? err.constructor.name : 'Error', message: truncate(message, 500, '') },
    });
    ctx.send(socket, { type: 'error', message: `Failed to regenerate: ${message}` });
    const classified = classifySessionError(err, { phase: 'regenerate' });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
  }
}

export function handleUsageRequest(
  msg: UsageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, { type: 'error', message: 'No active session' });
    return;
  }
  const config = getConfig();
  ctx.send(socket, {
    type: 'usage_response',
    totalInputTokens: conversation.totalInputTokens,
    totalOutputTokens: conversation.totalOutputTokens,
    estimatedCost: conversation.totalEstimatedCost,
    model: config.model,
  });
}

export function handleSandboxSet(
  msg: SandboxSetRequest,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  log.warn(
    { enabled: msg.enabled },
    'Received deprecated sandbox_set message. Runtime sandbox overrides are ignored.',
  );
}

export function handleDeleteQueuedMessage(
  msg: DeleteQueuedMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    log.warn({ sessionId: msg.sessionId, requestId: msg.requestId }, 'No session found for delete_queued_message');
    return;
  }
  const removed = session.removeQueuedMessage(msg.requestId);
  if (removed) {
    ctx.send(socket, {
      type: 'message_queued_deleted',
      sessionId: msg.sessionId,
      requestId: msg.requestId,
    });
  } else {
    log.warn({ sessionId: msg.sessionId, requestId: msg.requestId }, 'Queued message not found for deletion');
  }
}

export const sessionHandlers = defineHandlers({
  user_message: handleUserMessage,
  confirmation_response: handleConfirmationResponse,
  secret_response: handleSecretResponse,
  session_list: (msg, socket, ctx) => handleSessionList(socket, ctx, msg.offset ?? 0, msg.limit ?? 50),
  session_create: handleSessionCreate,
  sessions_clear: (_msg, socket, ctx) => handleSessionsClear(socket, ctx),
  session_switch: handleSessionSwitch,
  cancel: handleCancel,
  delete_queued_message: handleDeleteQueuedMessage,
  history_request: handleHistoryRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
  usage_request: handleUsageRequest,
  sandbox_set: handleSandboxSet,
});
