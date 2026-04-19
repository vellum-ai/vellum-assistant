import { renderHistoryContent } from "../daemon/handlers/shared.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import {
  getMessageById,
  getMessages,
  updateMessageMetadata,
} from "../memory/conversation-crud.js";
import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { getLogger } from "../util/logger.js";
import type { ChannelDeliveryResult } from "./gateway-client.js";
import { deliverChannelReply } from "./gateway-client.js";
import type { RuntimeAttachmentMetadata } from "./http-types.js";
import {
  isSlackCallbackUrl,
  textToSlackBlocks,
} from "./slack-block-formatting.js";

const log = getLogger("channel-reply-delivery");

const INTER_SEGMENT_DELAY_MS = 150;

type DeliverRenderedReplyParams = {
  callbackUrl: string;
  chatId: string;
  textSegments: string[];
  fallbackText?: string;
  attachments?: RuntimeAttachmentMetadata[];
  assistantId?: string;
  bearerToken?: string;
  interSegmentDelayMs?: number;
  /** Skip segments already delivered on a previous attempt. */
  startFromSegment?: number;
  /** Called after each segment is successfully delivered, with the
   *  1-based count of segments delivered so far (including prior attempts). */
  onSegmentDelivered?: (deliveredCount: number) => void;
  /**
   * When true, deliver via ephemeral messaging so only the target `user`
   * sees the content. Ephemeral messages are fire-and-forget: they cannot
   * be edited or deleted after posting.
   */
  ephemeral?: boolean;
  /** Channel-specific user ID — required when `ephemeral` is true. */
  user?: string;
  /** When provided, the first segment will update the existing message
   *  identified by this ts instead of posting a new one (Slack-specific). */
  messageTs?: string;
  /** Called with the ts of the delivered/updated message so callers
   *  can use it for subsequent updates. */
  onMessageTs?: (ts: string) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NO_RESPONSE_RE = /^\s*<no_response\s*\/?>\s*$/;

/** Returns true when any segment is a `<no_response/>` sentinel. */
function hasNoResponseMarker(textSegments: string[]): boolean {
  return textSegments.some((s) => NO_RESPONSE_RE.test(s));
}

function toDeliverableTextSegments(
  textSegments: string[],
  fallbackText?: string,
): string[] {
  const nonEmptySegments = textSegments.filter(
    (segment) => segment.trim().length > 0 && !NO_RESPONSE_RE.test(segment),
  );
  if (nonEmptySegments.length > 0) return nonEmptySegments;
  // If the only text was <no_response/>, treat as intentional silence —
  // do not fall back to fallbackText.
  if (hasNoResponseMarker(textSegments)) return [];
  if (typeof fallbackText === "string" && fallbackText.trim().length > 0) {
    return [fallbackText];
  }
  return [];
}

export async function deliverRenderedReplyViaCallback(
  params: DeliverRenderedReplyParams,
): Promise<void> {
  const {
    callbackUrl,
    chatId,
    textSegments,
    fallbackText,
    attachments,
    assistantId,
    bearerToken,
    interSegmentDelayMs = INTER_SEGMENT_DELAY_MS,
    startFromSegment = 0,
    onSegmentDelivered,
    ephemeral,
    user,
    messageTs,
    onMessageTs,
  } = params;

  const deliverableSegments = toDeliverableTextSegments(
    textSegments,
    fallbackText,
  );
  const replyAttachments =
    attachments && attachments.length > 0 ? attachments : undefined;

  // If the model output <no_response/> and no other deliverable text remains,
  // suppress all delivery — including attachments — so nothing is posted.
  if (deliverableSegments.length === 0 && hasNoResponseMarker(textSegments)) {
    return;
  }

  if (deliverableSegments.length === 0) {
    if (replyAttachments) {
      const result: ChannelDeliveryResult = await deliverChannelReply(
        callbackUrl,
        {
          chatId,
          attachments: replyAttachments,
          assistantId,
          ephemeral,
          user,
          messageTs,
        },
        bearerToken,
      );
      if (result.ts) {
        onMessageTs?.(result.ts);
      }
    }
    return;
  }

  const isSlack = isSlackCallbackUrl(callbackUrl);

  // Only the first segment uses messageTs for in-place update;
  // subsequent segments are posted as new messages.
  let currentMessageTs = messageTs;

  for (let i = startFromSegment; i < deliverableSegments.length; i++) {
    const isLastSegment = i === deliverableSegments.length - 1;
    const isFirstSegment = i === startFromSegment;
    const segmentText = deliverableSegments[i];
    const blocks = isSlack ? textToSlackBlocks(segmentText) : undefined;
    const result: ChannelDeliveryResult = await deliverChannelReply(
      callbackUrl,
      {
        chatId,
        text: segmentText,
        blocks,
        attachments: isLastSegment ? replyAttachments : undefined,
        assistantId,
        ephemeral,
        user,
        messageTs: isFirstSegment ? currentMessageTs : undefined,
      },
      bearerToken,
    );

    if (result.ts) {
      currentMessageTs = result.ts;
      onMessageTs?.(result.ts);
    }

    onSegmentDelivered?.(i + 1);

    // Send split messages in-order with a short gap so downstream channel
    // providers preserve the original turn ordering around tool boundaries.
    if (!isLastSegment && interSegmentDelayMs > 0) {
      await sleep(interSegmentDelayMs);
    }
  }
}

export type DeliverReplyOptions = {
  startFromSegment?: number;
  onSegmentDelivered?: (deliveredCount: number) => void;
  /** Deliver as ephemeral (visible only to `user`). Fire-and-forget. */
  ephemeral?: boolean;
  /** Channel-specific user ID — required when `ephemeral` is true. */
  user?: string;
  /** Update an existing message instead of posting a new one. */
  messageTs?: string;
  /** Called with the ts of the delivered/updated message. */
  onMessageTs?: (ts: string) => void;
};

export async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
  options?: DeliverReplyOptions,
): Promise<void> {
  const msgs = getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(msgs[i].content);
    } catch {
      parsed = msgs[i].content;
    }
    const rendered = renderHistoryContent(parsed);

    const linked = attachmentsStore.getAttachmentMetadataForMessage(msgs[i].id);
    const replyAttachments: RuntimeAttachmentMetadata[] = linked.map((a) => ({
      id: a.id,
      filename: a.originalFilename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
    }));

    // Compose an `onMessageTs` that reconciles `slackMeta.channelTs` on the
    // persisted assistant row once Slack returns the authoritative ts. The
    // assistant row was written BEFORE the gateway POST in
    // `handleMessageComplete`, so the partial `slackMeta` it carries is
    // missing `channelTs` and would otherwise be rejected by
    // `readSlackMetadata`, dropping the row out of chronological/thread-tag
    // rendering. We only act on the FIRST ts (top-level segment); any
    // subsequent split segments become independent Slack messages with
    // their own ts and are not represented as separate DB rows.
    const reconcileOnMessageTs = makeChannelTsReconciler(msgs[i].id);
    const callerOnMessageTs = options?.onMessageTs;
    const composedOnMessageTs = (ts: string): void => {
      reconcileOnMessageTs(ts);
      callerOnMessageTs?.(ts);
    };

    await deliverRenderedReplyViaCallback({
      callbackUrl,
      chatId: externalChatId,
      textSegments: rendered.textSegments,
      fallbackText: rendered.text,
      attachments: replyAttachments,
      assistantId,
      bearerToken,
      startFromSegment: options?.startFromSegment,
      onSegmentDelivered: options?.onSegmentDelivered,
      ephemeral: options?.ephemeral,
      user: options?.user,
      messageTs: options?.messageTs,
      onMessageTs: composedOnMessageTs,
    });
    break;
  }
}

/**
 * Build a one-shot `onMessageTs` handler that reconciles the persisted
 * assistant message's `slackMeta.channelTs` from Slack's authoritative `ts`.
 *
 * Behavior:
 * - Acts only on the first invocation per delivery (subsequent segments
 *   correspond to independent Slack messages with their own ts and are not
 *   represented as separate DB rows).
 * - No-op when the row was not persisted with a `slackMeta` envelope (the
 *   channel was not Slack at write-time, e.g. vellum/telegram outbound).
 * - No-op when the row's existing `slackMeta` already parses cleanly via
 *   `readSlackMetadata` (channelTs already present, e.g. from a prior
 *   reconciliation).
 * - Failures are logged and swallowed so a transient DB error cannot break
 *   the outbound delivery itself.
 */
function makeChannelTsReconciler(messageId: string): (ts: string) => void {
  let applied = false;
  return (ts: string): void => {
    if (applied) return;
    applied = true;
    if (!ts) return;
    try {
      // Re-read the row's current metadata so a concurrent edit-propagation
      // write (e.g. `editedAt`) is not clobbered. `updateMessageMetadata`
      // shallow-merges into the top-level envelope, and the slackMeta
      // sub-object is merged manually below so we can preserve fields on
      // the partial pre-send envelope (`mergeSlackMetadata` would call
      // `readSlackMetadata` which rejects the partial form for lacking
      // channelTs — exactly the state we are reconciling).
      const row = getMessageById(messageId);
      if (row === null || row.metadata === null) return;
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        return;
      }
      const slackMetaRaw =
        typeof envelope.slackMeta === "string" ? envelope.slackMeta : null;
      if (slackMetaRaw === null) return;
      // If the existing slackMeta already parses cleanly via the strict
      // reader, channelTs is already present (a prior reconciliation ran,
      // or backfill stamped the field) — nothing to do.
      if (readSlackMetadata(slackMetaRaw) !== null) return;
      // Lenient parse of the partial slackMeta so we can preserve every
      // field already written by `handleMessageComplete` (source,
      // eventKind, channelId, threadTs, ...) while patching channelTs in.
      let existingSlackMeta: Record<string, unknown>;
      try {
        const parsed = JSON.parse(slackMetaRaw) as unknown;
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          return;
        }
        existingSlackMeta = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      const mergedSlackMeta = JSON.stringify({
        ...existingSlackMeta,
        channelTs: ts,
        // Force `source: "slack"` for parity with `mergeSlackMetadata`'s
        // invariant — the reader rejects anything else and we never want a
        // reconciled row to slip through with a stale source.
        source: "slack",
      });
      updateMessageMetadata(messageId, { slackMeta: mergedSlackMeta });
    } catch (err) {
      log.warn(
        { err, messageId },
        "Failed to reconcile slackMeta.channelTs on outbound assistant row",
      );
    }
  };
}
