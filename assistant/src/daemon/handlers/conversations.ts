import { v4 as uuid } from "uuid";

import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
} from "../../memory/canonical-guardian-store.js";
import {
  clearAll,
  getConversation,
  updateConversationTitle,
} from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getSubagentManager } from "../../subagent/index.js";
import { summarizeToolInput } from "../../tools/tool-input-summary.js";
import { createAbortReason } from "../../util/abort-reasons.js";
import { truncate } from "../../util/truncate.js";
import type { Conversation } from "../conversation.js";
import {
  conversationEntries,
  findConversation,
} from "../conversation-store.js";
import type {
  ConfirmationResponse,
  SecretResponse,
  ServerMessage,
} from "../message-protocol.js";
import { normalizeConversationType } from "../message-protocol.js";
import {
  type HandlerContext,
  log,
  pendingStandaloneSecrets,
} from "./shared.js";

export function makeEventSender(params: {
  ctx: HandlerContext;
  conversation: Conversation;
  conversationId: string;
  sourceChannel: string;
}): (event: ServerMessage) => void {
  const { ctx, conversation, conversationId, sourceChannel } = params;

  return (event: ServerMessage) => {
    if (event.type === "confirmation_request") {
      // ACP permission requests are handled by client-handler.ts — skip
      // the normal registration and guardian request creation for them.
      // The ACP handler registers its own entry with directResolve after
      // this callback returns.
      const isAcpPermission = "acpToolKind" in event && !!event.acpToolKind;

      if (!isAcpPermission) {
        pendingInteractions.register(event.requestId, {
          conversation,
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
          },
        });

        try {
          const trustContext = conversation.trustContext;
          const inputRecord = event.input as Record<string, unknown>;
          const activityRaw =
            (typeof inputRecord.activity === "string"
              ? inputRecord.activity
              : undefined) ??
            (typeof inputRecord.reason === "string"
              ? inputRecord.reason
              : undefined);
          createCanonicalGuardianRequest({
            id: event.requestId,
            kind: "tool_approval",
            sourceType: "desktop",
            sourceChannel,
            conversationId,
            guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
            toolName: event.toolName,
            commandPreview:
              redactSecrets(summarizeToolInput(event.toolName, inputRecord)) ||
              undefined,
            riskLevel: event.riskLevel,
            activityText: activityRaw ? redactSecrets(activityRaw) : undefined,
            executionTarget: event.executionTarget,
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
      }
    } else if (event.type === "secret_request") {
      pendingInteractions.register(event.requestId, {
        conversation,
        conversationId,
        kind: "secret",
      });
    } else if (event.type === "host_bash_request") {
      pendingInteractions.register(event.requestId, {
        conversation,
        conversationId,
        kind: "host_bash",
      });
    } else if (event.type === "host_browser_request") {
      pendingInteractions.register(event.requestId, {
        conversation,
        conversationId,
        kind: "host_browser",
      });
    } else if (event.type === "host_file_request") {
      pendingInteractions.register(event.requestId, {
        conversation,
        conversationId,
        kind: "host_file",
      });
    } else if (event.type === "host_cu_request") {
      pendingInteractions.register(event.requestId, {
        conversation,
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
  // Route by requestId to the conversation that originated the prompt, not by
  // the current conversation binding which may have changed since the
  // request was issued (e.g. after a conversation switch).
  const decision = msg.decision;

  for (const [conversationId, conversation] of conversationEntries()) {
    if (conversation.hasPendingConfirmation(msg.requestId)) {
      ctx.touchConversation(conversationId);
      conversation.handleConfirmationResponse(
        msg.requestId,
        decision,
        msg.selectedPattern,
        msg.selectedScope,
        undefined,
        { source: "button" },
      );
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }

  log.warn(
    { requestId: msg.requestId },
    "No conversation found with pending confirmation for requestId",
  );
}

export function handleSecretResponse(
  msg: SecretResponse,
  ctx: HandlerContext,
): void {
  // Check standalone (non-conversation) prompts first, since they use a dedicated
  // requestId that won't collide with conversation prompts.
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

  // Route by requestId to the conversation that originated the prompt, not by
  // the current conversation binding which may have changed since the
  // request was issued (e.g. after a conversation switch).
  for (const [conversationId, conversation] of conversationEntries()) {
    if (conversation.hasPendingSecret(msg.requestId)) {
      ctx.touchConversation(conversationId);
      conversation.handleSecretResponse(msg.requestId, msg.value, msg.delivery);
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }
  log.warn(
    { requestId: msg.requestId },
    "No conversation found with pending secret prompt for requestId",
  );
}

/**
 * Clear all conversations and DB conversations. Returns the number of conversations cleared.
 */
export function clearAllConversations(ctx: HandlerContext): number {
  const cleared = ctx.clearAllConversations();
  // Also clear DB conversations. When a new local connection triggers
  // sendInitialConversation, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  clearAll();
  return cleared;
}

/**
 * Switch to an existing conversation. Returns conversation info on success,
 * or throws/returns an error result when the conversation is not found.
 */
export async function switchConversation(
  conversationId: string,
  ctx: HandlerContext,
): Promise<{
  conversationId: string;
  title: string;
  conversationType: ReturnType<typeof normalizeConversationType>;
  inferenceProfile?: string;
} | null> {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return null;
  }

  // If the target conversation is headless-locked (actively executing a task run),
  // skip rebinding so tool confirmations stay suppressed.
  const existingConversation = findConversation(conversationId);
  const isHeadlessLocked = existingConversation?.headlessLock;

  if (isHeadlessLocked) {
    // Load the conversation without rebinding the client — the conversation stays headless
    await ctx.getOrCreateConversation(conversationId);
  } else {
    await ctx.getOrCreateConversation(conversationId);
  }

  return {
    conversationId: conversation.id,
    title: conversation.title ?? "Untitled",
    conversationType: normalizeConversationType(conversation.conversationType),
    inferenceProfile: conversation.inferenceProfile ?? undefined,
  };
}
/**
 * Rename a conversation. Returns true on success, false if not found.
 */
export function renameConversation(
  conversationId: string,
  name: string,
): boolean {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return false;
  }
  updateConversationTitle(conversationId, name, 0);
  return true;
}

/**
 * Cancel generation for a conversation. Returns true if a conversation was found and cancelled.
 */
export function cancelGeneration(
  conversationId: string,
  ctx: HandlerContext,
): boolean {
  const conversation = findConversation(conversationId);
  if (!conversation) {
    return false;
  }
  ctx.touchConversation(conversationId);
  conversation.abort(
    createAbortReason("user_cancel", "cancelGeneration", conversationId),
  );
  // Also abort any child subagents spawned by this conversation.
  // Omit sendToClient to suppress parent notifications — the parent is
  // being cancelled, so enqueuing synthetic messages would trigger
  // unwanted model activity after the user pressed stop.
  getSubagentManager().abortAllForParent(conversationId);
  return true;
}

/**
 * Undo the last message in a conversation. Returns the removed count, or null if
 * the conversation does not exist. Restores evicted conversations from the database.
 */
export async function undoLastMessage(
  conversationId: string,
  ctx: HandlerContext,
): Promise<{ removedCount: number } | null> {
  const resolvedId = resolveConversationId(conversationId);
  if (!resolvedId) {
    return null;
  }
  conversationId = resolvedId;
  const conversation = await ctx.getOrCreateConversation(conversationId);
  ctx.touchConversation(conversationId);
  const removedCount = conversation.undo();
  return { removedCount };
}
/**
 * Regenerate the last assistant response for a conversation. The caller provides
 * a `sendEvent` callback for delivering streaming events via HTTP/SSE.
 * Returns null if the conversation does not exist. Restores evicted conversations
 * from the database when needed. Throws on regeneration errors.
 */
export async function regenerateResponse(
  conversationId: string,
  ctx: HandlerContext,
  sendEvent: (event: ServerMessage) => void,
): Promise<{ requestId: string } | null> {
  // The caller may pass a conversation key (e.g. the macOS client's local
  // conversation ID) instead of the daemon's internal conversation ID. Resolve
  // to the internal ID so all downstream lookups succeed.
  const resolvedId = resolveConversationId(conversationId);
  if (!resolvedId) {
    return null;
  }
  conversationId = resolvedId;
  const conversation = await ctx.getOrCreateConversation(conversationId);
  ctx.touchConversation(conversationId);
  conversation.updateClient(sendEvent, false);
  const requestId = uuid();
  conversation.traceEmitter.emit("request_received", "Regenerate requested", {
    requestId,
    status: "info",
    attributes: { source: "regenerate" },
  });
  try {
    await conversation.regenerate(sendEvent, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, conversationId }, "Error regenerating message");
    conversation.traceEmitter.emit(
      "request_error",
      truncate(message, 200, ""),
      {
        requestId,
        status: "error",
        attributes: {
          errorClass: err instanceof Error ? err.constructor.name : "Error",
          message: truncate(message, 500, ""),
        },
      },
    );
    throw err;
  }
  return { requestId };
}
// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

/**
 * Delete a queued message from a conversation.
 * Returns `{ removed: true }` on success, `{ removed: false, reason }` on failure.
 */
export function deleteQueuedMessage(
  conversationId: string,
  requestId: string,
  findConversation: (
    id: string,
  ) => { removeQueuedMessage(requestId: string): boolean } | undefined,
):
  | { removed: true }
  | { removed: false; reason: "conversation_not_found" | "message_not_found" } {
  const conversation = findConversation(conversationId);
  if (!conversation) {
    log.warn(
      { conversationId, requestId },
      "No conversation found for delete_queued_message",
    );
    return { removed: false, reason: "conversation_not_found" };
  }
  const removed = conversation.removeQueuedMessage(requestId);
  if (removed) {
    return { removed: true };
  }
  log.warn(
    { conversationId, requestId },
    "Queued message not found for deletion",
  );
  return { removed: false, reason: "message_not_found" };
}

// ---------------------------------------------------------------------------
// HTTP handler (delegates to shared logic)
// ---------------------------------------------------------------------------
