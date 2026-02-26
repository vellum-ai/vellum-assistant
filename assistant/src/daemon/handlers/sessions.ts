import * as net from 'node:net';

import { v4 as uuid } from 'uuid';

import { type InterfaceId,isChannelId, parseChannelId, parseInterfaceId } from '../../channels/types.js';
import { getConfig } from '../../config/loader.js';
import { getAttachmentsForMessage, setAttachmentThumbnail } from '../../memory/attachments-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { GENERATING_TITLE, queueGenerateConversationTitle, UNTITLED_FALLBACK } from '../../memory/conversation-title-service.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { redactSecrets } from '../../security/secret-scanner.js';
import { getSubagentManager } from '../../subagent/index.js';
import { silentlyWithLog } from '../../util/silently.js';
import { truncate } from '../../util/truncate.js';
import { getAssistantName } from '../identity-helpers.js';
import type { UserMessageAttachment } from '../ipc-contract.js';
import type {
  CancelRequest,
  ConfirmationResponse,
  ConversationSearchRequest,
  DeleteQueuedMessage,
  HistoryRequest,
  RegenerateRequest,
  SandboxSetRequest,
  SecretResponse,
  ServerMessage,
  SessionCreateRequest,
  SessionRenameRequest,
  SessionSwitchRequest,
  UndoRequest,
  UsageRequest,
  UserMessage,
} from '../ipc-protocol.js';
import { normalizeThreadType } from '../ipc-protocol.js';
import { executeRecordingIntent } from '../recording-executor.js';
import { resolveRecordingIntent } from '../recording-intent.js';
import { buildSessionErrorMessage,classifySessionError } from '../session-error.js';
import { generateVideoThumbnail } from '../video-thumbnail.js';
import { handleRecordingStart, handleRecordingStop } from './recording.js';
import {
  defineHandlers,
  type HandlerContext,
  type HistorySurface,
  type HistoryToolCall,
  log,
  mergeToolResults,
  type ParsedHistoryMessage,
  pendingStandaloneSecrets,
  renderHistoryContent,
  wireEscalationHandler,
} from './shared.js';

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
    const ipcChannel = parseChannelId(msg.channel) ?? 'vellum';
    const ipcInterface = parseInterfaceId(msg.interface);
    if (!ipcInterface) {
      ctx.send(socket, {
        type: 'error',
        message: 'Invalid user_message: interface is required and must be valid',
      });
      return;
    }
    const queuedChannelMetadata = {
      userMessageChannel: ipcChannel,
      assistantMessageChannel: ipcChannel,
      userMessageInterface: ipcInterface,
      assistantMessageInterface: ipcInterface,
    };

    const dispatchUserMessage = (
      content: string,
      attachments: UserMessageAttachment[],
      dispatchRequestId: string,
      source: 'user_message' | 'secure_redirect_resume',
      activeSurfaceId?: string,
      currentPage?: string,
    ): void => {
      const receivedDescription = source === 'user_message'
        ? 'User message received'
        : 'Resuming message after secure credential save';
      const queuedDescription = source === 'user_message'
        ? 'Message queued (session busy)'
        : 'Resumed message queued (session busy)';

      session.traceEmitter.emit('request_received', receivedDescription, {
        requestId: dispatchRequestId,
        status: 'info',
        attributes: { source },
      });

      const result = session.enqueueMessage(
        content,
        attachments,
        sendEvent,
        dispatchRequestId,
        activeSurfaceId,
        currentPage,
        queuedChannelMetadata,
      );
      if (result.rejected) {
        rlog.warn({ source }, 'Message rejected — queue is full');
        session.traceEmitter.emit('request_error', 'Message rejected — queue is full', {
          requestId: dispatchRequestId,
          status: 'error',
          attributes: { reason: 'queue_full', queueDepth: session.getQueueDepth(), source },
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
        rlog.info({ source, position }, queuedDescription);
        session.traceEmitter.emit('request_queued', `Message queued at position ${position}`, {
          requestId: dispatchRequestId,
          status: 'info',
          attributes: { position, source },
        });
        ctx.send(socket, {
          type: 'message_queued',
          sessionId: msg.sessionId,
          requestId: dispatchRequestId,
          position,
        });
        return;
      }

      rlog.info({ source }, 'Processing user message');
      session.setTurnChannelContext({
        userMessageChannel: ipcChannel,
        assistantMessageChannel: ipcChannel,
      });
      session.setTurnInterfaceContext({
        userMessageInterface: ipcInterface,
        assistantMessageInterface: ipcInterface,
      });
      session.setAssistantId('self');
      // IPC/desktop user IS the guardian — default to guardian role so messages
      // are not tagged 'unverified_channel' (which blocks memory extraction).
      session.setGuardianContext({ actorRole: 'guardian', sourceChannel: ipcChannel });
      session.setCommandIntent(null);
      // Fire-and-forget: don't block the IPC handler so the connection can
      // continue receiving messages (e.g. cancel, confirmations, or
      // additional user_message that will be queued by the session).
      session.processMessage(content, attachments, sendEvent, dispatchRequestId, activeSurfaceId, currentPage).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        rlog.error({ err, source }, 'Error processing user message (session or provider failure)');
        ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
        const classified = classifySessionError(err, { phase: 'agent_loop' });
        ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
      });
    };

    const config = getConfig();
    let messageText = msg.content ?? '';

    // Block inbound messages that contain secrets and redirect to secure prompt
    if (!msg.bypassSecretCheck) {
      const ingressCheck = checkIngressForSecrets(messageText);
      if (ingressCheck.blocked) {
        rlog.warn({ detectedTypes: ingressCheck.detectedTypes }, 'Blocked user message containing secrets');
        ctx.send(socket, {
          type: 'error',
          message: ingressCheck.userNotice!,
          category: 'secret_blocked',
        });

        const redactedMessageText = redactSecrets(messageText, {
          enabled: true,
          base64Threshold: config.secretDetection.entropyThreshold,
        }).trim();

        // Redirect: trigger a secure prompt so the user can enter the secret safely.
        // After save, continue the same request with redacted text so the model keeps
        // user intent without ever receiving the raw secret value.
        session.redirectToSecurePrompt(ingressCheck.detectedTypes, {
          onStored: (record) => {
            ctx.send(socket, {
              type: 'assistant_text_delta',
              sessionId: msg.sessionId,
              text: 'Saved your secret securely. Continuing with your request.',
            });
            ctx.send(socket, { type: 'message_complete', sessionId: msg.sessionId });

            const continuationParts: string[] = [];
            if (redactedMessageText.length > 0) continuationParts.push(redactedMessageText);
            continuationParts.push(
              `I entered the redacted secret via the Secure Credential UI and saved it as credential ${record.service}/${record.field}. ` +
              'Continue with my request using that stored credential and do not ask me to paste the secret again.',
            );
            const continuationMessage = continuationParts.join('\n\n');
            const continuationRequestId = uuid();
            dispatchUserMessage(
              continuationMessage,
              msg.attachments ?? [],
              continuationRequestId,
              'secure_redirect_resume',
              msg.activeSurfaceId,
              msg.currentPage,
            );
          },
        });
        return;
      }
    }

    // ── Structured command intent (bypasses text parsing) ──────────────────
    if (config.daemon.standaloneRecording && msg.commandIntent?.domain === 'screen_recording') {
      const action = msg.commandIntent.action;
      rlog.info({ action, source: 'commandIntent' }, 'Recording command intent received');
      if (action === 'start') {
        const recordingId = handleRecordingStart(msg.sessionId, { promptForSource: true }, socket, ctx);
        ctx.send(socket, {
          type: 'assistant_text_delta',
          text: recordingId ? 'Starting screen recording.' : 'A recording is already active.',
          sessionId: msg.sessionId,
        });
        ctx.send(socket, { type: 'message_complete', sessionId: msg.sessionId });
        return;
      } else if (action === 'stop') {
        const stopped = handleRecordingStop(msg.sessionId, ctx) !== undefined;
        ctx.send(socket, {
          type: 'assistant_text_delta',
          text: stopped ? 'Stopping the recording.' : 'No active recording to stop.',
          sessionId: msg.sessionId,
        });
        ctx.send(socket, { type: 'message_complete', sessionId: msg.sessionId });
        return;
      }
      // Unrecognized action — fall through to normal text handling so the
      // user message is not silently dropped.
      rlog.warn({ action, source: 'commandIntent' }, 'Unrecognized screen_recording action, falling through to text handling');
    }

    // ── Standalone recording intent interception ──────────────────────────
    if (config.daemon.standaloneRecording && messageText) {
      const name = getAssistantName();
      const dynamicNames = [name].filter(Boolean) as string[];
      const intentResult = resolveRecordingIntent(messageText, dynamicNames);
      const execResult = executeRecordingIntent(intentResult, {
        conversationId: msg.sessionId,
        socket,
        ctx,
      });

      if (execResult.handled) {
        rlog.info({ kind: intentResult.kind }, 'Recording intent intercepted in user_message');
        ctx.send(socket, {
          type: 'assistant_text_delta',
          text: execResult.responseText!,
          sessionId: msg.sessionId,
        });
        ctx.send(socket, { type: 'message_complete', sessionId: msg.sessionId });
        return;
      }

      if (execResult.remainderText) {
        // Execute deferred recording actions immediately for user_message path
        if (execResult.pendingStop) handleRecordingStop(msg.sessionId, ctx);
        if (execResult.pendingStart) handleRecordingStart(msg.sessionId, { promptForSource: true }, socket, ctx);
        messageText = execResult.remainderText;
        rlog.info({ remaining: execResult.remainderText }, 'Recording intent handled, continuing with remaining text');
      }
    }

    dispatchUserMessage(
      messageText,
      msg.attachments ?? [],
      requestId,
      'user_message',
      msg.activeSurfaceId,
      msg.currentPage,
    );
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
      const originChannel = parseChannelId(c.originChannel);
      const originInterface = parseInterfaceId(c.originInterface);
      return {
        id: c.id,
        title: c.title ?? 'Untitled',
        updatedAt: c.updatedAt,
        threadType: normalizeThreadType(c.threadType),
        source: c.source ?? 'user',
        ...(binding && isChannelId(binding.sourceChannel) ? {
          channelBinding: {
            sourceChannel: binding.sourceChannel,
            externalChatId: binding.externalChatId,
            externalUserId: binding.externalUserId,
            displayName: binding.displayName,
            username: binding.username,
          },
        } : {}),
        ...(originChannel ? { conversationOriginChannel: originChannel } : {}),
        ...(originInterface ? { conversationOriginInterface: originInterface } : {}),
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
  const title = msg.title ?? (msg.initialMessage ? GENERATING_TITLE : 'New Conversation');
  const conversation = conversationStore.createConversation({
    title,
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
    session.setPreactivatedSkillIds(msg.preactivatedSkillIds);
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
    // Queue title generation immediately (matches all other creation paths).
    // The agent loop success path will also attempt title generation, but
    // queueGenerateConversationTitle is safe to call redundantly — the
    // replaceability check prevents double-writes. This ensures the title
    // is generated even if the agent loop fails or is cancelled.
    if (title === GENERATING_TITLE) {
      queueGenerateConversationTitle({
        conversationId: conversation.id,
        context: { origin: 'ipc' },
        userMessage: msg.initialMessage,
        onTitleUpdated: (newTitle) => {
          ctx.send(socket, {
            type: 'session_title_updated',
            sessionId: conversation.id,
            title: newTitle,
          });
        },
      });
    }

    ctx.socketToSession.set(socket, conversation.id);
    const sendEvent = (event: ServerMessage) => ctx.send(socket, event);
    const requestId = uuid();
    const transportChannel = parseChannelId(msg.transport?.channelId) ?? 'vellum';
    session.setTurnChannelContext({
      userMessageChannel: transportChannel,
      assistantMessageChannel: transportChannel,
    });
    const transportInterface: InterfaceId = parseInterfaceId(msg.transport?.interfaceId) ?? 'vellum';
    session.setTurnInterfaceContext({
      userMessageInterface: transportInterface,
      assistantMessageInterface: transportInterface,
    });
    session.processMessage(msg.initialMessage, [], sendEvent, requestId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId: conversation.id }, 'Error processing initial message');
      ctx.send(socket, { type: 'error', message: `Failed to process initial message: ${message}` });

      // Replace stuck loading placeholder with a stable fallback title
      // if title generation hasn't already completed or been renamed.
      try {
        const current = conversationStore.getConversation(conversation.id);
        if (current && current.title === GENERATING_TITLE) {
          const fallback = UNTITLED_FALLBACK;
          conversationStore.updateConversationTitle(conversation.id, fallback);
          ctx.send(socket, {
            type: 'session_title_updated',
            sessionId: conversation.id,
            title: fallback,
          });
        }
      } catch {
        // Best-effort fallback
      }
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

export function handleSessionRename(
  msg: SessionRenameRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, { type: 'error', message: `Session ${msg.sessionId} not found` });
    return;
  }
  conversationStore.updateConversationTitle(msg.sessionId, msg.title, 0);
  ctx.send(socket, {
    type: 'session_title_updated',
    sessionId: msg.sessionId,
    title: msg.title,
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
  // Default to unlimited when callers don't specify a limit, preserving
  // backward-compatible behavior of returning full conversation history.
  const limit = msg.limit;

  // Resolve include flags: explicit flags override mode, mode provides defaults.
  // Default mode is 'light' when no mode and no include flags are specified.
  const isFullMode = msg.mode === 'full';
  const includeAttachments = msg.includeAttachments ?? isFullMode;
  const includeToolImages = msg.includeToolImages ?? isFullMode;
  const includeSurfaceData = msg.includeSurfaceData ?? isFullMode;

  const { messages: dbMessages, hasMore } = conversationStore.getMessagesPaginated(
    msg.sessionId,
    limit,
    msg.beforeTimestamp,
    msg.beforeMessageId,
  );

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
        if (includeAttachments) {
          // Full attachment data: same behavior as before
          const MAX_INLINE_B64_SIZE = 512 * 1024;
          attachments = linked.map((a) => {
            const isFileBacked = !a.dataBase64;
            const omit = isFileBacked || (a.mimeType.startsWith('video/') && a.dataBase64.length > MAX_INLINE_B64_SIZE);

            if (a.mimeType.startsWith('video/') && !a.thumbnailBase64 && a.dataBase64) {
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
        } else {
          // Light mode: metadata only, strip base64 data
          attachments = linked.map((a) => ({
            id: a.id,
            filename: a.originalFilename,
            mimeType: a.mimeType,
            data: '',
            sizeBytes: a.sizeBytes,
            ...(a.thumbnailBase64 ? { thumbnailData: a.thumbnailBase64 } : {}),
          }));
        }
      }
    }

    // In light mode, strip imageData from tool calls
    const filteredToolCalls = m.toolCalls.length > 0
      ? (includeToolImages
        ? m.toolCalls
        : m.toolCalls.map((tc) => {
          if (tc.imageData) {
            const { imageData: _, ...rest } = tc;
            return rest;
          }
          return tc;
        }))
      : m.toolCalls;

    // In light mode, strip full data from surfaces (keep metadata)
    const filteredSurfaces = m.surfaces.length > 0
      ? (includeSurfaceData
        ? m.surfaces
        : m.surfaces.map((s) => ({
          surfaceId: s.surfaceId,
          surfaceType: s.surfaceType,
          title: s.title,
          data: {} as Record<string, unknown>,
          ...(s.actions ? { actions: s.actions } : {}),
          ...(s.display ? { display: s.display } : {}),
        })))
      : m.surfaces;

    return {
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      ...(filteredToolCalls.length > 0 ? { toolCalls: filteredToolCalls, toolCallsBeforeText: m.toolCallsBeforeText } : {}),
      ...(attachments ? { attachments } : {}),
      ...(m.textSegments.length > 0 ? { textSegments: m.textSegments } : {}),
      ...(m.contentOrder.length > 0 ? { contentOrder: m.contentOrder } : {}),
      ...(filteredSurfaces.length > 0 ? { surfaces: filteredSurfaces } : {}),
      ...(m.subagentNotification ? { subagentNotification: m.subagentNotification } : {}),
    };
  });

  const oldestTimestamp = historyMessages.length > 0 ? historyMessages[0].timestamp : undefined;
  // Provide the oldest message ID as a tie-breaker cursor so clients can
  // paginate without skipping same-millisecond messages at page boundaries.
  const oldestMessageId = historyMessages.length > 0 ? historyMessages[0].id : undefined;

  ctx.send(socket, {
    type: 'history_response',
    sessionId: msg.sessionId,
    messages: historyMessages,
    hasMore,
    ...(oldestTimestamp !== undefined ? { oldestTimestamp } : {}),
    ...(oldestMessageId ? { oldestMessageId } : {}),
  });

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

export function handleConversationSearch(
  msg: ConversationSearchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const results = conversationStore.searchConversations(msg.query, {
    limit: msg.limit,
    maxMessagesPerConversation: msg.maxMessagesPerConversation,
  });
  ctx.send(socket, {
    type: 'conversation_search_response',
    query: msg.query,
    results,
  });
}

export const sessionHandlers = defineHandlers({
  user_message: handleUserMessage,
  confirmation_response: handleConfirmationResponse,
  secret_response: handleSecretResponse,
  session_list: (msg, socket, ctx) => handleSessionList(socket, ctx, msg.offset ?? 0, msg.limit ?? 50),
  session_create: handleSessionCreate,
  sessions_clear: (_msg, socket, ctx) => handleSessionsClear(socket, ctx),
  session_switch: handleSessionSwitch,
  session_rename: handleSessionRename,
  cancel: handleCancel,
  delete_queued_message: handleDeleteQueuedMessage,
  history_request: handleHistoryRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
  usage_request: handleUsageRequest,
  sandbox_set: handleSandboxSet,
  conversation_search: handleConversationSearch,
});
