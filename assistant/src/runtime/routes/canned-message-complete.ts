import { createAssistantMessage } from "../../agent/message-types.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { addMessage } from "../../persistence/conversation-crud.js";
import type { Message } from "../../providers/types.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { publishConversationMessagesChanged } from "../sync/resource-sync-events.js";

// ---------------------------------------------------------------------------
// Temporary fix — remove when #31994 lands
// ---------------------------------------------------------------------------
//
// The canned-response paths (canned greeting, inline approval reply, slash
// command, /compact, /clean, summarize-up-to) bypass the agent loop and so
// don't pick up the per-turn anchor id allocated in
// conversation-agent-loop.ts. Their `message_complete` events therefore went
// out without `messageId`, and the macOS client filter at
// ChatActionHandler.swift:507 dropped those events when they raced past the
// 50 ms streaming-buffer flush — leaving `isSending` stuck for the full 60 s
// watchdog window.
//
// Centralized so the patch surface is one helper + N one-line callers rather
// than N duplicated literals. When #31994 lands and stamps these sites with
// `state.assistantTurnId` directly, grep for `emitCannedMessageComplete` to
// find every call site and inline-then-delete.
export function emitCannedMessageComplete(
  send: (msg: ServerMessage) => void,
  conversationId: string,
  persistedAssistantId: string,
): void {
  send({
    type: "message_complete",
    conversationId,
    messageId: persistedAssistantId,
  });
}

/**
 * Persist a canned assistant "card" — a pre-composed reply that bypasses the
 * agent loop (the /compact, /clean, and summarize-up-to result cards) — and
 * emit the turn-style events clients expect for it: the full text as a single
 * `assistant_text_delta`, `message_complete` with the persisted assistant id,
 * and the messages-changed sync invalidation.
 *
 * Callers that interleave other broadcasts between the persist and the
 * delta (the canned greeting and unknown-slash-command paths defer their
 * broadcasts behind the HTTP response with a `user_message_echo` in
 * between) cannot use this helper without reordering their events.
 */
export async function persistCannedAssistantCard(opts: {
  conversation: { getMessages(): Message[] };
  conversationId: string;
  text: string;
  metadata: Record<string, unknown>;
  originClientId?: string;
}): Promise<void> {
  const { conversation, conversationId, text, metadata, originClientId } = opts;
  const assistantMsg = createAssistantMessage(text);
  const persistedAssistant = await addMessage(
    conversationId,
    "assistant",
    JSON.stringify(assistantMsg.content),
    { metadata },
  );
  conversation.getMessages().push(assistantMsg);
  broadcastMessage({
    type: "assistant_text_delta",
    text,
    conversationId,
  });
  emitCannedMessageComplete(
    broadcastMessage,
    conversationId,
    persistedAssistant.id,
  );
  publishConversationMessagesChanged(conversationId, originClientId);
}
