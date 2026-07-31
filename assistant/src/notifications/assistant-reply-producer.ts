/**
 * `chat.assistant_reply` producer: an APNs push for a finished reply the user
 * is no longer looking at.
 *
 * Called at the end of a user-initiated turn (see
 * `daemon/conversation-turn-finalize.ts`) and best-effort throughout: every
 * failure is logged and swallowed, because a notification hiccup must never
 * escalate a reply the client already received into a turn-level throw.
 */

import type pino from "pino";

import { isToolResultMessage } from "../context/refusal-quarantine.js";
import { getAttentionStateByConversationIds } from "../persistence/conversation-attention-store.js";
import {
  getConversation,
  getMessageById,
  getMessagesPaginated,
  isEchoSuppressedUserMessage,
  isVoiceSessionUserMessage,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { resolveConversationKind } from "../persistence/conversation-types.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import type { ContentBlock } from "../providers/types.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { truncate } from "./notification-utils.js";

/** Roughly one notification body's worth of reply text. */
const PREVIEW_MAX_CHARS = 200;

/**
 * The channel id a native-app send carries, and `resolveTurnChannel`'s default
 * when a caller supplies none (see `daemon/process-message.ts`).
 */
const IN_APP_CHANNEL = "vellum";

/**
 * True when the row that opened the turn arrived over an external messaging
 * surface (Slack, Telegram, WhatsApp, email, a phone call, …) rather than the
 * native app.
 *
 * An absent channel counts as in-app: every external ingress path stamps its
 * channel via buildChannelMetadata, so the rows that omit the field are
 * daemon-internal persists on native-app conversations (for example the
 * deliberate omission in calls/call-pointer-messages.ts).
 */
function isChannelOriginatedUserMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const channel = metadata?.userMessageChannel;
  return typeof channel === "string" && channel !== IN_APP_CHANNEL;
}

/**
 * Same unseen predicate the sidebar renders from (`buildAssistantAttention` in
 * `runtime/services/conversation-serializer.ts`): the latest assistant cursor
 * is ahead of the last-seen cursor. A missing state row reads as seen, matching
 * the serializer's no-attention-state default.
 */
function isLatestReplyUnseen(conversationId: string): boolean {
  const state = getAttentionStateByConversationIds([conversationId]).get(
    conversationId,
  );
  if (!state || state.latestAssistantMessageAt == null) {
    return false;
  }
  return (
    state.lastSeenAssistantMessageAt == null ||
    state.lastSeenAssistantMessageAt < state.latestAssistantMessageAt
  );
}

/**
 * The user-role row that opened this turn, skipping the tool-result rows the
 * agent loop also persists with role `"user"`.
 */
function findInitiatingUserMessage(
  conversationId: string,
  assistantMessageCreatedAt: number,
) {
  const { messages } = getMessagesPaginated(
    conversationId,
    1,
    assistantMessageCreatedAt,
    (row) =>
      row.role === "user" &&
      !isToolResultMessage({ role: "user", content: row.content }),
  );
  return messages[0];
}

function buildPreview(content: ContentBlock[]): string {
  return truncate(
    stringifyMessageContent(content).replace(/\s+/g, " ").trim(),
    PREVIEW_MAX_CHARS,
  );
}

export async function emitAssistantReplyNotification(params: {
  conversationId: string;
  assistantMessageId: string;
  rlog: pino.Logger;
}): Promise<void> {
  const { conversationId, assistantMessageId, rlog } = params;
  try {
    const conversation = getConversation(conversationId);
    if (!conversation) {
      return;
    }
    // The other three kinds (memory consolidation, background, scheduled) each
    // already have their own notification producer.
    const kind = resolveConversationKind(
      conversation.source,
      conversation.conversationType,
    );
    if (kind !== "user") {
      return;
    }
    if (!isLatestReplyUnseen(conversationId)) {
      return;
    }

    const assistantRow = getMessageById(assistantMessageId, conversationId);
    if (!assistantRow) {
      return;
    }

    // Scheduled/background prompts injected into an ordinary user conversation
    // are automated turns with their own producers (e.g. `schedule.notify`);
    // notifying here too would double-notify.
    const initiatingMessage = findInitiatingUserMessage(
      conversationId,
      assistantRow.createdAt,
    );
    if (!initiatingMessage) {
      return;
    }
    const initiatingMetadata = parseMessageMetadata(initiatingMessage.metadata);
    if (initiatingMetadata?.automated === true) {
      return;
    }
    // Hidden lifecycle rows (subagent/ACP completions, wake triggers, hidden
    // sends) are persisted with role "user" but are internal scaffolding, so
    // the turn they open is nobody's prompt awaiting a reply.
    if (isEchoSuppressedUserMessage(initiatingMetadata)) {
      return;
    }
    // A phone or in-app voice utterance is answered out loud over the session
    // the user is still on, so the reply is never unseen in the sense this
    // producer notifies about; pushing here would fire once per spoken turn.
    if (isVoiceSessionUserMessage(initiatingMetadata)) {
      return;
    }
    // A turn started from a messaging channel has its finished reply delivered
    // back to that channel (`finalizeEventDelivery`), so the sender already has
    // it; pushing here would duplicate it on their phone. The voice gate above
    // cannot stand in for this one: an in-app live-voice turn persists as
    // `vellum`, exactly like a typed send.
    if (isChannelOriginatedUserMessage(initiatingMetadata)) {
      return;
    }

    const preview = buildPreview(assistantRow.content);
    if (!preview) {
      return;
    }

    // Absent `requestedTitle` lets the decision branch derive a title from the
    // body, which reads better than an empty or placeholder conversation title.
    const requestedTitle = conversation.title?.trim();

    await emitNotificationSignal({
      sourceEventName: "chat.assistant_reply",
      sourceChannel: "vellum",
      // Deep-link target; the broadcaster validates it and merges it into
      // `deepLinkTarget.conversationId`.
      sourceContextId: conversationId,
      attentionHints: {
        requiresAction: false,
        // Load-bearing for the iOS-only scope: `emit-signal.ts` force-adds the
        // vellum channel for high/critical signals, which would widen this into
        // an in-app banner on every client. Raising the urgency is the same as
        // opting into v2.
        urgency: "medium",
        isAsyncBackground: false,
        // The daemon cannot tell "still viewing" from "just left" at turn end.
        // The viewing-on-iPhone case is covered by iOS suppressing remote
        // pushes while the app is foregrounded.
        visibleInSourceNow: false,
      },
      contextPayload: {
        ...(requestedTitle ? { requestedTitle } : {}),
        requestedMessage: preview,
      },
      // The pipeline dedupe window is a flat hour keyed on this alone, so it
      // has to carry the message id or a second reply within the hour is
      // silently dropped.
      dedupeKey: `chat.assistant_reply:${conversationId}:${assistantMessageId}`,
    });
  } catch (err) {
    rlog.warn(
      { err, conversationId, messageId: assistantMessageId },
      "Failed to emit assistant reply notification (non-fatal)",
    );
  }
}
