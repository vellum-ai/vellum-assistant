import * as net from 'node:net';
import { getConfig, loadRawConfig, saveRawConfig } from '../config/loader.js';
import { initializeProviders } from '../providers/registry.js';
import * as conversationStore from '../memory/conversation-store.js';
import { getLogger } from '../util/logger.js';
import { Session } from './session.js';
import type { ClientMessage, ServerMessage, UserMessageAttachment } from './ipc-protocol.js';

const log = getLogger('handlers');
const HISTORY_ATTACHMENT_TEXT_LIMIT = 500;

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

export function renderHistoryContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return String(content ?? '');
  }

  const textParts: string[] = [];
  const attachmentParts: string[] = [];

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
  }

  const text = textParts.join('');
  if (attachmentParts.length === 0) return text;
  if (text.trim().length === 0) return attachmentParts.join('\n');
  return `${text}\n${attachmentParts.join('\n')}`;
}

/**
 * Shared context that handlers need from the DaemonServer.
 * Keeps handlers decoupled from the server class itself.
 */
export interface HandlerContext {
  sessions: Map<string, Session>;
  socketToSession: Map<net.Socket, string>;
  socketSandboxOverride: Map<net.Socket, boolean>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  suppressConfigReload: boolean;
  setSuppressConfigReload(value: boolean): void;
  send(socket: net.Socket, msg: ServerMessage): void;
  getOrCreateSession(
    conversationId: string,
    socket?: net.Socket,
    rebindClient?: boolean,
  ): Promise<Session>;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export function handleMessage(
  msg: ClientMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  switch (msg.type) {
    case 'user_message':
      handleUserMessage(msg.sessionId, msg.content, msg.attachments, socket, ctx);
      break;
    case 'confirmation_response':
      handleConfirmationResponse(msg, socket, ctx);
      break;
    case 'session_list':
      handleSessionList(socket, ctx);
      break;
    case 'session_create':
      handleSessionCreate(msg.title, socket, ctx);
      break;
    case 'session_switch':
      handleSessionSwitch(msg.sessionId, socket, ctx);
      break;
    case 'cancel':
      handleCancel(socket, ctx);
      break;
    case 'model_get':
      handleModelGet(socket, ctx);
      break;
    case 'model_set':
      handleModelSet(msg.model, socket, ctx);
      break;
    case 'history_request':
      handleHistoryRequest(msg.sessionId, socket, ctx);
      break;
    case 'undo':
      handleUndo(msg.sessionId, socket, ctx);
      break;
    case 'usage_request':
      handleUsageRequest(msg.sessionId, socket, ctx);
      break;
    case 'sandbox_set':
      handleSandboxSet(msg.enabled, socket, ctx);
      break;
    case 'ping':
      ctx.send(socket, { type: 'pong' });
      break;
  }
}

// ─── Individual handlers ─────────────────────────────────────────────────────

async function handleUserMessage(
  sessionId: string,
  content: string | undefined,
  attachments: UserMessageAttachment[] | undefined,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    ctx.socketToSession.set(socket, sessionId);
    const session = await ctx.getOrCreateSession(sessionId, socket, true);
    await session.processMessage(content ?? '', attachments ?? [], (event) => {
      ctx.send(socket, event);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, sessionId }, 'Error processing user message');
    ctx.send(socket, { type: 'error', message });
  }
}

function handleConfirmationResponse(
  msg: ClientMessage & { type: 'confirmation_response' },
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
  title: string | undefined,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.createConversation(
    title ?? 'New Conversation',
  );
  await ctx.getOrCreateSession(conversation.id, socket, true);
  ctx.send(socket, {
    type: 'session_info',
    sessionId: conversation.id,
    title: conversation.title ?? 'New Conversation',
  });
}

async function handleSessionSwitch(
  sessionId: string,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.getConversation(sessionId);
  if (!conversation) {
    ctx.send(socket, { type: 'error', message: `Session ${sessionId} not found` });
    return;
  }
  ctx.socketToSession.set(socket, sessionId);
  await ctx.getOrCreateSession(sessionId, socket, true);
  ctx.send(socket, {
    type: 'session_info',
    sessionId: conversation.id,
    title: conversation.title ?? 'Untitled',
  });
}

function handleCancel(socket: net.Socket, ctx: HandlerContext): void {
  const sessionId = ctx.socketToSession.get(socket);
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
  model: string,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    // Use raw config to avoid persisting env-var API keys to disk
    const raw = loadRawConfig();
    raw.model = model;

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
  enabled: boolean,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Per-socket override: store the sandbox preference for this client only.
  // The override is applied to the session so it doesn't affect other clients.
  ctx.socketSandboxOverride.set(socket, enabled);
  const sessionId = ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      session.setSandboxOverride(enabled);
    }
  }
  log.info({ enabled }, 'Sandbox override applied (per-session)');
}

function handleHistoryRequest(
  sessionId: string,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const dbMessages = conversationStore.getMessages(sessionId);
  const historyMessages = dbMessages.map((m) => {
    let text = '';
    try {
      const content = JSON.parse(m.content);
      text = renderHistoryContent(content);
    } catch (err) {
      log.debug({ err, messageId: m.id }, 'Failed to parse message content as JSON, using raw text');
      text = m.content;
    }
    return { role: m.role, text, timestamp: m.createdAt };
  });
  ctx.send(socket, { type: 'history_response', messages: historyMessages });
}

function handleUndo(
  sessionId: string,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    ctx.send(socket, { type: 'error', message: 'No active session' });
    return;
  }
  const removedCount = session.undo();
  ctx.send(socket, { type: 'undo_complete', removedCount });
}

function handleUsageRequest(
  sessionId: string,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const conversation = conversationStore.getConversation(sessionId);
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
