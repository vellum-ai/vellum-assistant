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

import { parseChannelId } from "../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfigReadOnly } from "../config/loader.js";
import {
  getAttentionStateByConversationIds,
  hasUnseenLatestAssistantMessage,
} from "../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getMessageById,
  isEchoSuppressedUserMessage,
  isVoiceSessionUserMessage,
  type MessageRow,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { resolveConversationKind } from "../persistence/conversation-types.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { sanitizeMessagePreview } from "./notification-utils.js";

const ASSISTANT_REPLY_PUSH_FLAG = "assistant-reply-push" as const;

/**
 * Kill switch for this producer, on by default. Read through the read-only
 * config accessor: the resolver ignores the config argument, so the write-side
 * `getConfig()` would only add disk I/O to a best-effort path.
 */
function isAssistantReplyPushEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(
    ASSISTANT_REPLY_PUSH_FLAG,
    getConfigReadOnly(),
  );
}

/**
 * True when the row that opened the turn arrived over an external messaging
 * surface (Slack, Telegram, WhatsApp, email, a phone call, …) rather than the
 * native app.
 *
 * An absent (or unrecognized) channel counts as in-app: every external ingress
 * path stamps its channel via buildChannelMetadata, so the rows that omit the
 * field are daemon-internal persists on native-app conversations (for example
 * the deliberate omission in calls/call-pointer-messages.ts).
 */
function isChannelOriginatedUserMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const channel = parseChannelId(metadata?.userMessageChannel);
  return channel != null && channel !== "vellum";
}

export async function emitAssistantReplyNotification(params: {
  conversationId: string;
  assistantMessageId: string;
  /**
   * The row that opened the turn, threaded from the agent loop. Reading it by
   * id rather than scanning back from the assistant row keeps a hidden or
   * queued user message that landed mid-turn from being mistaken for the
   * prompt this reply answers.
   */
  userMessageId: string | undefined;
  rlog: pino.Logger;
  /** Rows the caller already holds; re-read when omitted. */
  conversation?: ConversationRow | null;
  assistantMessage?: MessageRow | null;
}): Promise<void> {
  const { conversationId, assistantMessageId, userMessageId, rlog } = params;
  try {
    if (!isAssistantReplyPushEnabled()) {
      return;
    }
    if (!userMessageId) {
      return;
    }
    const conversation = params.conversation ?? getConversation(conversationId);
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
    const attention = getAttentionStateByConversationIds([conversationId]).get(
      conversationId,
    );
    if (!hasUnseenLatestAssistantMessage(attention)) {
      return;
    }

    const assistantRow =
      params.assistantMessage ??
      getMessageById(assistantMessageId, conversationId);
    if (!assistantRow) {
      return;
    }

    const initiatingMessage = getMessageById(userMessageId, conversationId);
    if (!initiatingMessage) {
      return;
    }
    const initiatingMetadata = parseMessageMetadata(initiatingMessage.metadata);
    // Scheduled/background prompts injected into an ordinary user conversation
    // are automated turns with their own producers (e.g. `schedule.notify`);
    // notifying here too would double-notify.
    if (initiatingMetadata?.automated === true) {
      return;
    }
    // A turn opened by internal scaffolding is nobody's prompt awaiting a
    // reply; see `isEchoSuppressedUserMessage`.
    if (isEchoSuppressedUserMessage(initiatingMetadata)) {
      return;
    }
    // A spoken reply is delivered over the still-open session; see
    // `isVoiceSessionUserMessage`.
    if (isVoiceSessionUserMessage(initiatingMetadata)) {
      return;
    }
    // A turn started from a messaging channel has its finished reply delivered
    // back to that channel (`finalizeEventDelivery`), so the sender already has
    // it; pushing here would duplicate it on their phone.
    if (isChannelOriginatedUserMessage(initiatingMetadata)) {
      return;
    }

    const preview = sanitizeMessagePreview(
      stringifyMessageContent(assistantRow.content),
    );
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
