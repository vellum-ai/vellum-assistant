import { v4 as uuid } from "uuid";

import {
  type InterfaceId,
  parseChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
  resolveCanonicalGuardianRequest,
} from "../../memory/canonical-guardian-store.js";
import {
  batchSetDisplayOrders,
  clearAll,
  createConversation,
  getConversation,
  updateConversationTitle,
} from "../../memory/conversation-crud.js";
import {
  GENERATING_TITLE,
  queueGenerateConversationTitle,
  UNTITLED_FALLBACK,
} from "../../memory/conversation-title-service.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { getSubagentManager } from "../../subagent/index.js";
import { truncate } from "../../util/truncate.js";
import { HostBashProxy } from "../host-bash-proxy.js";
import { HostCuProxy } from "../host-cu-proxy.js";
import { HostFileProxy } from "../host-file-proxy.js";
import type {
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
} from "../message-protocol.js";
import { normalizeThreadType } from "../message-protocol.js";
import type { Session } from "../session.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
} from "../session-error.js";
import {
  type HandlerContext,
  log,
  pendingStandaloneSecrets,
} from "./shared.js";

export function syncCanonicalStatusFromConfirmationDecision(
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
      "Failed to resolve canonical request from local confirmation response",
    );
  }
}

export function makeEventSender(params: {
  ctx: HandlerContext;
  session: Session;
  conversationId: string;
  sourceChannel: string;
}): (event: ServerMessage) => void {
  const { ctx, session, conversationId, sourceChannel } = params;

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
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      } catch (err) {
        log.debug(
          { err, requestId: event.requestId, conversationId },
          "Failed to create canonical request from local confirmation event",
        );
      }
    } else if (event.type === "secret_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "secret",
      });
    } else if (event.type === "host_bash_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "host_bash",
      });
    } else if (event.type === "host_file_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "host_file",
      });
    } else if (event.type === "host_cu_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "host_cu",
      });
    }

    ctx.send(event);
  };
}

export function handleConfirmationResponse(
  msg: ConfirmationResponse,
  ctx: HandlerContext,
): void {
  // Route by requestId to the session that originated the prompt, not by
  // the current session binding which may have changed since the
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
      syncCanonicalStatusFromConfirmationDecision(msg.requestId, msg.decision);
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
  // the current session binding which may have changed since the
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

/**
 * Clear all sessions and DB conversations. Returns the number of sessions cleared.
 */
export function clearAllSessions(ctx: HandlerContext): number {
  const cleared = ctx.clearAllSessions();
  // Also clear DB conversations. When a new local connection triggers
  // sendInitialSession, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  clearAll();
  return cleared;
}

export async function handleSessionCreate(
  msg: SessionCreateRequest,
  ctx: HandlerContext,
): Promise<void> {
  const threadType = normalizeThreadType(msg.threadType);
  const title =
    msg.title ?? (msg.initialMessage ? GENERATING_TITLE : "New Conversation");
  const conversation = createConversation({
    title,
    threadType,
  });
  const session = await ctx.getOrCreateSession(conversation.id, {
    systemPromptOverride: msg.systemPromptOverride,
    maxResponseTokens: msg.maxResponseTokens,
    transport: msg.transport,
  });

  // Pre-activate skills before sending session_info so they're available
  // for the initial message processing.
  if (msg.preactivatedSkillIds?.length) {
    session.setPreactivatedSkillIds(msg.preactivatedSkillIds);
  }

  ctx.send({
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
        context: { origin: "local" },
        userMessage: msg.initialMessage,
        onTitleUpdated: (newTitle) => {
          ctx.send({
            type: "session_title_updated",
            sessionId: conversation.id,
            title: newTitle,
          });
        },
      });
    }

    const requestId = uuid();
    const transportChannel =
      parseChannelId(msg.transport?.channelId) ?? "vellum";
    const sendEvent = makeEventSender({
      ctx,
      session,
      conversationId: conversation.id,
      sourceChannel: transportChannel,
    });
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
    // Only create the host bash proxy for desktop client interfaces that can
    // execute commands on the user's machine. Set before updateClient so
    // updateClient's call to hostBashProxy.updateSender targets the new proxy.
    if (transportInterface === "macos" || transportInterface === "ios") {
      const proxy = new HostBashProxy(sendEvent, (requestId) => {
        pendingInteractions.resolve(requestId);
      });
      session.setHostBashProxy(proxy);
      const fileProxy = new HostFileProxy(sendEvent, (requestId) => {
        pendingInteractions.resolve(requestId);
      });
      session.setHostFileProxy(fileProxy);
      const cuProxy = new HostCuProxy(sendEvent, (requestId) => {
        pendingInteractions.resolve(requestId);
      });
      session.setHostCuProxy(cuProxy);
      session.addPreactivatedSkillId("computer-use");
    }
    session.updateClient(sendEvent, false);
    session
      .processMessage(msg.initialMessage, [], sendEvent, requestId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, sessionId: conversation.id },
          "Error processing initial message",
        );
        ctx.send({
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
            ctx.send({
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
  // skip rebinding so tool confirmations stay suppressed.
  const existingSession = ctx.sessions.get(sessionId);
  const isHeadlessLocked = existingSession?.headlessLock;

  if (isHeadlessLocked) {
    // Load the session without rebinding the client — the session stays headless
    await ctx.getOrCreateSession(sessionId);
  } else {
    await ctx.getOrCreateSession(sessionId);
  }

  return {
    sessionId: conversation.id,
    title: conversation.title ?? "Untitled",
    threadType: normalizeThreadType(conversation.threadType),
  };
}

export async function handleSessionSwitch(
  msg: SessionSwitchRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await switchSession(msg.sessionId, ctx);
  if (!result) {
    ctx.send({
      type: "error",
      message: `Session ${msg.sessionId} not found`,
    });
    return;
  }

  ctx.send({
    type: "session_info",
    sessionId: result.sessionId,
    title: result.title,
    threadType: result.threadType,
  });
}

/**
 * Rename a session/conversation. Returns true on success, false if not found.
 */
export function renameSession(sessionId: string, name: string): boolean {
  const conversation = getConversation(sessionId);
  if (!conversation) {
    return false;
  }
  updateConversationTitle(sessionId, name, 0);
  return true;
}

export function handleSessionRename(
  msg: SessionRenameRequest,
  ctx: HandlerContext,
): void {
  const success = renameSession(msg.sessionId, msg.title);
  if (!success) {
    ctx.send({
      type: "error",
      message: `Session ${msg.sessionId} not found`,
    });
    return;
  }
  ctx.send({
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

/**
 * Undo the last message in a session. Returns the removed count, or null if
 * the conversation does not exist. Restores evicted sessions from the database.
 */
export async function undoLastMessage(
  sessionId: string,
  ctx: HandlerContext,
): Promise<{ removedCount: number } | null> {
  if (!getConversation(sessionId)) {
    return null;
  }
  const session = await ctx.getOrCreateSession(sessionId);
  ctx.touchSession(sessionId);
  const removedCount = session.undo();
  return { removedCount };
}

export async function handleUndo(
  msg: UndoRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await undoLastMessage(msg.sessionId, ctx);
  if (!result) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  ctx.send({
    type: "undo_complete",
    removedCount: result.removedCount,
    sessionId: msg.sessionId,
  });
}

/**
 * Regenerate the last assistant response for a session. The caller provides
 * a `sendEvent` callback for delivering streaming events via HTTP/SSE.
 * Returns null if the conversation does not exist. Restores evicted sessions
 * from the database when needed. Throws on regeneration errors.
 */
export async function regenerateResponse(
  sessionId: string,
  ctx: HandlerContext,
  sendEvent: (event: ServerMessage) => void,
): Promise<{ requestId: string } | null> {
  if (!getConversation(sessionId)) {
    return null;
  }
  const session = await ctx.getOrCreateSession(sessionId);
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
  ctx: HandlerContext,
): Promise<void> {
  if (!getConversation(msg.sessionId)) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const session = await ctx.getOrCreateSession(msg.sessionId);

  const regenerateChannel =
    parseChannelId(session.getTurnChannelContext()?.assistantMessageChannel) ??
    "vellum";
  const sendEvent = makeEventSender({
    ctx,
    session,
    conversationId: msg.sessionId,
    sourceChannel: regenerateChannel,
  });

  try {
    await regenerateResponse(msg.sessionId, ctx, sendEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send({
      type: "error",
      message: `Failed to regenerate: ${message}`,
    });
    const classified = classifySessionError(err, { phase: "regenerate" });
    ctx.send(buildSessionErrorMessage(msg.sessionId, classified));
  }
}

export function handleUsageRequest(
  msg: UsageRequest,
  ctx: HandlerContext,
): void {
  const conversation = getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const config = getConfig();
  ctx.send({
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
  findSession: (
    id: string,
  ) => { removeQueuedMessage(requestId: string): boolean } | undefined,
):
  | { removed: true }
  | { removed: false; reason: "session_not_found" | "message_not_found" } {
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
  log.warn({ sessionId, requestId }, "Queued message not found for deletion");
  return { removed: false, reason: "message_not_found" };
}

// ---------------------------------------------------------------------------
// HTTP handler (delegates to shared logic)
// ---------------------------------------------------------------------------

export function handleDeleteQueuedMessage(
  msg: DeleteQueuedMessage,
  ctx: HandlerContext,
): void {
  const result = deleteQueuedMessage(msg.sessionId, msg.requestId, (id) =>
    ctx.sessions.get(id),
  );
  if (result.removed) {
    ctx.send({
      type: "message_queued_deleted",
      sessionId: msg.sessionId,
      requestId: msg.requestId,
    });
  }
}

export function handleReorderThreads(
  msg: ReorderThreadsRequest,
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
