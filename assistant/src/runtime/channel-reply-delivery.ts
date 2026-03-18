import { renderHistoryContent } from "../daemon/handlers/shared.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import { getMessages } from "../memory/conversation-crud.js";
import type { ChannelDeliveryResult } from "./gateway-client.js";
import { deliverChannelReply } from "./gateway-client.js";
import type { RuntimeAttachmentMetadata } from "./http-types.js";
import {
  isSlackCallbackUrl,
  textToSlackBlocks,
} from "./slack-block-formatting.js";

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
  const hadNoResponseMarker = textSegments.some((s) => NO_RESPONSE_RE.test(s));
  if (hadNoResponseMarker) return [];
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
      onMessageTs: options?.onMessageTs,
    });
    break;
  }
}
