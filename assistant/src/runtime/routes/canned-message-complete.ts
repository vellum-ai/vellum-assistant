import { createAssistantMessage } from "../../agent/message-types.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  addMessage,
  recordConversationPersistedSeq,
  SYSTEM_CARD_MESSAGE_KIND,
} from "../../persistence/conversation-crud.js";
import type { Message } from "../../providers/types.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { getCurrentSeq } from "../assistant-stream-state.js";
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
 * agent loop (the /compact, /clean, and summarize-up-to result cards). The
 * row is stamped `messageKind: "system_card"` so transcripts render it as a
 * standalone system notice instead of assistant-persona speech, and display
 * merging never folds it into an adjacent assistant turn.
 *
 * Cards are announced with `message_complete` (persisted assistant id), the
 * persisted-seq anchor advance (so a stale /messages reseed cannot erase the
 * card), and the messages-changed sync invalidation that drives the client
 * refetch. No `assistant_text_delta` is emitted — a delta would stream the
 * card into the tail assistant bubble as if the persona were speaking.
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
    { metadata: { ...metadata, messageKind: SYSTEM_CARD_MESSAGE_KIND } },
  );
  conversation.getMessages().push(assistantMsg);
  emitCannedMessageComplete(
    broadcastMessage,
    conversationId,
    persistedAssistant.id,
  );
  recordConversationPersistedSeq(conversationId, getCurrentSeq());
  publishConversationMessagesChanged(conversationId, originClientId);
}
