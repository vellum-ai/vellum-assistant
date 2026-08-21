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
  isDesktopOriginatedUserMessage,
  isReplyPushIneligibleUserMessage,
  resolveConversationKind,
} from "../persistence/conversation-types.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import { isDesktopAttended } from "../runtime/desktop-presence.js";
import { isWebConversationFocused } from "../runtime/web-presence.js";
import { safeParseRecord } from "../util/json.js";
import { emitNotificationSignal } from "./emit-signal.js";
import {
  describeMedia,
  mediaEmbeds,
  sanitizeMessagePreview,
  sanitizeNotificationTitle,
  stripMarkdownForPreview,
} from "./notification-utils.js";

/** Kill switch for this producer, on by default. */
const ASSISTANT_REPLY_PUSH_FLAG = "assistant-reply-push" as const;

/** Gates the desktop-attended suppression below, on by default. */
const DESKTOP_PRESENCE_FLAG = "desktop-presence-suppression" as const;

/** Gates the web-focused suppression below, on by default. */
const WEB_PRESENCE_FLAG = "web-presence-suppression" as const;

/**
 * Collapse whitespace runs ahead of the sanitizers' truncation: blank lines and
 * list indentation would otherwise eat into the copy's length budget.
 */
function collapseWhitespace(value: string): string {
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

/**
 * Desktop attendance, kept fail-open here: a presence read that fails has to
 * send the push, not reach the producer's catch and silence it.
 *
 * No `actorPrincipalId`: the platform delivers this push to the assistant
 * owner's device tokens, and a pod has exactly one owner, so any attended
 * desktop client is that owner's.
 */
function readDesktopAttended(rlog: pino.Logger): boolean {
  try {
    return isDesktopAttended();
  } catch (err) {
    rlog.warn({ err }, "Desktop presence read failed; treating as unattended");
    return false;
  }
}

/**
 * Web presence, kept fail-open here for the same reason as
 * {@link readDesktopAttended}: a presence read that fails has to send the
 * push, not reach the producer's catch and silence it.
 *
 * No `actorPrincipalId`: the platform delivers this push to the assistant
 * owner's device tokens, and a pod has exactly one owner, so any focused web
 * tab is that owner's.
 */
function readWebConversationFocused(
  conversationId: string,
  rlog: pino.Logger,
): boolean {
  try {
    return isWebConversationFocused(conversationId);
  } catch (err) {
    rlog.warn({ err }, "Web presence read failed; treating as unfocused");
    return false;
  }
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

    // A reply whose output is entirely media has no text to preview, so name
    // the media rather than suppressing a real reply. Markdown is flattened
    // first: a lock screen renders none of it, and an embed-only reply has to
    // reduce to empty for the fallback to be reachable. A reply with neither
    // text nor media stays silent.
    const text = stringifyMessageContent(assistantRow.content);
    const preview =
      sanitizeMessagePreview(
        collapseWhitespace(stripMarkdownForPreview(text)),
      ) || sanitizeMessagePreview(describeReplyMedia(text, assistantMessageId));
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

    // Read as close to the emit as possible: nothing short-circuits on it.
    // Presence only speaks for a turn the desktop itself opened, on that row's
    // own OS evidence. A turn sent from the phone still needs its push while the
    // desktop sits idle within the attendance window.
    const desktopAttended =
      isAssistantFeatureFlagEnabled(DESKTOP_PRESENCE_FLAG) &&
      isDesktopOriginatedUserMessage(initiatingMetadata) &&
      readDesktopAttended(rlog);

    // Conversation-scoped web presence applies regardless of which device
    // initiated the turn: a visible matching tab proves where this reply is
    // currently being displayed, while the conversation id prevents an
    // unrelated tab from suppressing the push.
    const webFocused =
      isAssistantFeatureFlagEnabled(WEB_PRESENCE_FLAG) &&
      readWebConversationFocused(conversationId, rlog);

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
        // Read weakly, as "at the surface this landed on": the attended desktop
        // or focused web tab that opened the turn renders the reply in-app,
        // so a redundant push would only duplicate what's already on screen.
        visibleInSourceNow: desktopAttended || webFocused,
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
