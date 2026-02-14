import * as net from 'node:net';
import { v4 as uuid } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig, loadRawConfig, saveRawConfig, invalidateConfigCache } from '../config/loader.js';
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
  SecretResponse,
  SessionCreateRequest,
  SessionSwitchRequest,
  CancelRequest,
  ModelSetRequest,
  HistoryRequest,
  UndoRequest,
  RegenerateRequest,
  UsageRequest,
  SandboxSetRequest,
  UserMessage,
  CuSessionCreate,
  CuSessionAbort,
  CuObservation,
  TaskSubmit,
  AppDataRequest,
  SkillDetailRequest,
  SkillsEnableRequest,
  SkillsDisableRequest,
  SkillsConfigureRequest,
  SkillsInstallRequest,
  SkillsUninstallRequest,
  SkillsUpdateRequest,
  SkillsCheckUpdatesRequest,
  SkillsSearchRequest,
  SkillsInspectRequest,
  SuggestionRequest,
  AddTrustRule,
  RemoveTrustRule,
  UpdateTrustRule,
  BundleAppRequest,
  SharedAppDeleteRequest,
  UiSurfaceShow,
} from './ipc-protocol.js';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addRule, removeRule, updateRule, getAllRules } from '../permissions/trust-store.js';
import { loadSkillCatalog, loadSkillBySelector, ensureSkillIcon } from '../config/skills.js';
import { resolveSkillStates } from '../config/skill-state.js';
import { handleAmbientObservation } from './ambient-handler.js';
import { classifyInteraction } from './classifier.js';
import { queryAppRecords, createAppRecord, updateAppRecord, deleteAppRecord, listApps, getApp } from '../memory/app-store.js';
import { getRootDir } from '../util/platform.js';
import { clawhubInstall, clawhubUpdate, clawhubSearch, clawhubCheckUpdates, clawhubInspect } from '../skills/clawhub.js';
import { parseSlashCandidate } from '../skills/slash-commands.js';
import { packageApp } from '../bundler/app-bundler.js';
import { handleOpenBundle } from './handlers/open-bundle-handler.js';
import { classifySessionError, buildSessionErrorMessage } from './session-error.js';

const log = getLogger('handlers');
const HISTORY_ATTACHMENT_TEXT_LIMIT = 500;

const FALLBACK_SCREEN = { width: 1920, height: 1080 };
let cachedScreenDims: { width: number; height: number } | null = null;

/**
 * Query the main display dimensions via CoreGraphics.
 * Cached after the first successful call; falls back to 1920x1080.
 */
function getScreenDimensions(): { width: number; height: number } {
  if (cachedScreenDims) return cachedScreenDims;
  try {
    const out = execSync(
      `swift -e 'import CoreGraphics; let b = CGDisplayBounds(CGMainDisplayID()); print("\\(Int(b.width))x\\(Int(b.height))")'`,
      { timeout: 10_000, encoding: 'utf-8' },
    ).trim();
    const [w, h] = out.split('x').map(Number);
    if (w > 0 && h > 0) {
      cachedScreenDims = { width: w, height: h };
      return cachedScreenDims;
    }
  } catch (err) {
    log.debug({ err }, 'Failed to query screen dimensions, using fallback');
  }
  return FALLBACK_SCREEN;
}

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
  explicitWidth?: number,
  explicitHeight?: number,
): void {
  const dims = (explicitWidth && explicitHeight)
    ? { width: explicitWidth, height: explicitHeight }
    : getScreenDimensions();
  const screenWidth = dims.width;
  const screenHeight = dims.height;
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
  return `${text.slice(0, HISTORY_ATTACHMENT_TEXT_LIMIT)}<truncated />`;
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
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot). */
  imageData?: string;
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
      // Extract base64 image data from persisted contentBlocks (e.g. browser_screenshot)
      let imageData: string | undefined;
      if (Array.isArray(block.contentBlocks)) {
        const imgBlock = block.contentBlocks.find(
          (b: Record<string, unknown>) => isRecord(b) && b.type === 'image',
        );
        if (imgBlock && isRecord(imgBlock) && isRecord(imgBlock.source)) {
          const src = imgBlock.source as Record<string, unknown>;
          if (typeof src.data === 'string') {
            imageData = src.data;
          }
        }
      }
      const matched = toolUseId ? pendingToolUses.get(toolUseId) : null;
      if (matched) {
        matched.result = resultContent;
        matched.isError = isError;
        if (imageData) matched.imageData = imageData;
      } else {
        toolCalls.push({ name: 'unknown', input: {}, result: resultContent, isError, ...(imageData ? { imageData } : {}) });
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
  updateConfigFingerprint(): void;
  send(socket: net.Socket, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  clearAllSessions(): number;
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
  secret_response: handleSecretResponse,
  session_list: (_msg, socket, ctx) => handleSessionList(socket, ctx),
  session_create: handleSessionCreate,
  sessions_clear: (_msg, socket, ctx) => handleSessionsClear(socket, ctx),
  session_switch: handleSessionSwitch,
  cancel: handleCancel,
  model_get: (_msg, socket, ctx) => handleModelGet(socket, ctx),
  model_set: handleModelSet,
  history_request: handleHistoryRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
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
  skills_enable: handleSkillsEnable,
  skills_disable: handleSkillsDisable,
  skills_configure: handleSkillsConfigure,
  skills_install: handleSkillsInstall,
  skills_uninstall: handleSkillsUninstall,
  skills_update: handleSkillsUpdate,
  skills_check_updates: handleSkillsCheckUpdates,
  skills_search: handleSkillsSearch,
  skills_inspect: handleSkillsInspect,
  suggestion_request: handleSuggestionRequest,
  add_trust_rule: handleAddTrustRule,
  trust_rules_list: (_msg, socket, ctx) => handleTrustRulesList(socket, ctx),
  remove_trust_rule: handleRemoveTrustRule,
  update_trust_rule: handleUpdateTrustRule,
  bundle_app: handleBundleApp,
  open_bundle: handleOpenBundle,
  app_open_request: (msg, socket, ctx) => handleAppOpenRequest(msg, socket, ctx),
  apps_list: (_msg, socket, ctx) => handleAppsList(socket, ctx),
  shared_apps_list: (_msg, socket, ctx) => handleSharedAppsList(socket, ctx),
  shared_app_delete: handleSharedAppDelete,
  sign_bundle_payload_response: (_msg, _socket, _ctx) => {
    // TODO(signing): Route to pending promise resolution once the daemon-driven
    // IPC signing orchestration is wired up. Currently a no-op placeholder to
    // satisfy the exhaustive dispatch map; signing is invoked via SigningCallback.
  },
  get_signing_identity_response: (_msg, _socket, _ctx) => {
    // TODO(signing): Route to pending promise resolution once the daemon-driven
    // IPC signing orchestration is wired up. Currently a no-op placeholder to
    // satisfy the exhaustive dispatch map; signing is invoked via SigningCallback.
  },
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
    // Only wire the escalation handler if one isn't already set — handleTaskSubmit
    // sets a handler with the client's actual screen dimensions, and overwriting it
    // here would replace those dimensions with the daemon's defaults.
    if (!session.hasEscalationHandler()) {
      wireEscalationHandler(session, socket, ctx);
    }

    const sendEvent = (event: ServerMessage) => ctx.send(socket, event);

    session.traceEmitter.emit('request_received', 'User message received', {
      requestId,
      status: 'info',
      attributes: { source: 'user_message' },
    });

    const result = session.enqueueMessage(msg.content ?? '', msg.attachments ?? [], sendEvent, requestId);
    if (result.rejected) {
      rlog.warn('Message rejected — queue is full');
      ctx.send(socket, buildSessionErrorMessage(msg.sessionId, {
        code: 'QUEUE_FULL',
        userMessage: 'The message queue is full. Please wait and try again.',
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
    // Fire-and-forget: don't block the IPC handler so the connection can
    // continue receiving messages (e.g. cancel, confirmations, or
    // additional user_message that will be queued by the session).
    session.processMessage(msg.content ?? '', msg.attachments ?? [], sendEvent, requestId).catch((err) => {
      rlog.error({ err }, 'Error processing user message (session or provider failure)');
      const classified = classifySessionError(err, { phase: 'agent_loop' });
      ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
    });
  } catch (err) {
    rlog.error({ err }, 'Error setting up user message processing');
    const classified = classifySessionError(err, { phase: 'handler' });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
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

function handleSecretResponse(
  msg: SecretResponse,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const sessionId = ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      session.handleSecretResponse(msg.requestId, msg.value);
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

function handleSessionsClear(socket: net.Socket, ctx: HandlerContext): void {
  const cleared = ctx.clearAllSessions();
  // Also clear DB conversations. When a new IPC connection triggers
  // sendInitialSession, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  conversationStore.clearAll();
  ctx.send(socket, { type: 'sessions_clear_response', cleared });
}

async function handleSessionCreate(
  msg: SessionCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.createConversation(
    msg.title ?? 'New Conversation',
  );
  const session = await ctx.getOrCreateSession(conversation.id, socket, true, {
    systemPromptOverride: msg.systemPromptOverride,
    maxResponseTokens: msg.maxResponseTokens,
  });
  wireEscalationHandler(session, socket, ctx);
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
  const session = await ctx.getOrCreateSession(msg.sessionId, socket, true);
  // Only wire the escalation handler if one isn't already set — handleTaskSubmit
  // sets a handler with the client's actual screen dimensions, and overwriting it
  // here would replace those dimensions with the daemon's defaults.
  if (!session.hasEscalationHandler()) {
    wireEscalationHandler(session, socket, ctx);
  }
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
        session.dispose();
        ctx.sessions.delete(id);
      } else {
        session.markStale();
      }
    }

    ctx.updateConfigFingerprint();

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
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  log.warn(
    { enabled: msg.enabled },
    'Received deprecated sandbox_set message. Runtime sandbox overrides are ignored.',
  );
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
  ctx.send(socket, { type: 'history_response', sessionId: msg.sessionId, messages: historyMessages });
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
            if (resultEntry.imageData) unresolved.imageData = resultEntry.imageData;
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
  ctx.send(socket, { type: 'undo_complete', removedCount, sessionId: msg.sessionId });
}

async function handleRegenerate(
  msg: RegenerateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: 'error', message: 'No active session' });
    return;
  }

  const sendEvent = (event: ServerMessage) => ctx.send(socket, event);
  session.traceEmitter.emit('request_received', 'Regenerate requested', {
    status: 'info',
    attributes: { source: 'regenerate' },
  });
  try {
    await session.regenerate(sendEvent);
  } catch (err) {
    log.error({ err, sessionId: msg.sessionId }, 'Error regenerating message');
    const classified = classifySessionError(err, { phase: 'regenerate' });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
  }
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
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);

  const skills = resolved.map((r) => ({
    id: r.summary.id,
    name: r.summary.name,
    description: r.summary.description,
    emoji: r.summary.emoji,
    homepage: r.summary.homepage,
    source: r.summary.source as 'bundled' | 'managed' | 'workspace' | 'clawhub' | 'extra',
    state: (r.state === 'degraded' ? 'enabled' : r.state) as 'enabled' | 'disabled' | 'available',
    degraded: r.degraded,
    missingRequirements: r.missingRequirements,
    updateAvailable: false,
    userInvocable: r.summary.userInvocable,
  }));

  ctx.send(socket, { type: 'skills_list_response', skills });
}

/** Get or create the skill entry object for a given skill name, creating intermediate objects as needed.
 *  Guards against malformed config (e.g. skills or entries being a string, array, or null)
 *  by resetting non-object intermediates to {}, restoring self-healing behavior. */
function ensureSkillEntry(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!isRecord(raw.skills) || Array.isArray(raw.skills)) raw.skills = {};
  const skills = raw.skills as Record<string, unknown>;
  if (!isRecord(skills.entries) || Array.isArray(skills.entries)) skills.entries = {};
  const entries = skills.entries as Record<string, unknown>;
  if (!isRecord(entries[name]) || Array.isArray(entries[name])) entries[name] = {};
  return entries[name] as Record<string, unknown>;
}
function handleSkillsEnable(
  msg: SkillsEnableRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, msg.name).enabled = true;

    ctx.setSuppressConfigReload(true);
    try {
      saveRawConfig(raw);
    } catch (err) {
      ctx.setSuppressConfigReload(false);
      throw err;
    }
    invalidateConfigCache();

    const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
    if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
    const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, 300);
    ctx.debounceTimers.set('__suppress_reset__', resetTimer);

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'enable',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: msg.name,
      state: 'enabled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to enable skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'enable',
      success: false,
      error: message,
    });
  }
}

function handleSkillsDisable(
  msg: SkillsDisableRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, msg.name).enabled = false;

    ctx.setSuppressConfigReload(true);
    try {
      saveRawConfig(raw);
    } catch (err) {
      ctx.setSuppressConfigReload(false);
      throw err;
    }
    invalidateConfigCache();

    const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
    if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
    const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, 300);
    ctx.debounceTimers.set('__suppress_reset__', resetTimer);

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'disable',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: msg.name,
      state: 'disabled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to disable skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'disable',
      success: false,
      error: message,
    });
  }
}

function handleSkillsConfigure(
  msg: SkillsConfigureRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();

    const entry = ensureSkillEntry(raw, msg.name);
    if (msg.env) {
      entry.env = msg.env;
    }
    if (msg.apiKey !== undefined) {
      entry.apiKey = msg.apiKey;
    }
    if (msg.config) {
      entry.config = msg.config;
    }

    ctx.setSuppressConfigReload(true);
    try {
      saveRawConfig(raw);
    } catch (err) {
      ctx.setSuppressConfigReload(false);
      throw err;
    }
    invalidateConfigCache();

    const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
    if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
    const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, 300);
    ctx.debounceTimers.set('__suppress_reset__', resetTimer);

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'configure',
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to configure skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'configure',
      success: false,
      error: message,
    });
  }
}

async function handleSkillsInstall(
  msg: SkillsInstallRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubInstall(msg.slug, { version: msg.version });
    if (!result.success) {
      ctx.send(socket, {
        type: 'skills_operation_response',
        operation: 'install',
        success: false,
        error: result.error ?? 'Unknown error',
      });
      return;
    }

    // Reload skill catalog so the newly installed skill is picked up
    loadSkillCatalog();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'install',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: result.skillName ?? msg.slug,
      state: 'installed',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to install skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'install',
      success: false,
      error: message,
    });
  }
}

async function handleSkillsUninstall(
  msg: SkillsUninstallRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  // Validate skill name to prevent path traversal while allowing namespaced slugs (org/name)
  const validNamespacedSlug = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const validSimpleName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (msg.name.includes('..') || msg.name.includes('\\') || !(validSimpleName.test(msg.name) || validNamespacedSlug.test(msg.name))) {
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
      success: false,
      error: 'Invalid skill name',
    });
    return;
  }
  const skillDir = join(getRootDir(), 'skills', msg.name);
  if (!existsSync(skillDir)) {
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
      success: false,
      error: 'Skill not found',
    });
    return;
  }
  try {
    rmSync(skillDir, { recursive: true });

    // Clean config entry
    const raw = loadRawConfig();
    const skills = raw.skills as Record<string, unknown> | undefined;
    const entries = skills?.entries as Record<string, unknown> | undefined;
    if (entries?.[msg.name]) {
      delete entries[msg.name];

      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig(raw);
      } catch (err) {
        ctx.setSuppressConfigReload(false);
        throw err;
      }
      invalidateConfigCache();

      const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
      if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
      const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, 300);
      ctx.debounceTimers.set('__suppress_reset__', resetTimer);

      ctx.updateConfigFingerprint();
    }

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: msg.name,
      state: 'uninstalled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to uninstall skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
      success: false,
      error: message,
    });
  }
}

async function handleSkillsUpdate(
  msg: SkillsUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubUpdate(msg.name);
    if (!result.success) {
      ctx.send(socket, {
        type: 'skills_operation_response',
        operation: 'update',
        success: false,
        error: result.error ?? 'Unknown error',
      });
      return;
    }

    // Reload skill catalog to pick up updated skill
    loadSkillCatalog();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'update',
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to update skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'update',
      success: false,
      error: message,
    });
  }
}

async function handleSkillsCheckUpdates(
  _msg: SkillsCheckUpdatesRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const updates = await clawhubCheckUpdates();
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'check_updates',
      success: true,
      data: updates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to check for skill updates');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'check_updates',
      success: false,
      error: message,
    });
  }
}

async function handleSkillsSearch(
  msg: SkillsSearchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubSearch(msg.query);
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'search',
      success: true,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to search skills');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'search',
      success: false,
      error: message,
    });
  }
}

async function handleSkillsInspect(
  msg: SkillsInspectRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubInspect(msg.slug);
    ctx.send(socket, {
      type: 'skills_inspect_response',
      slug: msg.slug,
      ...(result.data ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to inspect skill');
    ctx.send(socket, {
      type: 'skills_inspect_response',
      slug: msg.slug,
      error: message,
    });
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
    // Slash candidates always route to text_qa — bypass classifier
    const slashCandidate = parseSlashCandidate(msg.task);
    const interactionType = slashCandidate.kind === 'candidate'
      ? 'text_qa' as const
      : await classifyInteraction(msg.task, msg.source);
    rlog.info({ interactionType, slashBypass: slashCandidate.kind === 'candidate', task: msg.task }, 'Task classified');

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
        rlog.error({ err }, 'Error processing task_submit text QA');
        const classified = classifySessionError(err, { phase: 'agent_loop' });
        ctx.send(socket, buildSessionErrorMessage(conversation.id, classified));
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, 'Error handling task_submit');
    ctx.send(socket, { type: 'error', message: `Failed to route task: ${message}` });
  }
}

// ─── Trust rule handler ─────────────────────────────────────────────────────

function handleAddTrustRule(
  msg: AddTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    addRule(msg.toolName, msg.pattern, msg.scope, msg.decision);
    log.info({ tool: msg.toolName, pattern: msg.pattern, scope: msg.scope, decision: msg.decision }, 'Trust rule added via client');
  } catch (err) {
    log.error({ err }, 'Failed to add trust rule');
  }
}

function handleTrustRulesList(socket: net.Socket, ctx: HandlerContext): void {
  const rules = getAllRules();
  ctx.send(socket, { type: 'trust_rules_list_response', rules });
}

function handleRemoveTrustRule(
  msg: RemoveTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    const removed = removeRule(msg.id);
    if (!removed) {
      log.warn({ id: msg.id }, 'Trust rule not found for removal');
    } else {
      log.info({ id: msg.id }, 'Trust rule removed via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to remove trust rule');
  }
}

function handleUpdateTrustRule(
  msg: UpdateTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    updateRule(msg.id, {
      tool: msg.tool,
      pattern: msg.pattern,
      scope: msg.scope,
      decision: msg.decision,
      priority: msg.priority,
    });
    log.info({ id: msg.id }, 'Trust rule updated via client');
  } catch (err) {
    log.error({ err }, 'Failed to update trust rule');
  }
}

// ─── Suggestion handler ─────────────────────────────────────────────────────

const SUGGESTION_CACHE_MAX = 100;
const suggestionCache = new Map<string, string>();
const suggestionInFlight = new Map<string, Promise<string | null>>();

async function handleSuggestionRequest(
  msg: SuggestionRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const noSuggestion = () => {
    ctx.send(socket, {
      type: 'suggestion_response',
      requestId: msg.requestId,
      suggestion: null,
      source: 'none' as const,
    });
  };

  const rawMessages = conversationStore.getMessages(msg.sessionId);
  if (rawMessages.length === 0) { noSuggestion(); return; }

  // Find the most recent assistant message — only use it if it has text content.
  // Do NOT fall back to older turns; if the latest assistant message is tool-only,
  // return no suggestion rather than reusing stale text from a previous turn.
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (m.role !== 'assistant') continue;

    let content: unknown;
    try { content = JSON.parse(m.content); } catch { content = m.content; }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) { noSuggestion(); return; }

    // Return cached suggestion
    const cached = suggestionCache.get(m.id);
    if (cached !== undefined) {
      ctx.send(socket, {
        type: 'suggestion_response',
        requestId: msg.requestId,
        suggestion: cached,
        source: 'llm' as const,
      });
      return;
    }

    // Try LLM suggestion if an Anthropic API key is configured
    const apiKey = getConfig().apiKeys.anthropic;
    if (apiKey) {
      try {
        let promise = suggestionInFlight.get(m.id);
        if (!promise) {
          promise = generateSuggestion(apiKey, text);
          suggestionInFlight.set(m.id, promise);
        }
        const llmSuggestion = await promise;
        suggestionInFlight.delete(m.id);

        if (llmSuggestion) {
          if (suggestionCache.size >= SUGGESTION_CACHE_MAX) {
            const oldest = suggestionCache.keys().next().value!;
            suggestionCache.delete(oldest);
          }
          suggestionCache.set(m.id, llmSuggestion);

          ctx.send(socket, {
            type: 'suggestion_response',
            requestId: msg.requestId,
            suggestion: llmSuggestion,
            source: 'llm' as const,
          });
          return;
        }
      } catch (err) {
        suggestionInFlight.delete(m.id);
        log.warn({ err }, 'LLM suggestion failed');
      }
    }

    noSuggestion();
    return;
  }

  noSuggestion();
}

async function generateSuggestion(apiKey: string, assistantText: string): Promise<string | null> {
  const client = new Anthropic({ apiKey });
  const truncated = assistantText.length > 2000
    ? assistantText.slice(-2000)
    : assistantText;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 30,
    messages: [
      {
        role: 'user',
        content: `Given this assistant message, write a very short tab-complete suggestion (max 50 chars) the user could send next to keep the conversation going. Be casual, curious, or actionable — like a quick reply, not a formal request. Reply with ONLY the suggestion text.\n\nAssistant's message:\n${truncated}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
  if (!raw || raw.length > 50) return null;

  const firstLine = raw.split('\n')[0].trim();
  return firstLine || null;
}

// ─── App open handler ───────────────────────────────────────────────────────

function handleAppOpenRequest(msg: { appId: string }, socket: net.Socket, ctx: HandlerContext): void {
  const appId = msg.appId;
  if (!appId) {
    ctx.send(socket, { type: 'error', message: 'app_open_request requires appId' });
    return;
  }

  const app = getApp(appId);
  if (!app) {
    ctx.send(socket, { type: 'error', message: `App not found: ${appId}` });
    return;
  }

  const surfaceId = `app-open-${uuid()}`;
  ctx.send(socket, {
    type: 'ui_surface_show',
    sessionId: 'app-panel',
    surfaceId,
    surfaceType: 'dynamic_page',
    title: app.name,
    data: { html: app.htmlDefinition, appId: app.id },
    display: 'panel',
  } as UiSurfaceShow);
}

// ─── Apps list handler ──────────────────────────────────────────────────────

function handleAppsList(socket: net.Socket, ctx: HandlerContext): void {
  try {
    const apps = listApps();
    ctx.send(socket, {
      type: 'apps_list_response',
      apps: apps.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to list apps');
    ctx.send(socket, { type: 'error', message: `Failed to list apps: ${message}` });
  }
}

// ─── Shared apps handlers ────────────────────────────────────────────────────

function getSharedAppsDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'vellum-assistant', 'shared-apps');
}

function handleSharedAppsList(socket: net.Socket, ctx: HandlerContext): void {
  try {
    const dir = getSharedAppsDir();
    if (!existsSync(dir)) {
      ctx.send(socket, { type: 'shared_apps_list_response', apps: [] });
      return;
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('-meta.json'));
    const apps: Array<{
      uuid: string;
      name: string;
      description?: string;
      icon?: string;
      entry: string;
      trustTier: string;
      signerDisplayName?: string;
      bundleSizeBytes: number;
      installedAt: string;
    }> = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const meta = JSON.parse(raw);
        apps.push({
          uuid: meta.uuid,
          name: meta.name,
          description: meta.description,
          icon: meta.icon,
          entry: meta.entry,
          trustTier: meta.trustTier,
          signerDisplayName: meta.signerDisplayName,
          bundleSizeBytes: meta.bundleSizeBytes ?? 0,
          installedAt: meta.installedAt,
        });
      } catch {
        log.warn({ file }, 'Failed to read shared app metadata file');
      }
    }

    ctx.send(socket, { type: 'shared_apps_list_response', apps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to list shared apps');
    ctx.send(socket, { type: 'error', message: `Failed to list shared apps: ${message}` });
  }
}

function handleSharedAppDelete(
  msg: SharedAppDeleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const uuid = msg.uuid;
    // Validate UUID to prevent path traversal
    if (uuid.includes('/') || uuid.includes('\\') || uuid.includes('..')) {
      ctx.send(socket, { type: 'shared_app_delete_response', success: false });
      return;
    }

    const dir = getSharedAppsDir();
    const appDir = join(dir, uuid);
    const metaFile = join(dir, `${uuid}-meta.json`);

    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true });
    }
    if (existsSync(metaFile)) {
      rmSync(metaFile);
    }

    ctx.send(socket, { type: 'shared_app_delete_response', success: true });
  } catch (err) {
    log.error({ err }, 'Failed to delete shared app');
    ctx.send(socket, { type: 'shared_app_delete_response', success: false });
  }
}

// ─── Bundle app handler ─────────────────────────────────────────────────────

async function handleBundleApp(
  msg: BundleAppRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await packageApp(msg.appId);
    ctx.send(socket, {
      type: 'bundle_app_response',
      bundlePath: result.bundlePath,
      manifest: result.manifest,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, 'Failed to bundle app');
    ctx.send(socket, { type: 'error', message: `Failed to bundle app: ${message}` });
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
