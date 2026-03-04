import { renderHistoryContent } from "../daemon/handlers.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import * as conversationStore from "../memory/conversation-store.js";
import { deliverChannelReply } from "./gateway-client.js";
import type { RuntimeAttachmentMetadata } from "./http-types.js";

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
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDeliverableTextSegments(
  textSegments: string[],
  fallbackText?: string,
): string[] {
  const nonEmptySegments = textSegments.filter(
    (segment) => segment.trim().length > 0,
  );
  if (nonEmptySegments.length > 0) return nonEmptySegments;
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
  } = params;

  const deliverableSegments = toDeliverableTextSegments(
    textSegments,
    fallbackText,
  );
  const replyAttachments =
    attachments && attachments.length > 0 ? attachments : undefined;

  if (deliverableSegments.length === 0) {
    if (replyAttachments) {
      await deliverChannelReply(
        callbackUrl,
        {
          chatId,
          attachments: replyAttachments,
          assistantId,
          ephemeral,
          user,
        },
        bearerToken,
      );
    }
    return;
  }

  for (let i = startFromSegment; i < deliverableSegments.length; i++) {
    const isLastSegment = i === deliverableSegments.length - 1;
    await deliverChannelReply(
      callbackUrl,
      {
        chatId,
        text: deliverableSegments[i],
        attachments: isLastSegment ? replyAttachments : undefined,
        assistantId,
        ephemeral,
        user,
      },
      bearerToken,
    );

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
};

export async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
  options?: DeliverReplyOptions,
): Promise<void> {
  const msgs = conversationStore.getMessages(conversationId);
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
    });
    break;
  }
}
