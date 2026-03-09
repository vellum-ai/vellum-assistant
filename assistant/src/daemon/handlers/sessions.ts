import * as net from "node:net";

import { v4 as uuid } from "uuid";

import {
  type InterfaceId,
  isChannelId,
  parseChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
  resolveCanonicalGuardianRequest,
} from "../../memory/canonical-guardian-store.js";
import { getAttentionStateByConversationIds } from "../../memory/conversation-attention-store.js";
import {
  batchSetDisplayOrders,
  clearAll,
  createConversation,
  getConversation,
  getDisplayMetaForConversations,
  updateConversationTitle,
} from "../../memory/conversation-crud.js";
import {
  countConversations,
  listConversations,
} from "../../memory/conversation-queries.js";
import {
  GENERATING_TITLE,
  queueGenerateConversationTitle,
  UNTITLED_FALLBACK,
} from "../../memory/conversation-title-service.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { getSubagentManager } from "../../subagent/index.js";
import { truncate } from "../../util/truncate.js";
import type {
  CancelRequest,
  ConfirmationResponse,
  DeleteQueuedMessage,
  RegenerateRequest,
  ReorderThreadsRequest,
  SecretResponse,
  ServerMessage,
  SessionCreateRequest,
  SessionRenameRequest,
  SessionSwitchRequest,
  UndoRequest,
  UsageRequest,
} from "../ipc-protocol.js";
import { normalizeThreadType } from "../ipc-protocol.js";
import type { Session } from "../session.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
} from "../session-error.js";
import {
  handleConversationSearch,
  handleHistoryRequest,
  handleMessageContentRequest,
} from "./session-history.js";
import { handleUserMessage } from "./session-user-message.js";
import {
  defineHandlers,
  type HandlerContext,
  log,
  pendingStandaloneSecrets,
  wireEscalationHandler,
} from "./shared.js";

/**
 * Extract a valid ChannelId from a binding's sourceChannel, which may carry a
 * `notification:` namespace prefix (e.g. `"notification:telegram"` -> `"telegram"`).
 * Returns the ChannelId if valid, or null otherwise.
 */
function parseBindingSourceChannel(
  sourceChannel: string,
): import("../../channels/types.js").ChannelId | null {
  if (isChannelId(sourceChannel)) return sourceChannel;
  const NOTIFICATION_PREFIX = "notification:";
  if (sourceChannel.startsWith(NOTIFICATION_PREFIX)) {
    const inner = sourceChannel.slice(NOTIFICATION_PREFIX.length);
    if (isChannelId(inner)) return inner;
  }
  return null;
}

export function syncCanonicalStatusFromIpcConfirmationDecision(
  requestId: string,
  decision: ConfirmationResponse["decision"],
): void {
  const targetStatus =
    decision === "deny" || decision === "always_deny"
      ? ("denied" as const)
      : ("approved" as const);

  try {
    resolveCanonicalGuardianRequest(requestId, "pending", {
      status: targetStatus,
    });
  } catch (err) {
    log.debug(
      { err, requestId, targetStatus },
      "Failed to resolve canonical request from IPC confirmation response",
    );
  }
}

export function makeIpcEventSender(params: {
  ctx: HandlerContext;
  socket: net.Socket;
  session: Session;
  conversationId: string;
  sourceChannel: string;
}): (event: ServerMessage) => void {
  const { ctx, socket, session, conversationId, sourceChannel } = params;

  return (event: ServerMessage) => {
    if (event.type === "confirmation_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "confirmation",
        confirmationDetails: {
          toolName: event.toolName,
          input: event.input,
          riskLevel: event.riskLevel,
          executionTarget: event.executionTarget,
          allowlistOptions: event.allowlistOptions,
          scopeOptions: event.scopeOptions,
          persistentDecisionsAllowed: event.persistentDecisionsAllowed,
          temporaryOptionsAvailable: event.temporaryOptionsAvailable,
        },
      });

      try {
        const trustContext = session.trustContext;
        createCanonicalGuardianRequest({
          id: event.requestId,
          kind: "tool_approval",
          sourceType: "desktop",
          sourceChannel,
          conversationId,
          guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
          toolName: event.toolName,
          status: "pending",
          requestCode: generateCanonicalRequestCode(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
      } catch (err) {
        log.debug(
          { err, requestId: event.requestId, conversationId },
          "Failed to create canonical request from IPC confirmation event",
        );
      }
    } else if (event.type === "secret_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "secret",
      });
    }

    ctx.send(socket, event);
  };
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
        undefined,
        { source: "button" },
      );
      syncCanonicalStatusFromIpcConfirmationDecision(
        msg.requestId,
        msg.decision,
      );
      pendingInteractions.resolve(msg.requestId);
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
      syncCanonicalStatusFromIpcConfirmationDecision(
        msg.requestId,
        msg.decision,
      );
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }

  log.warn(
    { requestId: msg.requestId },
    "No session found with pending confirmation for requestId",
  );
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
    standalone.resolve({
      value: msg.value ?? null,
      delivery: msg.delivery ?? "store",
    });
    pendingInteractions.resolve(msg.requestId);
    return;
  }

  // Route by requestId to the session that originated the prompt, not by
  // the current socket-session binding which may have changed since the
  // request was issued (e.g. after a session switch).
  for (const [sessionId, session] of ctx.sessions) {
    if (session.hasPendingSecret(msg.requestId)) {
      ctx.touchSession(sessionId);
      session.handleSecretResponse(msg.requestId, msg.value, msg.delivery);
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }
  log.warn(
    { requestId: msg.requestId },
    "No session found with pending secret prompt for requestId",
  );
}

export function handleSessionList(
  socket: net.Socket,
  ctx: HandlerContext,
  offset = 0,
  limit = 50,
): void {
  const conversations = listConversations(limit, false, offset);
  const totalCount = countConversations();
  const conversationIds = conversations.map((c) => c.id);
  const bindings =
    externalConversationStore.getBindingsForConversations(conversationIds);
  const attentionStates = getAttentionStateByConversationIds(conversationIds);
  const displayMetas = getDisplayMetaForConversations(conversationIds);
  ctx.send(socket, {
    type: "session_list_response",
    sessions: conversations.map((c) => {
      const binding = bindings.get(c.id);
      const originChannel = parseChannelId(c.originChannel);
      const originInterface = parseInterfaceId(c.originInterface);
      const attn = attentionStates.get(c.id);
      const displayMeta = displayMetas.get(c.id);
      const assistantAttention = attn
        ? {
            hasUnseenLatestAssistantMessage:
              attn.latestAssistantMessageAt != null &&
              (attn.lastSeenAssistantMessageAt == null ||
                attn.lastSeenAssistantMessageAt <
                  attn.latestAssistantMessageAt),
            ...(attn.latestAssistantMessageAt != null
              ? { latestAssistantMessageAt: attn.latestAssistantMessageAt }
              : {}),
            ...(attn.lastSeenAssistantMessageAt != null
              ? { lastSeenAssistantMessageAt: attn.lastSeenAssistantMessageAt }
              : {}),
            ...(attn.lastSeenConfidence != null
              ? { lastSeenConfidence: attn.lastSeenConfidence }
              : {}),
            ...(attn.lastSeenSignalType != null
              ? { lastSeenSignalType: attn.lastSeenSignalType }
              : {}),
          }
        : undefined;
      return {
        id: c.id,
        title: c.title ?? "Untitled",
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        threadType: normalizeThreadType(c.threadType),
        source: c.source ?? "user",
        ...(binding && parseBindingSourceChannel(binding.sourceChannel)
          ? {
              channelBinding: {
                sourceChannel: parseBindingSourceChannel(
                  binding.sourceChannel,
                )!,
                externalChatId: binding.externalChatId,
                externalUserId: binding.externalUserId,
                displayName: binding.displayName,
                username: binding.username,
              },
            }
          : {}),
        ...(c.scheduleJobId ? { scheduleJobId: c.scheduleJobId } : {}),
        ...(originChannel ? { conversationOriginChannel: originChannel } : {}),
        ...(originInterface
          ? { conversationOriginInterface: originInterface }
          : {}),
        ...(assistantAttention ? { assistantAttention } : {}),
        ...(displayMeta?.displayOrder != null
          ? { displayOrder: displayMeta.displayOrder }
          : {}),
        ...(displayMeta?.isPinned ? { isPinned: displayMeta.isPinned } : {}),
      };
    }),
    hasMore: offset + conversations.length < totalCount,
  });
}

/**
 * Clear all sessions and DB conversations. Returns the number of sessions cleared.
 */
export function clearAllSessions(ctx: HandlerContext): number {
  const cleared = ctx.clearAllSessions();
  // Also clear DB conversations. When a new IPC connection triggers
  // sendInitialSession, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  clearAll();
  return cleared;
}

export function handleSessionsClear(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const cleared = clearAllSessions(ctx);
  ctx.send(socket, { type: "sessions_clear_response", cleared });
}

export async function handleSessionCreate(
  msg: SessionCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const threadType = normalizeThreadType(msg.threadType);
  const title =
    msg.title ?? (msg.initialMessage ? GENERATING_TITLE : "New Conversation");
  const conversation = createConversation({
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
    type: "session_info",
    sessionId: conversation.id,
    title: conversation.title ?? "New Conversation",
    ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
    threadType: normalizeThreadType(conversation.threadType),
  });

  // Auto-send the initial message if provided, kick-starting the skill.
  if (msg.initialMessage) {
    // Queue title generation eagerly — some processMessage paths (guardian
    // replies, unknown slash commands) bypass the agent loop entirely, so
    // we can't rely on the agent loop's early title generation alone.
    // The agent loop also queues title generation, but isReplaceableTitle
    // prevents double-writes since the first to complete sets a real title.
    if (title === GENERATING_TITLE) {
      queueGenerateConversationTitle({
        conversationId: conversation.id,
        context: { origin: "ipc" },
        userMessage: msg.initialMessage,
        onTitleUpdated: (newTitle) => {
          ctx.send(socket, {
            type: "session_title_updated",
            sessionId: conversation.id,
            title: newTitle,
          });
        },
      });
    }

    ctx.socketToSession.set(socket, conversation.id);
    const requestId = uuid();
    const transportChannel =
      parseChannelId(msg.transport?.channelId) ?? "vellum";
    const sendEvent = makeIpcEventSender({
      ctx,
      socket,
      session,
      conversationId: conversation.id,
      sourceChannel: transportChannel,
    });
    session.updateClient(sendEvent, false);
    session.setTurnChannelContext({
      userMessageChannel: transportChannel,
      assistantMessageChannel: transportChannel,
    });
    const transportInterface: InterfaceId =
      parseInterfaceId(msg.transport?.interfaceId) ?? "vellum";
    session.setTurnInterfaceContext({
      userMessageInterface: transportInterface,
      assistantMessageInterface: transportInterface,
    });
    session
      .processMessage(msg.initialMessage, [], sendEvent, requestId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, sessionId: conversation.id },
          "Error processing initial message",
        );
        ctx.send(socket, {
          type: "error",
          message: `Failed to process initial message: ${message}`,
        });

        // Replace stuck loading placeholder with a stable fallback title
        // if title generation hasn't already completed or been renamed.
        try {
          const current = getConversation(conversation.id);
          if (current && current.title === GENERATING_TITLE) {
            const fallback = UNTITLED_FALLBACK;
            updateConversationTitle(conversation.id, fallback);
            ctx.send(socket, {
              type: "session_title_updated",
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

/**
 * Switch to an existing session/conversation. Returns session info on success,
 * or throws/returns an error result when the conversation is not found.
 */
export async function switchSession(
  sessionId: string,
  ctx: HandlerContext,
  socket?: net.Socket,
): Promise<{
  sessionId: string;
  title: string;
  threadType: ReturnType<typeof normalizeThreadType>;
} | null> {
  const conversation = getConversation(sessionId);
  if (!conversation) {
    return null;
  }

  // If the target session is headless-locked (actively executing a task run),
  // skip rebinding the socket so tool confirmations stay suppressed.
  const existingSession = ctx.sessions.get(sessionId);
  const isHeadlessLocked = existingSession?.headlessLock;

  if (socket) {
    ctx.socketToSession.set(socket, sessionId);

    if (isHeadlessLocked) {
      // Load the session without rebinding the client — the session stays headless
      await ctx.getOrCreateSession(sessionId, socket, false);
    } else {
      const session = await ctx.getOrCreateSession(sessionId, socket, true);
      // Only wire the escalation handler if one isn't already set — handleTaskSubmit
      // sets a handler with the client's actual screen dimensions, and overwriting it
      // here would replace those dimensions with the daemon's defaults.
      if (!session.hasEscalationHandler()) {
        wireEscalationHandler(session, socket, ctx);
      }
    }
  } else {
    // Socketless callers (HTTP) still need the session hydrated in memory so
    // follow-up operations (undo, regenerate, cancel) find an active session.
    if (!existingSession) {
      await ctx.getOrCreateSession(sessionId);
    }
  }

  return {
    sessionId: conversation.id,
    title: conversation.title ?? "Untitled",
    threadType: normalizeThreadType(conversation.threadType),
  };
}

export async function handleSessionSwitch(
  msg: SessionSwitchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const result = await switchSession(msg.sessionId, ctx, socket);
  if (!result) {
    ctx.send(socket, {
      type: "error",
      message: `Session ${msg.sessionId} not found`,
    });
    return;
  }

  ctx.send(socket, {
    type: "session_info",
    sessionId: result.sessionId,
    title: result.title,
    threadType: result.threadType,
  });
}

/**
 * Rename a session/conversation. Returns true on success, false if not found.
 */
export function renameSession(
  sessionId: string,
  name: string,
): boolean {
  const conversation = getConversation(sessionId);
  if (!conversation) {
    return false;
  }
  updateConversationTitle(sessionId, name, 0);
  return true;
}

export function handleSessionRename(
  msg: SessionRenameRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const success = renameSession(msg.sessionId, msg.title);
  if (!success) {
    ctx.send(socket, {
      type: "error",
      message: `Session ${msg.sessionId} not found`,
    });
    return;
  }
  ctx.send(socket, {
    type: "session_title_updated",
    sessionId: msg.sessionId,
    title: msg.title,
  });
}

/**
 * Cancel generation for a session. Returns true if a session was found and cancelled.
 */
export function cancelGeneration(
  sessionId: string,
  ctx: HandlerContext,
): boolean {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    return false;
  }
  ctx.touchSession(sessionId);
  session.abort();
  // Also abort any child subagents spawned by this session.
  // Omit sendToClient to suppress parent notifications — the parent is
  // being cancelled, so enqueuing synthetic messages would trigger
  // unwanted model activity after the user pressed stop.
  getSubagentManager().abortAllForParent(sessionId);
  return true;
}

export function handleCancel(
  msg: CancelRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const sessionId = msg.sessionId || ctx.socketToSession.get(socket);
  if (sessionId) {
    cancelGeneration(sessionId, ctx);
  }
}

/**
 * Undo the last message in a session. Returns the removed count, or null if session not found.
 */
export function undoLastMessage(
  sessionId: string,
  ctx: HandlerContext,
): { removedCount: number } | null {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    return null;
  }
  ctx.touchSession(sessionId);
  const removedCount = session.undo();
  return { removedCount };
}

export function handleUndo(
  msg: UndoRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const result = undoLastMessage(msg.sessionId, ctx);
  if (!result) {
    ctx.send(socket, { type: "error", message: "No active session" });
    return;
  }
  ctx.send(socket, {
    type: "undo_complete",
    removedCount: result.removedCount,
    sessionId: msg.sessionId,
  });
}

/**
 * Regenerate the last assistant response for a session. The caller provides
 * a `sendEvent` callback for delivering streaming events (IPC or HTTP/SSE).
 * Returns null if the session is not found. Throws on regeneration errors.
 */
export async function regenerateResponse(
  sessionId: string,
  ctx: HandlerContext,
  sendEvent: (event: ServerMessage) => void,
): Promise<{ requestId: string } | null> {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    return null;
  }
  ctx.touchSession(sessionId);
  session.updateClient(sendEvent, false);
  const requestId = uuid();
  session.traceEmitter.emit("request_received", "Regenerate requested", {
    requestId,
    status: "info",
    attributes: { source: "regenerate" },
  });
  try {
    await session.regenerate(sendEvent, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, sessionId }, "Error regenerating message");
    session.traceEmitter.emit("request_error", truncate(message, 200, ""), {
      requestId,
      status: "error",
      attributes: {
        errorClass: err instanceof Error ? err.constructor.name : "Error",
        message: truncate(message, 500, ""),
      },
    });
    throw err;
  }
  return { requestId };
}

export async function handleRegenerate(
  msg: RegenerateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: "error", message: "No active session" });
    return;
  }

  const regenerateChannel =
    parseChannelId(session.getTurnChannelContext()?.assistantMessageChannel) ??
    "vellum";
  const sendEvent = makeIpcEventSender({
    ctx,
    socket,
    session,
    conversationId: msg.sessionId,
    sourceChannel: regenerateChannel,
  });

  try {
    await regenerateResponse(msg.sessionId, ctx, sendEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send(socket, {
      type: "error",
      message: `Failed to regenerate: ${message}`,
    });
    const classified = classifySessionError(err, { phase: "regenerate" });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
  }
}

export function handleUsageRequest(
  msg: UsageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const conversation = getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, { type: "error", message: "No active session" });
    return;
  }
  const config = getConfig();
  ctx.send(socket, {
    type: "usage_response",
    totalInputTokens: conversation.totalInputTokens,
    totalOutputTokens: conversation.totalOutputTokens,
    estimatedCost: conversation.totalEstimatedCost,
    model: config.model,
  });
}

// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

/**
 * Delete a queued message from a session.
 * Returns `{ removed: true }` on success, `{ removed: false, reason }` on failure.
 */
export function deleteQueuedMessage(
  sessionId: string,
  requestId: string,
  findSession: (id: string) => { removeQueuedMessage(requestId: string): boolean } | undefined,
): { removed: true } | { removed: false; reason: "session_not_found" | "message_not_found" } {
  const session = findSession(sessionId);
  if (!session) {
    log.warn(
      { sessionId, requestId },
      "No session found for delete_queued_message",
    );
    return { removed: false, reason: "session_not_found" };
  }
  const removed = session.removeQueuedMessage(requestId);
  if (removed) {
    return { removed: true };
  }
  log.warn(
    { sessionId, requestId },
    "Queued message not found for deletion",
  );
  return { removed: false, reason: "message_not_found" };
}

// ---------------------------------------------------------------------------
// IPC handler (delegates to shared logic)
// ---------------------------------------------------------------------------

export function handleDeleteQueuedMessage(
  msg: DeleteQueuedMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const result = deleteQueuedMessage(
    msg.sessionId,
    msg.requestId,
    (id) => ctx.sessions.get(id),
  );
  if (result.removed) {
    ctx.send(socket, {
      type: "message_queued_deleted",
      sessionId: msg.sessionId,
      requestId: msg.requestId,
    });
  }
}

export function handleReorderThreads(
  msg: ReorderThreadsRequest,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  if (!Array.isArray(msg.updates)) {
    return;
  }
  batchSetDisplayOrders(
    msg.updates.map((u) => ({
      id: u.sessionId,
      displayOrder: u.displayOrder ?? null,
      isPinned: u.isPinned ?? false,
    })),
  );
}

export const sessionHandlers = defineHandlers({
  user_message: handleUserMessage,
  confirmation_response: handleConfirmationResponse,
  secret_response: handleSecretResponse,
  session_list: (msg, socket, ctx) =>
    handleSessionList(socket, ctx, msg.offset ?? 0, msg.limit ?? 50),
  session_create: handleSessionCreate,
  sessions_clear: (_msg, socket, ctx) => handleSessionsClear(socket, ctx),
  session_switch: handleSessionSwitch,
  session_rename: handleSessionRename,
  cancel: handleCancel,
  delete_queued_message: handleDeleteQueuedMessage,
  history_request: handleHistoryRequest,
  message_content_request: handleMessageContentRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
  usage_request: handleUsageRequest,
  conversation_search: handleConversationSearch,
  reorder_threads: handleReorderThreads,
});
