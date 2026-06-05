import { v4 as uuid } from "uuid";

import { clearAll, getConversation } from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import { getSubagentManager } from "../../subagent/index.js";
import { createAbortReason } from "../../util/abort-reasons.js";
import { truncate } from "../../util/truncate.js";
import { regenerate } from "../conversation-history.js";
import {
  conversationEntries,
  findConversation,
} from "../conversation-registry.js";
import {
  clearAllActiveConversations,
  getOrCreateConversation,
  touchConversation,
} from "../conversation-store.js";
import type { ConfirmationResponse } from "../message-protocol.js";
import { normalizeConversationType } from "../message-protocol.js";
import { log } from "./shared.js";

export function handleConfirmationResponse(msg: ConfirmationResponse): void {
  // Route by requestId to the conversation that originated the prompt, not by
  // the current conversation binding which may have changed since the
  // request was issued (e.g. after a conversation switch).
  const decision = msg.decision;

  for (const [conversationId, conversation] of conversationEntries()) {
    if (conversation.hasPendingConfirmation(msg.requestId)) {
      touchConversation(conversationId);
      conversation.handleConfirmationResponse(msg.requestId, decision, {
        selectedPattern: msg.selectedPattern,
        selectedScope: msg.selectedScope,
        emissionContext: { source: "button" },
      });
      return;
    }
  }

  log.warn(
    { requestId: msg.requestId },
    "No conversation found with pending confirmation for requestId",
  );
}
/**
 * Clear all conversations and DB conversations. Returns the number of conversations cleared.
 */
export async function clearAllConversations(): Promise<number> {
  const cleared = clearAllActiveConversations();
  // Also clear DB conversations. When a new local connection triggers
  // sendInitialConversation, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  await clearAll();
  return cleared;
}

/**
 * Switch to an existing conversation. Returns conversation info on success,
 * or throws/returns an error result when the conversation is not found.
 */
export async function switchConversation(conversationId: string): Promise<{
  conversationId: string;
  title: string;
  conversationType: ReturnType<typeof normalizeConversationType>;
  inferenceProfile?: string;
} | null> {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return null;
  }

  // Restore evicted conversations from the database when needed.
  await getOrCreateConversation(conversationId);

  return {
    conversationId: conversation.id,
    title: conversation.title ?? "Untitled",
    conversationType: normalizeConversationType(conversation.conversationType),
    inferenceProfile: conversation.inferenceProfile ?? undefined,
  };
}
/**
 * Cancel generation for a conversation. Returns true if a conversation was found and cancelled.
 */
export function cancelGeneration(conversationId: string): boolean {
  const conversation = findConversation(conversationId);
  if (!conversation) {
    return false;
  }
  touchConversation(conversationId);
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
): Promise<{ removedCount: number } | null> {
  const resolvedId = resolveConversationId(conversationId);
  if (!resolvedId) {
    return null;
  }
  conversationId = resolvedId;
  const conversation = await getOrCreateConversation(conversationId);
  touchConversation(conversationId);
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
): Promise<{ requestId: string } | null> {
  // The caller may pass a conversation key (e.g. the macOS client's local
  // conversation ID) instead of the daemon's internal conversation ID. Resolve
  // to the internal ID so all downstream lookups succeed.
  const resolvedId = resolveConversationId(conversationId);
  if (!resolvedId) {
    return null;
  }
  conversationId = resolvedId;
  const conversation = await getOrCreateConversation(conversationId);
  touchConversation(conversationId);
  conversation.updateClient(broadcastMessage, false);
  getSubagentManager().updateParentSender(conversationId, broadcastMessage);
  const requestId = uuid();
  conversation.traceEmitter.emit("request_received", "Regenerate requested", {
    requestId,
    status: "info",
    attributes: { source: "regenerate" },
  });
  try {
    await regenerate(conversation, requestId);
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

/**
 * Steer a conversation to a specific queued message.
 * Promotes the message to the head of the queue, marks the conversation
 * as needing tool-result repair, and aborts the current generation so the
 * drain path picks up the promoted message.
 *
 * Returns `{ steered: true }` on success, or `{ steered: false, reason }` on failure.
 */
export function steerToMessage(
  conversationId: string,
  requestId: string,
):
  | { steered: true }
  | {
      steered: false;
      reason: "conversation_not_found" | "message_not_found" | "not_processing";
    } {
  const conversation = findConversation(conversationId);
  if (!conversation) {
    log.warn(
      { conversationId, requestId },
      "No conversation found for steer_to_message",
    );
    return { steered: false, reason: "conversation_not_found" };
  }

  if (!conversation.isProcessing()) {
    log.warn(
      { conversationId, requestId },
      "Cannot steer: conversation is not processing",
    );
    return { steered: false, reason: "not_processing" };
  }

  const promoted = conversation.queue.promoteToHead(requestId);
  if (!promoted) {
    log.warn(
      { conversationId, requestId },
      "Queued message not found for steering",
    );
    return { steered: false, reason: "message_not_found" };
  }

  // Mark the conversation for tool-result repair so the drain path can
  // inject synthetic tool results for any pending tool_use blocks that
  // were abandoned by the aborted generation.
  conversation.pendingSteerRepair = true;

  // Broadcast the steer event so clients can update their UI.
  broadcastMessage({
    type: "message_steered",
    conversationId,
    requestId,
  });

  log.info(
    { conversationId, requestId },
    "Steering to queued message — aborting current generation",
  );

  // Abort the in-flight generation. The agent loop's finally block calls
  // drainQueue, which will pick up the promoted message at the head.
  // Unlike abortConversation, we do NOT clear the queue or dispose
  // prompters — we want the queue to drain with the promoted message first.
  const reason = createAbortReason(
    "preempted_by_new_message",
    "steerToMessage",
    conversationId,
  );
  conversation.abortController?.abort(reason);
  // Deny pending confirmations so the abort unblocks immediately.
  conversation.denyAllPendingConfirmations();

  return { steered: true };
}

// ---------------------------------------------------------------------------
// HTTP handler (delegates to shared logic)
// ---------------------------------------------------------------------------
