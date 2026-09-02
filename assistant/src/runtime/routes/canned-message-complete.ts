import { createAssistantMessage } from "../../agent/message-types.js";
import type { AssistantEvent } from "../../api/index.js";
import {
  addMessage,
  recordConversationPersistedSeq,
} from "../../persistence/conversation-crud.js";
import { SYSTEM_CARD_MESSAGE_KIND } from "../../persistence/conversation-types.js";
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
  send: (msg: AssistantEvent) => void,
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
 * Persist a system card: a daemon-authored notice that bypasses the agent
 * loop. The row is stamped `messageKind: "system_card"` so transcripts render
 * it as a standalone system notice instead of assistant-persona speech, and
 * display merging never folds it into an adjacent assistant turn.
 *
 * The card is persisted and announced to clients but not appended to the live
 * conversation's working history, so a card written while a turn is in flight
 * cannot leave a trailing assistant message for the next provider call to
 * continue from. Callers whose card ends the turn use
 * {@link persistCannedAssistantCard}, which also seats it in the live history.
 *
 * Every card advances the persisted-seq anchor (so a stale /messages reseed
 * cannot erase it) and publishes the messages-changed sync invalidation that
 * drives every client to refetch. That invalidation carries no origin-client
 * id: the card body streams nowhere (no `assistant_text_delta`), so the
 * initiating client materializes it only by refetching, and origin self-echo
 * suppression (meant for content the origin already rendered) would otherwise
 * hide the card from the initiator until a reload. A delta is deliberately
 * omitted; it would stream the card into the tail assistant bubble as if the
 * persona were speaking.
 *
 * `endsTurn` decides whether the card also emits `message_complete`. Clients
 * treat that event as terminal (it clears the processing state and closes the
 * turn), so only a card that *is* the reply carries it. A card posted while a
 * turn is still running (`endsTurn: false`) rides the sync invalidation alone,
 * leaving the in-flight turn's streaming state intact.
 *
 * Returns the persisted card's id and the in-memory message it persisted.
 */
export async function persistSystemCard(opts: {
  conversationId: string;
  text: string;
  metadata: Record<string, unknown>;
  endsTurn: boolean;
}): Promise<{ id: string; message: Message }> {
  const { conversationId, text, metadata, endsTurn } = opts;
  const assistantMsg = createAssistantMessage(text);
  const persistedAssistant = await addMessage(
    conversationId,
    "assistant",
    JSON.stringify(assistantMsg.content),
    { metadata: { ...metadata, messageKind: SYSTEM_CARD_MESSAGE_KIND } },
  );
  if (endsTurn) {
    emitCannedMessageComplete(
      broadcastMessage,
      conversationId,
      persistedAssistant.id,
    );
  }
  recordConversationPersistedSeq(conversationId, getCurrentSeq());
  publishConversationMessagesChanged(conversationId);
  return { id: persistedAssistant.id, message: assistantMsg };
}

/**
 * Persist a canned assistant "card" (a pre-composed reply that bypasses the
 * agent loop: the /compact, /clean, and summarize-up-to result cards) and
 * seat it in the live conversation's history so the turn that follows sees it.
 * The row is stamped `messageKind: "system_card"` so transcripts render it as a
 * standalone system notice instead of assistant-persona speech, and display
 * merging never folds it into an adjacent assistant turn. Delivery is
 * {@link persistSystemCard}'s.
 *
 * Returns the persisted card's message id so callers can link related
 * records to it (e.g. the compaction `llm_request_logs` row).
 */
export async function persistCannedAssistantCard(opts: {
  conversation: { getMessages(): Message[] };
  conversationId: string;
  text: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const { conversation, conversationId, text, metadata } = opts;
  const card = await persistSystemCard({
    conversationId,
    text,
    metadata,
    endsTurn: true,
  });
  conversation.getMessages().push(card.message);
  return card.id;
}
