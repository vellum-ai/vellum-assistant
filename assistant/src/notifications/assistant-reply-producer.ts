/**
 * `chat.assistant_reply` producer for a finished reply the user is not watching.
 *
 * Called at the end of a user-initiated turn (see
 * `daemon/conversation-turn-finalize.ts`) and best-effort throughout: every
 * failure is logged and swallowed, because a notification hiccup must never
 * escalate a reply the client already received into a turn-level throw.
 */

import type pino from "pino";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { isToolResultOnlyUserMessage } from "../conversations/message-consolidation.js";
import { getAttachmentMetadataForMessage } from "../persistence/attachments-store.js";
import {
  getAttentionStateByConversationIds,
  hasUnseenLatestAssistantMessage,
} from "../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getMessageById,
  getRecentConversationMessages,
  type MessageRow,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { isReplaceableTitle } from "../persistence/conversation-title-placeholders.js";
import {
  isEchoSuppressedUserMessage,
  isReplyPushIneligibleUserMessage,
  resolveConversationKind,
} from "../persistence/conversation-types.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import { projectPersistedAssistantContent } from "../persistence/user-facing-content.js";
import { safeParseRecord } from "../util/json.js";
import { workStartedAfter } from "./completion-work.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { hasPendingBackgroundWork } from "./has-pending-background-work.js";
import {
  describeMedia,
  mediaEmbeds,
  sanitizeMessagePreview,
  sanitizeMultilineMessagePreview,
  sanitizeNotificationTitle,
  stripMarkdownForPreview,
} from "./notification-utils.js";
import { resolveCompletionVisibleInSourceNow } from "./resolve-visible-in-source.js";
import { collectRunRows } from "./result-output.js";

/** Kill switch for this producer, on by default. */
const ASSISTANT_REPLY_PUSH_FLAG = "assistant-reply-push" as const;
const REPLY_HISTORY_PAGE_SIZE = 200;

function isCurrentUnseenReply(
  conversationId: string,
  assistantRow: MessageRow,
  turnBoundaryId: string,
  startedAfter: number,
): boolean {
  const attention = getAttentionStateByConversationIds([conversationId]).get(
    conversationId,
  );
  if (
    !hasUnseenLatestAssistantMessage(attention) ||
    assistantRow.createdAt <=
      (attention?.lastSeenAssistantMessageAt ?? -Infinity)
  ) {
    return false;
  }
  let beforeMessageId: string | undefined;
  let foundReply = false;
  let foundLatestAttention = false;
  // A same-turn private wrap-up can own attention while the public reply is earlier.
  // Persisted turn boundaries also supersede replies whose projection is delayed.
  while (true) {
    const history = getRecentConversationMessages(
      conversationId,
      REPLY_HISTORY_PAGE_SIZE,
      beforeMessageId,
    );
    for (let index = history.length - 1; index >= 0; index--) {
      const row = history[index];
      foundReply ||= row.id === assistantRow.id;
      foundLatestAttention ||= row.id === attention?.latestAssistantMessageId;
      if (row.role === "user" && !isToolResultOnlyUserMessage(row)) {
        const metadata = readSuppressionMarkers(row.metadata);
        if (
          row.id !== turnBoundaryId &&
          isEchoSuppressedUserMessage(metadata) &&
          !workStartedAfter({ sentAt: row.createdAt, metadata }, startedAfter)
        ) {
          continue;
        }
        return row.id === turnBoundaryId && foundReply && foundLatestAttention;
      }
    }
    if (history.length < REPLY_HISTORY_PAGE_SIZE) {
      return false;
    }
    beforeMessageId = history[0].id;
  }
}

/**
 * Flatten a title onto one line. Notification titles cannot wrap, and
 * `normalizeTitle` discards any string that still contains a newline.
 */
function flattenTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Body naming every piece of media a reply produced, for a reply whose text
 * flattened away.
 *
 * Two sources, counted together so a reply mixing them is not undercounted.
 * Attachment rows cover generated files, `<vellum-attachment />` directives,
 * and `vellum://` embeds alike; they are linked to the assistant row by
 * `resolveAssistantAttachments` before the turn's terminal SSE and exposed
 * separately from its content blocks. Remote embeds leave no row, so their alt
 * text is the only label they have.
 *
 * Tracked embeds are dropped from the second source rather than added twice:
 * a `vellum://` embed is already one of the attachment rows.
 *
 * Reads attachment metadata only (no base64), and the caller invokes this only
 * once the text preview has come up empty.
 */
function describeReplyMedia(text: string, assistantMessageId: string): string {
  const filenames = getAttachmentMetadataForMessage(assistantMessageId).map(
    (attachment) => attachment.originalFilename,
  );
  const embeds = mediaEmbeds(text);
  const tracked = embeds.filter((embed) => embed.tracked);

  // Resolution is allowed to fail: `resolveAssistantAttachments` skips a file
  // that is missing, oversized, unreadable, or denied at the host-read
  // approval, leaving a tracked embed with no row to stand for it. Rows at
  // least matching the tracked embeds means each one resolved (any surplus
  // being generated files); a shortfall is that many embeds falling back to
  // their own alt rather than vanishing from the count.
  const unresolved = Math.max(0, tracked.length - filenames.length);

  return describeMedia([
    ...filenames,
    ...tracked.slice(tracked.length - unresolved).map((embed) => embed.alt),
    ...embeds.filter((embed) => !embed.tracked).map((embed) => embed.alt),
  ]);
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
    let turnBoundaryId = userMessageId;
    if (initiatingMetadata?.turnOutcome === "batched") {
      if (
        typeof initiatingMetadata.turnBatchedInto !== "string" ||
        !initiatingMetadata.turnBatchedInto
      ) {
        return;
      }
      turnBoundaryId = initiatingMetadata.turnBatchedInto;
    }

    const firstAssistantRow = collectRunRows(
      assistantRow,
      conversationId,
      initiatingMessage.createdAt,
    )[0];
    const startedAfter = firstAssistantRow?.createdAt ?? assistantRow.createdAt;
    if (hasPendingBackgroundWork(conversationId, { startedAfter })) {
      return;
    }

    // A reply whose output is entirely media has no text to preview, so name
    // the media rather than suppressing a real reply. Markdown is flattened
    // first: a lock screen renders none of it, and an embed-only reply has to
    // reduce to empty for the fallback to be reachable. A reply with neither
    // text nor media stays silent.
    // The push preview quotes what the user reads, so it walks the same
    // user-facing projection the transcript does, keyed on the row's own
    // marker: a `send_user_message` turn's plain text is private working notes.
    const text = stringifyMessageContent(
      projectPersistedAssistantContent(
        assistantRow.content,
        assistantRow.metadata,
      ),
    );
    const preview =
      sanitizeMultilineMessagePreview(stripMarkdownForPreview(text)) ||
      sanitizeMessagePreview(describeReplyMedia(text, assistantMessageId));
    if (!preview) {
      return;
    }

    // Conversation titles are user-controlled and unbounded (renames, imports),
    // so the title gets the same treatment as the body before it reaches the
    // lock screen. Absent `requestedTitle` lets the decision branch derive a
    // title from the body, which reads better than an empty or placeholder
    // conversation title.
    //
    // Placeholder titles are plausible non-empty strings and survive
    // sanitizing. They count as absent so the body supplies the title instead.
    const storedTitle = conversation.title?.trim() ?? "";
    const requestedTitle = isReplaceableTitle(storedTitle)
      ? ""
      : sanitizeNotificationTitle(flattenTitleWhitespace(storedTitle));

    const visibleInSourceNow = await resolveCompletionVisibleInSourceNow({
      conversationId,
      logger: rlog,
    });
    if (
      hasPendingBackgroundWork(conversationId, { startedAfter }) ||
      !isCurrentUnseenReply(
        conversationId,
        assistantRow,
        turnBoundaryId,
        startedAfter,
      )
    ) {
      return;
    }

    await emitNotificationSignal({
      sourceEventName: "chat.assistant_reply",
      sourceChannel: "vellum",
      // Deep-link target; the broadcaster validates it and merges it into
      // `deepLinkTarget.conversationId`.
      sourceContextId: conversationId,
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow,
      },
      contextPayload: {
        ...(requestedTitle ? { requestedTitle } : {}),
        requestedMessage: preview,
      },
      // Each persisted reply owns its notification claim independently.
      dedupeKey: `chat.assistant_reply:${conversationId}:${assistantMessageId}`,
    });
  } catch (err) {
    rlog.warn(
      { err, conversationId, messageId: assistantMessageId },
      "Failed to emit assistant reply notification (non-fatal)",
    );
  }
}
