import * as net from 'node:net';
import { v4 as uuid } from 'uuid';
import { getConfig, loadRawConfig, saveRawConfig } from '../config/loader.js';
import { getProvider, initializeProviders } from '../providers/registry.js';
import { RateLimitProvider } from '../providers/ratelimit.js';
import * as conversationStore from '../memory/conversation-store.js';
import { getLogger } from '../util/logger.js';
import { Session } from './session.js';
import { ComputerUseSession } from './computer-use-session.js';
import type {
  ClientMessage,
  ServerMessage,
  ConfirmationResponse,
  SessionCreateRequest,
  SessionSwitchRequest,
  CancelRequest,
  ModelSetRequest,
  HistoryRequest,
  UndoRequest,
  UsageRequest,
  SandboxSetRequest,
  UserMessage,
  CuSessionCreate,
  CuSessionAbort,
  CuObservation,
  TaskSubmit,
  AppDataRequest,
  SkillDetailRequest,
} from './ipc-protocol.js';
import { loadSkillCatalog, loadSkillBySelector, ensureSkillIcon, readCachedSkillIcon } from '../config/skills.js';
import { handleAmbientObservation } from './ambient-handler.js';
import { classifyInteraction } from './classifier.js';
import { queryAppRecords, createAppRecord, updateAppRecord, deleteAppRecord } from '../memory/app-store.js';

const log = getLogger('handlers');
const HISTORY_ATTACHMENT_TEXT_LIMIT = 500;

/**
 * Find the current socket bound to a given session by reversing the
 * `socketToSession` map. Returns `undefined` if no socket is bound.
 */
function findSocketForSession(
  sessionId: string,
  ctx: HandlerContext,
): net.Socket | undefined {
  for (const [sock, id] of ctx.socketToSession) {
    if (id === sessionId) return sock;
  }
  return undefined;
}

/**
 * Wire the escalation handler on a text_qa session so that invoking
 * `request_computer_control` creates a CU session and notifies the client.
 *
 * Instead of closing over the original `socket`, the handler looks up the
 * current socket for the session at call time via `ctx.socketToSession`.
 * This ensures the handler targets the correct socket even after a
 * disconnect-and-rebind cycle.
 */
function wireEscalationHandler(
  session: Session,
  _socket: net.Socket,
  ctx: HandlerContext,
  screenWidth: number,
  screenHeight: number,
): void {
  session.setEscalationHandler((task: string, sourceSessionId: string): boolean => {
    const currentSocket = findSocketForSession(sourceSessionId, ctx);
    if (!currentSocket) {
      log.warn({ sourceSessionId }, 'Escalation handler: no active socket found for session');
      return false;
    }

    const cuSessionId = uuid();
    const cuMsg: CuSessionCreate = {
      type: 'cu_session_create',
      sessionId: cuSessionId,
      task,
      screenWidth,
      screenHeight,
      interactionType: 'computer_use',
    };
    handleCuSessionCreate(cuMsg, currentSocket, ctx);

    ctx.send(currentSocket, {
      type: 'task_routed',
      sessionId: cuSessionId,
      interactionType: 'computer_use',
      task,
      escalatedFrom: sourceSessionId,
    });

    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function estimateBase64Bytes(base64: string): number {
  const sanitized = base64.trim();
  const padding = sanitized.endsWith('==') ? 2 : (sanitized.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function clampAttachmentText(text: string): string {
  if (text.length <= HISTORY_ATTACHMENT_TEXT_LIMIT) return text;
  return `${text.slice(0, HISTORY_ATTACHMENT_TEXT_LIMIT)}...[truncated]`;
}

function renderImageBlockForHistory(block: Record<string, unknown>): string {
  const source = isRecord(block.source) ? block.source : null;
  const mediaType = source && typeof source.media_type === 'string' ? source.media_type : 'image/*';
  const sizeBytes = source && typeof source.data === 'string' ? estimateBase64Bytes(source.data) : 0;
  if (sizeBytes <= 0) {
    return `[Image attachment] ${mediaType}`;
  }
  return `[Image attachment] ${mediaType}, ${formatBytes(sizeBytes)}`;
}

function renderFileBlockForHistory(block: Record<string, unknown>): string {
  const source = isRecord(block.source) ? block.source : null;
  const mediaType = source && typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream';
  const filename = source && typeof source.filename === 'string' ? source.filename : 'attachment';
  const sizeBytes = source && typeof source.data === 'string' ? estimateBase64Bytes(source.data) : 0;
  const summaryParts = [`[File attachment] ${filename}`, `type=${mediaType}`];
  if (sizeBytes > 0) summaryParts.push(`size=${formatBytes(sizeBytes)}`);

  const extractedText = typeof block.extracted_text === 'string' ? block.extracted_text.trim() : '';
  if (!extractedText) {
    return summaryParts.join(', ');
  }
  return `${summaryParts.join(', ')}\nAttachment text: ${clampAttachmentText(extractedText)}`;
}

export interface HistoryToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface RenderedHistoryContent {
  text: string;
  toolCalls: HistoryToolCall[];
}

export function renderHistoryContent(content: unknown): RenderedHistoryContent {
  if (!Array.isArray(content)) {
    let text: string;
    if (content == null) {
      text = '';
    } else if (typeof content === 'object') {
      text = JSON.stringify(content);
    } else {
      text = String(content);
    }
    return { text, toolCalls: [] };
  }

  const textParts: string[] = [];
  const attachmentParts: string[] = [];
  const toolCalls: HistoryToolCall[] = [];
  const pendingToolUses = new Map<string, HistoryToolCall>();

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'file') {
      attachmentParts.push(renderFileBlockForHistory(block));
      continue;
    }
    if (block.type === 'image') {
      attachmentParts.push(renderImageBlockForHistory(block));
      continue;
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'unknown';
      const input = isRecord(block.input) ? block.input as Record<string, unknown> : {};
      const id = typeof block.id === 'string' ? block.id : '';
      const entry: HistoryToolCall = { name, input };
      toolCalls.push(entry);
      if (id) pendingToolUses.set(id, entry);
      continue;
    }
    if (block.type === 'tool_result') {
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const resultContent = typeof block.content === 'string' ? block.content : '';
      const isError = block.is_error === true;
      const matched = toolUseId ? pendingToolUses.get(toolUseId) : null;
      if (matched) {
        matched.result = resultContent;
        matched.isError = isError;
      } else {
        toolCalls.push({ name: 'unknown', input: {}, result: resultContent, isError });
      }
      continue;
    }
  }

  const text = textParts.join('');
  let rendered: string;
  if (attachmentParts.length === 0) {
    rendered = text;
  } else if (text.trim().length === 0) {
    rendered = attachmentParts.join('\n');
  } else {
    rendered = `${text}\n${attachmentParts.join('\n')}`;
  }

  return { text: rendered, toolCalls };
}

/**
 * Optional overrides for session creation (e.g. interview mode).
 */
export interface SessionCreateOptions {
  systemPromptOverride?: string;
  maxResponseTokens?: number;
}

/**
 * Shared context that handlers need from the DaemonServer.
 * Keeps handlers decoupled from the server class itself.
 */
export interface HandlerContext {
  sessions: Map<string, Session>;
  socketToSession: Map<net.Socket, string>;
  cuSessions: Map<string, ComputerUseSession>;
  socketToCuSession: Map<net.Socket, Set<string>>;
  socketSandboxOverride: Map<net.Socket, boolean>;
  sharedRequestTimestamps: number[];
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  suppressConfigReload: boolean;
  setSuppressConfigReload(value: boolean): void;
  send(socket: net.Socket, msg: ServerMessage): void;
  getOrCreateSession(
    conversationId: string,
    socket?: net.Socket,
    rebindClient?: boolean,
    options?: SessionCreateOptions,
  ): Promise<Session>;
}

// ─── Typed dispatch ──────────────────────────────────────────────────────────

type MessageType = ClientMessage['type'];
type MessageOfType<T extends MessageType> = Extract<ClientMessage, { type: T }>;
type MessageHandler<T extends MessageType> = (
  msg: MessageOfType<T>,
  socket: net.Socket,
  ctx: HandlerContext,
) => void | Promise<void>;
type DispatchMap = { [T in MessageType]: MessageHandler<T> };

const handlers: DispatchMap = {
  user_message: handleUserMessage,
  confirmation_response: handleConfirmationResponse,
  session_list: (_msg, socket, ctx) => handleSessionList(socket, ctx),
  session_create: handleSessionCreate,
  session_switch: handleSessionSwitch,
  cancel: handleCancel,
  model_get: (_msg, socket, ctx) => handleModelGet(socket, ctx),
  model_set: handleModelSet,
  history_request: handleHistoryRequest,
  undo: handleUndo,
  usage_request: handleUsageRequest,
  sandbox_set: handleSandboxSet,
  cu_session_create: handleCuSessionCreate,
  cu_session_abort: handleCuSessionAbort,
  cu_observation: handleCuObservation,
  ambient_observation: handleAmbientObservation,
  task_submit: handleTaskSubmit,
  app_data_request: handleAppDataRequest,
  skills_list: (_msg, socket, ctx) => handleSkillsList(socket, ctx),
  skill_detail: handleSkillDetail,
  ping: (_msg, socket, ctx) => { ctx.send(socket, { type: 'pong' }); },
  ui_surface_action: (msg, _socket, ctx) => {
    const cuSession = ctx.cuSessions.get(msg.sessionId);
    if (cuSession) {
      cuSession.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      session.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface action');
  },
};

export function handleMessage(
  msg: ClientMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const handler = handlers[msg.type] as
    | ((msg: ClientMessage, socket: net.Socket, ctx: HandlerContext) => void)
    | undefined;
  if (!handler) {
    log.warn({ type: msg.type }, 'Unknown message type, ignoring');
    return;
  }
  handler(msg, socket, ctx);
}

// ─── Individual handlers ─────────────────────────────────────────────────────

async function handleUserMessage(
  msg: UserMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ sessionId: msg.sessionId, requestId });
  try {
    ctx.socketToSession.set(socket, msg.sessionId);
    const session = await ctx.getOrCreateSession(msg.sessionId, socket, true);

    const sendEvent = (event: ServerMessage) => ctx.send(socket, event);

    const result = session.enqueueMessage(msg.content ?? '', msg.attachments ?? [], sendEvent, requestId);
    if (result.rejected) {
      rlog.warn('Message rejected — queue is full');
      ctx.send(socket, { type: 'error', message: 'Message rejected — session queue is full. Please wait and try again.' });
      return;
    }
    if (result.queued) {
      rlog.info({ position: session.getQueueDepth() }, 'Message queued (session busy)');
      ctx.send(socket, {
        type: 'message_queued',
        sessionId: msg.sessionId,
        requestId,
        position: session.getQueueDepth(),
      });
      return; // Don't await — message will be processed when current one finishes
    }

    rlog.info('Processing user message');
    // Fire-and-forget: don't block the IPC handler so the connection can
    // continue receiving messages (e.g. cancel, confirmations, or
    // additional user_message that will be queued by the session).
    session.processMessage(msg.content ?? '', msg.attachments ?? [], sendEvent, requestId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      rlog.error({ err }, 'Error processing user message (session or provider failure)');
      ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, 'Error setting up user message processing');
    ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
  }
}

function handleConfirmationResponse(
  msg: ConfirmationResponse,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const sessionId = ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      session.handleConfirmationResponse(
        msg.requestId,
        msg.decision as 'allow' | 'always_allow' | 'deny',
        msg.selectedPattern,
        msg.selectedScope,
      );
    }
  }
}

function handleSessionList(socket: net.Socket, ctx: HandlerContext): void {
  const conversations = conversationStore.listConversations(50);
  ctx.send(socket, {
    type: 'session_list_response',
    sessions: conversations.map((c) => ({
      id: c.id,
      title: c.title ?? 'Untitled',
      updatedAt: c.updatedAt,
    })),
  });
}

async function handleSessionCreate(
  msg: SessionCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.createConversation(
    msg.title ?? 'New Conversation',
  );
  await ctx.getOrCreateSession(conversation.id, socket, true, {
    systemPromptOverride: msg.systemPromptOverride,
    maxResponseTokens: msg.maxResponseTokens,
  });
  ctx.send(socket, {
    type: 'session_info',
    sessionId: conversation.id,
    title: conversation.title ?? 'New Conversation',
    ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
  });
}

async function handleSessionSwitch(
  msg: SessionSwitchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, { type: 'error', message: `Session ${msg.sessionId} not found` });
    return;
  }
  ctx.socketToSession.set(socket, msg.sessionId);
  await ctx.getOrCreateSession(msg.sessionId, socket, true);
  ctx.send(socket, {
    type: 'session_info',
    sessionId: conversation.id,
    title: conversation.title ?? 'Untitled',
  });
}

function handleCancel(msg: CancelRequest, socket: net.Socket, ctx: HandlerContext): void {
  const sessionId = msg.sessionId || ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      session.abort();
    }
  }
}

function handleModelGet(socket: net.Socket, ctx: HandlerContext): void {
  const config = getConfig();
  ctx.send(socket, {
    type: 'model_info',
    model: config.model,
    provider: config.provider,
  });
}

function handleModelSet(
  msg: ModelSetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    // Use raw config to avoid persisting env-var API keys to disk
    const raw = loadRawConfig();
    raw.model = msg.model;

    // Suppress the file watcher callback — handleModelSet already does
    // the full reload sequence; a redundant watcher-triggered reload
    // would incorrectly evict sessions created after this method returns.
    ctx.setSuppressConfigReload(true);
    try {
      saveRawConfig(raw);
    } catch (err) {
      ctx.setSuppressConfigReload(false);
      throw err;
    }
    const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
    if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
    const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, 300);
    ctx.debounceTimers.set('__suppress_reset__', resetTimer);

    // Re-initialize provider with the new model so LLM calls use it
    const config = getConfig();
    initializeProviders(config);

    // Evict idle sessions immediately; mark busy ones as stale so they
    // get recreated with the new provider once they finish processing.
    for (const [id, session] of ctx.sessions) {
      if (!session.isProcessing()) {
        ctx.sessions.delete(id);
      } else {
        session.markStale();
      }
    }

    ctx.send(socket, {
      type: 'model_info',
      model: config.model,
      provider: config.provider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send(socket, { type: 'error', message: `Failed to set model: ${message}` });
  }
}

function handleSandboxSet(
  msg: SandboxSetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Per-socket override: store the sandbox preference for this client only.
  // The override is applied to the session so it doesn't affect other clients.
  ctx.socketSandboxOverride.set(socket, msg.enabled);
  const sessionId = ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      session.setSandboxOverride(msg.enabled);
    }
  }
  log.info({ enabled: msg.enabled }, 'Sandbox override applied (per-session)');
}

export interface ParsedHistoryMessage {
  id?: string;
  role: string;
  text: string;
  timestamp: number;
  toolCalls: HistoryToolCall[];
}

function handleHistoryRequest(
  msg: HistoryRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const dbMessages = conversationStore.getMessages(msg.sessionId);
  const parsed: ParsedHistoryMessage[] = dbMessages.map((m) => {
    let text = '';
    let toolCalls: HistoryToolCall[] = [];
    try {
      const content = JSON.parse(m.content);
      const rendered = renderHistoryContent(content);
      text = rendered.text;
      toolCalls = rendered.toolCalls;
    } catch (err) {
      log.debug({ err, messageId: m.id }, 'Failed to parse message content as JSON, using raw text');
      text = m.content;
    }
    return { role: m.role, text, timestamp: m.createdAt, toolCalls };
  });

  // Merge tool_result data from user messages into the preceding assistant
  // message's toolCalls, and suppress user messages that only contain
  // tool_result blocks (internal agent-loop turns).
  const merged = mergeToolResults(parsed);

  const historyMessages = merged.map((m) => ({
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
  }));
  ctx.send(socket, { type: 'history_response', messages: historyMessages });
}

export function mergeToolResults(messages: ParsedHistoryMessage[]): ParsedHistoryMessage[] {
  const result: ParsedHistoryMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // If this is a user message whose only content is tool_result blocks,
    // merge those results into the preceding assistant message's toolCalls.
    if (msg.role === 'user' && msg.text.trim() === '' && msg.toolCalls.length > 0) {
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (prev && prev.role === 'assistant' && prev.toolCalls.length > 0) {
        // Build a lookup from tool name → result for this user message's tool_results
        for (const resultEntry of msg.toolCalls) {
          // Match by tool_use_id pairing: tool_results are ordered to match
          // the tool_uses in the preceding assistant message, so pair by index
          // of unresolved entries, or fall back to name matching.
          const unresolved = prev.toolCalls.find(
            (tc) => tc.result === undefined,
          );
          if (unresolved) {
            unresolved.result = resultEntry.result;
            unresolved.isError = resultEntry.isError;
          }
        }
      }
      // Suppress this internal user message from the visible history
      continue;
    }

    result.push({ ...msg, toolCalls: msg.toolCalls.map((tc) => ({ ...tc })) });
  }
  return result;
}

function handleUndo(
  msg: UndoRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: 'error', message: 'No active session' });
    return;
  }
  const removedCount = session.undo();
  ctx.send(socket, { type: 'undo_complete', removedCount });
}

function handleUsageRequest(
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

// ─── Skills handlers ─────────────────────────────────────────────────────────

function handleSkillsList(socket: net.Socket, ctx: HandlerContext): void {
  const catalog = loadSkillCatalog();
  // Respond immediately with cached icons (sync reads only)
  const skills = catalog.map((s) => {
    const icon = readCachedSkillIcon(s.directoryPath);
    return { id: s.id, name: s.name, description: s.description, ...(icon ? { icon } : {}) };
  });
  ctx.send(socket, { type: 'skills_list_response', skills });

  // Generate missing icons in the background (fire-and-forget)
  const missing = catalog.filter((s) => !readCachedSkillIcon(s.directoryPath));
  if (missing.length > 0) {
    Promise.all(missing.map((s) => ensureSkillIcon(s.directoryPath, s.name, s.description))).catch(() => {});
  }
}

async function handleSkillDetail(
  msg: SkillDetailRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const result = loadSkillBySelector(msg.skillId);
  if (result.skill) {
    const icon = await ensureSkillIcon(result.skill.directoryPath, result.skill.name, result.skill.description);
    ctx.send(socket, {
      type: 'skill_detail_response',
      skillId: result.skill.id,
      body: result.skill.body,
      ...(icon ? { icon } : {}),
    });
  } else {
    ctx.send(socket, {
      type: 'skill_detail_response',
      skillId: msg.skillId,
      body: '',
      error: result.error ?? 'Skill not found',
    });
  }
}

// ─── App data handler ────────────────────────────────────────────────────────

function handleAppDataRequest(
  msg: AppDataRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const { surfaceId, callId, method, appId, recordId, data } = msg;
  try {
    let result: unknown = null;
    switch (method) {
      case 'query':
        result = queryAppRecords(appId);
        break;
      case 'create':
        if (!data) throw new Error('data is required for create');
        result = createAppRecord(appId, data);
        break;
      case 'update':
        if (!recordId) throw new Error('recordId is required for update');
        if (!data) throw new Error('data is required for update');
        result = updateAppRecord(appId, recordId, data);
        break;
      case 'delete':
        if (!recordId) throw new Error('recordId is required for delete');
        deleteAppRecord(appId, recordId);
        result = null;
        break;
      default:
        throw new Error(`Unknown app data method: ${method}`);
    }
    ctx.send(socket, {
      type: 'app_data_response',
      surfaceId,
      callId,
      success: true,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, method, appId, recordId }, 'Error handling app_data_request');
    ctx.send(socket, {
      type: 'app_data_response',
      surfaceId,
      callId,
      success: false,
      error: message,
    });
  }
}

// ─── Task submit handler ────────────────────────────────────────────────────

async function handleTaskSubmit(
  msg: TaskSubmit,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ requestId });

  try {
    const interactionType = await classifyInteraction(msg.task, msg.source);
    rlog.info({ interactionType, task: msg.task }, 'Task classified');

    if (interactionType === 'computer_use') {
      // Create CU session (reuse handleCuSessionCreate logic)
      const sessionId = uuid();
      const cuMsg: CuSessionCreate = {
        type: 'cu_session_create',
        sessionId,
        task: msg.task,
        screenWidth: msg.screenWidth,
        screenHeight: msg.screenHeight,
        attachments: msg.attachments,
        interactionType: 'computer_use',
      };
      handleCuSessionCreate(cuMsg, socket, ctx);

      ctx.send(socket, {
        type: 'task_routed',
        sessionId,
        interactionType: 'computer_use',
      });
    } else {
      // Create text QA session and immediately start processing
      const conversation = conversationStore.createConversation(msg.task);
      ctx.socketToSession.set(socket, conversation.id);
      const session = await ctx.getOrCreateSession(conversation.id, socket, true);

      // Wire escalation handler so the agent can call request_computer_control
      wireEscalationHandler(session, socket, ctx, msg.screenWidth, msg.screenHeight);

      ctx.send(socket, {
        type: 'task_routed',
        sessionId: conversation.id,
        interactionType: 'text_qa',
      });

      // Start streaming immediately — client doesn't need to send user_message
      session.processMessage(msg.task, msg.attachments ?? [], (event) => {
        ctx.send(socket, event);
      }, requestId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        rlog.error({ err }, 'Error processing task_submit text QA');
        ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, 'Error handling task_submit');
    ctx.send(socket, { type: 'error', message: `Failed to route task: ${message}` });
  }
}

// ─── Computer-use handlers ──────────────────────────────────────────────────

function removeCuSessionReferences(
  ctx: HandlerContext,
  sessionId: string,
  expectedSession?: ComputerUseSession,
): void {
  const current = ctx.cuSessions.get(sessionId);
  if (expectedSession && current && current !== expectedSession) {
    return;
  }
  ctx.cuSessions.delete(sessionId);
  for (const [sock, ids] of ctx.socketToCuSession) {
    if (ids.delete(sessionId) && ids.size === 0) {
      ctx.socketToCuSession.delete(sock);
    }
  }
}

function handleCuSessionCreate(
  msg: CuSessionCreate,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Abort any existing session with the same ID to prevent zombies,
  // and remove it from the previous owner's socket set so disconnect
  // cleanup doesn't accidentally abort the replacement session.
  const existingSession = ctx.cuSessions.get(msg.sessionId);
  if (existingSession) {
    existingSession.abort();
    removeCuSessionReferences(ctx, msg.sessionId, existingSession);
  }

  const config = getConfig();
  let provider = getProvider(config.provider);
  const { rateLimit } = config;
  if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
    provider = new RateLimitProvider(provider, rateLimit, ctx.sharedRequestTimestamps);
  }

  const sendToClient = (serverMsg: ServerMessage) => {
    ctx.send(socket, serverMsg);
  };

  const sessionRef: { current?: ComputerUseSession } = {};
  const onTerminal = (sessionId: string) => {
    removeCuSessionReferences(ctx, sessionId, sessionRef.current);
    log.info({ sessionId }, 'Computer-use session cleaned up after terminal state');
  };

  const session = new ComputerUseSession(
    msg.sessionId,
    msg.task,
    msg.screenWidth,
    msg.screenHeight,
    provider,
    sendToClient,
    msg.interactionType,
    onTerminal,
  );
  sessionRef.current = session;

  ctx.cuSessions.set(msg.sessionId, session);

  // Track all CU sessions per socket so disconnect cleans up all of them
  let sessionIds = ctx.socketToCuSession.get(socket);
  if (!sessionIds) {
    sessionIds = new Set();
    ctx.socketToCuSession.set(socket, sessionIds);
  }
  sessionIds.add(msg.sessionId);

  log.info({ sessionId: msg.sessionId, task: msg.task }, 'Computer-use session created');
}

function handleCuSessionAbort(
  msg: CuSessionAbort,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.cuSessions.get(msg.sessionId);
  if (!session) {
    log.debug({ sessionId: msg.sessionId }, 'CU session abort: session not found (already finished?)');
    return;
  }
  session.abort();
  removeCuSessionReferences(ctx, msg.sessionId, session);
  log.info({ sessionId: msg.sessionId }, 'Computer-use session aborted by client');
}

function handleCuObservation(
  msg: CuObservation,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.cuSessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, {
      type: 'cu_error',
      sessionId: msg.sessionId,
      message: `No computer-use session found for id ${msg.sessionId}`,
    });
    return;
  }

  // Fire-and-forget: the session sends messages via its sendToClient callback
  session.handleObservation(msg).catch((err) => {
    log.error({ err, sessionId: msg.sessionId }, 'Error handling CU observation');
  });
}
