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

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getAttachmentMetadataForMessage } from "../persistence/attachments-store.js";
import {
  getAttentionStateByConversationIds,
  hasUnseenLatestAssistantMessage,
} from "../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getMessageById,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import {
  isReplyPushIneligibleUserMessage,
  resolveConversationKind,
} from "../persistence/conversation-types.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import { safeParseRecord } from "../util/json.js";
import { emitNotificationSignal } from "./emit-signal.js";
import {
  sanitizeMessagePreview,
  sanitizeNotificationTitle,
} from "./notification-utils.js";

/** Kill switch for this producer, on by default. */
const ASSISTANT_REPLY_PUSH_FLAG = "assistant-reply-push" as const;

/**
 * Collapse whitespace runs ahead of the sanitizers' truncation: blank lines and
 * list indentation would otherwise eat into the copy's length budget.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Body for a reply whose only user-visible output is attachments. Generated
 * files and images are linked to the assistant row by
 * `resolveAssistantAttachments` before the turn's terminal SSE, and are
 * exposed separately from the row's content blocks, so a file-generation reply
 * reaches this producer with no text to preview. Reads attachment metadata
 * only (no base64), and only once the text preview has already come up empty.
 *
 * Returns an empty string when the row has no attachments either, which is the
 * genuinely-empty reply the caller suppresses.
 */
function describeAttachmentOnlyReply(assistantMessageId: string): string {
  const attachments = getAttachmentMetadataForMessage(assistantMessageId);
  if (attachments.length === 0) {
    return "";
  }
  if (attachments.length > 1) {
    return `Sent ${attachments.length} attachments`;
  }
  // Filenames are model- and tool-authored, so one is sanitized before it can
  // reach the lock screen. A filename that sanitizes away leaves generic copy
  // rather than a dangling "Sent ".
  const filename = sanitizeMessagePreview(
    collapseWhitespace(attachments[0].originalFilename),
  );
  return filename ? `Sent ${filename}` : "Sent an attachment";
}

/**
 * Read the markers the eligibility gate below consults off a persisted
 * message's metadata column.
 *
 * `parseMessageMetadata` validates the whole column and yields nothing when
 * any single field fails, so one unrecognized value would otherwise present
 * here as "no metadata" and open every gate at once. The gate is a plain-record
 * predicate, so a permissive read of the same JSON keeps it answering over
 * whichever fields are intact.
 */
function readSuppressionMarkers(
  metadataJson: string | null,
): Record<string, unknown> | undefined {
  const validated = parseMessageMetadata(metadataJson);
  if (validated) {
    return validated;
  }
  return metadataJson ? safeParseRecord(metadataJson) : undefined;
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
  /**
   * True when this turn's reply streams to the app and nowhere else, so the
   * initiating row's channel and voice markers no longer describe where the
   * reply lands. See {@link isReplyPushIneligibleUserMessage}.
   */
  replyDeliveredInAppOnly?: boolean;
  rlog: pino.Logger;
  /** Row the caller already holds; re-read when omitted. */
  conversation?: ConversationRow | null;
}): Promise<void> {
  const { conversationId, assistantMessageId, userMessageId, rlog } = params;
  try {
    if (!isAssistantFeatureFlagEnabled(ASSISTANT_REPLY_PUSH_FLAG)) {
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

    const assistantRow = getMessageById(assistantMessageId, conversationId);
    if (!assistantRow) {
      return;
    }

    const initiatingMessage = getMessageById(userMessageId, conversationId);
    if (!initiatingMessage) {
      return;
    }
    const initiatingMetadata = readSuppressionMarkers(
      initiatingMessage.metadata,
    );
    if (
      isReplyPushIneligibleUserMessage(initiatingMetadata, {
        replyDeliveredInAppOnly: params.replyDeliveredInAppOnly,
      })
    ) {
      return;
    }

    // A reply whose output is entirely attachments has no text to preview, so
    // fall back to naming them rather than suppressing a real reply. A reply
    // with neither text nor attachments stays silent.
    const preview =
      sanitizeMessagePreview(
        collapseWhitespace(stringifyMessageContent(assistantRow.content)),
      ) ||
      sanitizeMessagePreview(describeAttachmentOnlyReply(assistantMessageId));
    if (!preview) {
      return;
    }

    // Conversation titles are user-controlled and unbounded (renames, imports),
    // so the title gets the same treatment as the body before it reaches the
    // lock screen. Absent `requestedTitle` lets the decision branch derive a
    // title from the body, which reads better than an empty or placeholder
    // conversation title.
    const requestedTitle = sanitizeNotificationTitle(
      collapseWhitespace(conversation.title ?? ""),
    );

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
