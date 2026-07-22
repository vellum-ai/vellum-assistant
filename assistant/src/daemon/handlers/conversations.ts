import { peekAcpSessionManager } from "../../acp/index.js";
import { decideGuardianRequest } from "../../channels/gateway-guardian-requests.js";
import {
  clearAll,
  getConversation,
} from "../../persistence/conversation-crud.js";
import { resolveConversationId } from "../../persistence/conversation-key-store.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import { resolveCapabilities } from "../../runtime/capabilities.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { getSubagentManager } from "../../subagent/index.js";
import { createAbortReason } from "../../util/abort-reasons.js";
import { UserError } from "../../util/errors.js";
import { touchConversation } from "../conversation-evictor.js";
import {
  buildSlashContext,
  formatCleanResult,
} from "../conversation-process.js";
import {
  conversationEntries,
  findConversation,
} from "../conversation-registry.js";
import { resolveSlash } from "../conversation-slash.js";
import {
  clearAllActiveConversations,
  getOrCreateConversation,
} from "../conversation-store.js";
import type { ConfirmationResponse } from "../message-protocol.js";
import { normalizeConversationType } from "../message-protocol.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../trust-context.js";
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
  // Cancel any in-flight ACP agent sessions this conversation spawned, for the
  // same reason: a backgrounded ACP prompt would otherwise keep running (and
  // holding a child process) past the stop and, on completion, enqueue a
  // follow-up message back into the conversation the user just cancelled. Peek
  // the singleton so a conversation that never used ACP doesn't spin one up.
  peekAcpSessionManager()?.cancelForParent(conversationId);
  // The processing flag is cleared by the in-flight turn's `finally`, not here.
  // Abort propagates into the provider call and tool execution (and is backed
  // by the agent loop's abort watchdog), so the turn reaches its `finally`
  // within a bounded time and tears down its own state there — which publishes
  // the metadata sync invalidation that drives clients to the authoritative
  // idle state.
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

export interface MetaSlashCommandResult {
  kind: "clean" | "info";
  /** User-facing text to render (clean stats card or info listing). */
  text: string;
  /** Present for `/clean`: the post-strip context-window usage. */
  contextUsage?: {
    tokens: number;
    maxTokens: number | null;
    fillRatio: number | null;
  };
}

/**
 * Resolve a local meta slash command (`/clean`, `/status`, `/commands`,
 * `/models`) for a conversation without running a turn: no user/assistant
 * messages are persisted and no streaming/turn events are emitted. `/clean`
 * additionally strips runtime injections via `forceClean`.
 *
 * Returns null if the conversation cannot be resolved. Throws `UserError` for
 * commands that are not local meta commands (`/compact`, passthrough) — those
 * must be sent as a normal message so they run a real turn.
 */
export async function resolveMetaSlashCommand(
  conversationId: string,
  command: string,
): Promise<MetaSlashCommandResult | null> {
  const resolvedId = resolveConversationId(conversationId);
  if (!resolvedId) {
    return null;
  }
  const conversation = await getOrCreateConversation(resolvedId);
  touchConversation(resolvedId);

  // Meta commands reload (and, for `/clean`, strip) the in-memory history
  // array. Running that against an in-flight turn would corrupt the messages
  // the active agent loop is iterating over, and mutating trustContext would
  // elevate that turn's actor trust to guardian for subsequent tool calls.
  if (conversation.isProcessing()) {
    throw new UserError(
      `\`${command.trim()}\` cannot run while the assistant is responding.`,
    );
  }

  // Owner self-maintenance operates on the full (guardian) history. Without a
  // trusted context, `loadFromDb` filters to non-guardian provenance — so a
  // guardian-authored conversation would report 0 preserved / 0 messages.
  // Temporarily apply the guardian context for hydration and restore it
  // afterward so the elevated class never leaks into a later turn's snapshot.
  const priorTrustContext = conversation.trustContext;
  if (!resolveCapabilities(priorTrustContext?.trustClass).canAccessMemory) {
    conversation.setTrustContext(INTERNAL_GUARDIAN_TRUST_CONTEXT);
  }
  try {
    await conversation.ensureActorScopedHistory();

    const slashResult = await resolveSlash(
      command,
      buildSlashContext(command, conversation),
    );

    if (slashResult.kind === "clean") {
      const result = await conversation.forceClean();
      return {
        kind: "clean",
        text: formatCleanResult(result),
        contextUsage: {
          tokens: result.estimatedInputTokens,
          maxTokens: result.maxInputTokens,
          fillRatio:
            result.maxInputTokens > 0
              ? result.estimatedInputTokens / result.maxInputTokens
              : null,
        },
      };
    }

    if (slashResult.kind === "unknown") {
      return { kind: "info", text: slashResult.message };
    }

    // `compact` / `passthrough` are real turns, not local meta commands.
    throw new UserError(`\`${command.trim()}\` is not a local meta command.`);
  } finally {
    // Only undo the temporary guardian context this handler installed. If a
    // new turn started at an `await` boundary and legitimately updated
    // trustContext, the reference will differ and we leave it alone.
    if (conversation.trustContext === INTERNAL_GUARDIAN_TRUST_CONTEXT) {
      conversation.setTrustContext(priorTrustContext ?? null);
    }
  }
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

/**
 * Supersede an open `ask_question` prompt when a new chat message is enqueued
 * for the same conversation.
 *
 * A queued message while a clarification question is open means the user chose
 * to move on rather than answer it. Steering to that message aborts the parked
 * turn — which settles the open question via its turn-abort signal — repairs
 * the dangling `tool_use`, and drains the message, instead of stranding it
 * behind a prompt no one is going to answer. Only `ask_question` prompts
 * (`kind: "question"`) trigger this; pending confirmations are handled
 * separately by the enqueue path's auto-deny.
 *
 * Returns `true` when a parked question was found and a steer was issued.
 */
export function steerOnEnqueuedMessageIfQuestionParked(
  conversationId: string,
  enqueuedRequestId: string,
): boolean {
  const hasParkedQuestion = pendingInteractions
    .getByConversation(conversationId)
    .some((interaction) => interaction.kind === "question");
  if (!hasParkedQuestion) return false;
  steerToMessage(conversationId, enqueuedRequestId);
  return true;
}

/**
 * Supersede interactions left pending by an in-flight turn when a new message
 * is enqueued for a busy conversation. Centralized so every ingress path (the
 * HTTP send handler and the CLI signal path) gets identical handling:
 *
 *  1. Auto-deny pending confirmations — notify the client and issue the
 *     gateway request-status sync *before* clearing the prompter-owned
 *     confirmations, so a later guardian reply can't match a stale "pending"
 *     record and fail with `pending_interaction_not_found`.
 *  2. Supersede a parked ask_question by steering to the enqueued message.
 *
 * Order matters: the steer aborts the turn, which denies the prompter's
 * confirmations as a side effect, so the status/notification sync must be
 * issued first. `removeByConversation` preserves `question` entries, so the
 * parked question is still registered for the steer even after the
 * confirmation sweep.
 */
export function supersedePendingInteractionsOnEnqueue(
  conversationId: string,
  enqueuedRequestId: string,
): void {
  const conversation = findConversation(conversationId);
  if (!conversation) return;

  if (conversation.hasAnyPendingConfirmation()) {
    for (const interaction of pendingInteractions.getByConversation(
      conversationId,
    )) {
      if (interaction.kind === "confirmation") {
        // sendToClient (wired to the SSE hub) delivers the denial to clients.
        conversation.emitConfirmationStateChanged({
          conversationId,
          requestId: interaction.requestId,
          state: "denied" as const,
          source: "auto_deny" as const,
        });
        // Sync the gateway request so stale "pending" rows aren't matched
        // by later guardian reply routing. Fire-and-forget from this sync
        // path: the in-memory denial is authoritative, and a CAS miss
        // (already decided elsewhere) is expected and harmless.
        void decideGuardianRequest({
          id: interaction.requestId,
          expectedStatus: "pending",
          status: "denied",
        }).catch((err) => {
          log.warn(
            { err, requestId: interaction.requestId },
            "Auto-deny guardian request status sync failed",
          );
        });
      }
    }
    conversation.denyAllPendingConfirmations();
    pendingInteractions.removeByConversation(conversationId);
  }

  steerOnEnqueuedMessageIfQuestionParked(conversationId, enqueuedRequestId);
}

// ---------------------------------------------------------------------------
// HTTP handler (delegates to shared logic)
// ---------------------------------------------------------------------------
