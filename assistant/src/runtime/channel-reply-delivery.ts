import type { MessageAudience } from "@vellumai/gateway-client";

import { stripVellumLinks } from "../daemon/assistant-attachments.js";
import type { RenderedHistoryContent } from "../daemon/handlers/shared.js";
import { renderHistoryContent } from "../daemon/handlers/shared.js";
import { editChannelMessage } from "../messaging/providers/index.js";
import { getAttachmentMetadataForMessage } from "../persistence/attachments-store.js";
import {
  getMessageById,
  getMessages,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { isReactionMessageMetadata } from "../persistence/conversation-types.js";
import { getLogger } from "../util/logger.js";
import type { ChannelDeliveryResult } from "./gateway-client.js";
import { deliverChannelReply } from "./gateway-client.js";
import type { RuntimeAttachmentMetadata } from "./http-types.js";
import {
  containsNoResponseMarker,
  stripNoResponseMarkers,
} from "./no-response.js";
import { makeSentMessageIdReconciler } from "./outbound-post-reconciliation.js";

const log = getLogger("channel-reply-delivery");

const INTER_SEGMENT_DELAY_MS = 150;

type DeliverRenderedReplyParams = {
  callbackUrl: string;
  chatId: string;
  textSegments: string[];
  fallbackText?: string;
  attachments?: RuntimeAttachmentMetadata[];
  assistantId?: string;
  interSegmentDelayMs?: number;
  /** Skip segments already delivered on a previous attempt. */
  startFromSegment?: number;
  /** Called after each segment is successfully delivered, with the
   *  1-based count of segments delivered so far (including prior attempts). */
  onSegmentDelivered?: (deliveredCount: number) => void;
  /**
   * Restricts the reply to one reader. Absent means the whole room sees it.
   * A restricted reply is fire-and-forget: it cannot be edited or deleted
   * after posting.
   */
  audience?: MessageAudience;
  /** When provided, the first segment will update the existing message
   *  identified by this ts instead of posting a new one (Slack-specific). */
  messageTs?: string;
  /** Called with the ts of the delivered/updated message so callers
   *  can use it for subsequent updates. Awaited when it returns a promise,
   *  so an async handler (the sent-message-id reconciler) completes its
   *  durable write before the next segment posts. */
  onMessageTs?: (ts: string) => void | Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns true when any segment carries a `<no_response/>` sentinel. */
function hasNoResponseMarker(textSegments: string[]): boolean {
  return textSegments.some(containsNoResponseMarker);
}

function toDeliverableTextSegments(
  textSegments: string[],
  fallbackText?: string,
): string[] {
  // Hide the sentinel itself, never the content around it: strip every
  // occurrence from mixed segments so a reply the model wrapped around a
  // stray <no_response/> still reaches the user, and the raw sentinel never
  // leaks into the channel as visible text.
  const nonEmptySegments = textSegments
    .map((segment) => {
      const stripped = stripVellumLinks(segment);
      return containsNoResponseMarker(stripped)
        ? stripNoResponseMarkers(stripped)
        : stripped;
    })
    .filter((segment) => segment.trim().length > 0);
  if (nonEmptySegments.length > 0) {
    return nonEmptySegments;
  }
  // If the only text was <no_response/>, treat as intentional silence —
  // do not fall back to fallbackText.
  if (hasNoResponseMarker(textSegments)) {
    return [];
  }
  if (typeof fallbackText === "string") {
    const fallback = stripNoResponseMarkers(fallbackText);
    if (fallback.length > 0) {
      return [fallback];
    }
  }
  return [];
}

/**
 * A reply worth delivering on its own merits: real text after sentinel
 * stripping, or attachments. A bare `<no_response/>` row does NOT count —
 * even when it carries attachments, since `deliverRenderedReplyViaCallback`
 * suppresses attachment delivery for marker rows; counting such a row as
 * real would stop the turn scan on a row that delivers nothing.
 */
function hasRealDeliverableReply(
  rendered: RenderedHistoryContent,
  attachments: RuntimeAttachmentMetadata[],
): boolean {
  if (
    toDeliverableTextSegments(rendered.textSegments, rendered.text).length > 0
  ) {
    return true;
  }
  return attachments.length > 0 && !hasNoResponseMarker(rendered.textSegments);
}

/**
 * A reply whose delivery is a terminal outcome: real content, or a bare
 * `<no_response/>` sentinel whose "delivery" is deliberate silence. The
 * unbounded fallback scan stops at either so a silence marker can never be
 * skipped in favor of re-delivering an older turn's reply.
 */
function hasDeliverableReply(
  rendered: RenderedHistoryContent,
  attachments: RuntimeAttachmentMetadata[],
): boolean {
  return (
    hasRealDeliverableReply(rendered, attachments) ||
    hasNoResponseMarker(rendered.textSegments)
  );
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
    interSegmentDelayMs = INTER_SEGMENT_DELAY_MS,
    startFromSegment = 0,
    onSegmentDelivered,
    audience,
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
          audience,
        },
      );
      if (result.ts) {
        await onMessageTs?.(result.ts);
      }
    }
    return;
  }

  if (startFromSegment >= deliverableSegments.length) {
    if (replyAttachments) {
      const result: ChannelDeliveryResult = await deliverChannelReply(
        callbackUrl,
        {
          chatId,
          attachments: replyAttachments,
          assistantId,
          audience,
        },
      );
      const deliveredTs = result.ts ?? messageTs;
      if (deliveredTs) {
        await onMessageTs?.(deliveredTs);
      }
    } else if (messageTs) {
      await onMessageTs?.(messageTs);
    }
    return;
  }

  // Only the first segment uses messageTs for in-place update;
  // subsequent segments are posted as new messages.
  let currentMessageTs = messageTs;

  for (let i = startFromSegment; i < deliverableSegments.length; i++) {
    const isLastSegment = i === deliverableSegments.length - 1;
    const isFirstSegment = i === startFromSegment;
    const segmentText = deliverableSegments[i];
    // Ask the channel to render richly; each channel's adapter decides how
    // (Slack to Block Kit). Channels without rich rendering send plain text.
    const segmentAttachments = isLastSegment ? replyAttachments : undefined;
    const editTarget = isFirstSegment ? currentMessageTs : undefined;

    let result: ChannelDeliveryResult;
    if (editTarget) {
      result = await editChannelMessage(callbackUrl, {
        chatId,
        messageId: editTarget,
        text: segmentText,
        renderRichly: true,
      });
      // An edit replaces the text of one message. Attachments are always new
      // messages, so they still have to be posted alongside it.
      //
      // Failures here are not the reply failing. A transport rejects a total
      // attachment failure only when there is no text to fall back on, and the
      // edit above already delivered the text. Rethrowing would mark a reply
      // undelivered that the reader can see, and have the sweep repost it.
      if (segmentAttachments) {
        try {
          await deliverChannelReply(callbackUrl, {
            chatId,
            attachments: segmentAttachments,
            assistantId,
            audience,
          });
        } catch (err) {
          log.warn(
            { err, chatId },
            "Attachments failed after an in-place edit; the edited text stands",
          );
        }
      }
    } else {
      result = await deliverChannelReply(callbackUrl, {
        chatId,
        text: segmentText,
        renderRichly: true,
        attachments: segmentAttachments,
        assistantId,
        audience,
      });
    }

    if (result.ts) {
      currentMessageTs = result.ts;
      await onMessageTs?.(result.ts);
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
  /** Persisted assistant message row to deliver; defaults to latest assistant. */
  messageId?: string;
  /**
   * Internal conversation message id for the user row that started this
   * delivery. When set, fallback scans never cross into older turns.
   */
  sinceMessageId?: string;
  startFromSegment?: number;
  onSegmentDelivered?: (deliveredCount: number) => void;
  /** Restricts the reply to one reader. Absent means the whole room. */
  audience?: MessageAudience;
  /** Update an existing message instead of posting a new one. */
  messageTs?: string;
  /** Called with the ts of the delivered/updated message. Awaited when it
   *  returns a promise. */
  onMessageTs?: (ts: string) => void | Promise<void>;
};

type PersistedMessage = ReturnType<typeof getMessages>[number];

/**
 * A row read that contributes nothing to deliver. Spelled out rather than
 * rendered from empty content so the read stays independent of the renderer;
 * the annotation is what keeps it complete as the shape grows.
 */
const NO_REPLY_CONTENT: RenderedHistoryContent = {
  text: "",
  toolCalls: [],
  toolCallsBeforeText: false,
  textSegments: [],
  contentOrder: [],
  surfaces: [],
  thinkingSegments: [],
  attachments: [],
  contentBlocks: [],
};

/**
 * Read a persisted assistant row as a candidate channel reply.
 *
 * A reaction row reads as empty on purpose. Its `"[reaction]"` body is a
 * storage sentinel for an emoji the react tool already delivered to the
 * channel, not speech the turn owes anyone, and the row is drained at the
 * turn boundary, so it is the newest assistant row of any turn that
 * reacted. Read literally, its non-empty text counts as a real deliverable
 * reply and outranks the turn's actual reply (or its `<no_response/>`
 * silence) in every newest-first scan below, posting the raw sentinel to the
 * channel as visible text. Reading it as empty is what makes a reaction-only
 * turn silent, and it is the one seam every delivery path shares: the turn
 * scan, the unbounded fallback sweep, and the targeted `messageId` path,
 * which needs it too because the sweep durably stores whatever the scan
 * returns. The history renderers project these rows as a structured reaction
 * fact for the same reason; delivery owes the channel nothing for them.
 */
function readPersistedAssistantReply(msg: PersistedMessage): {
  rendered: RenderedHistoryContent;
  replyAttachments: RuntimeAttachmentMetadata[];
} {
  if (isReactionMessageMetadata(parseMessageMetadata(msg.metadata))) {
    return { rendered: NO_REPLY_CONTENT, replyAttachments: [] };
  }

  const parsed: unknown = msg.content;
  const rendered = renderHistoryContent(parsed);

  const linked = getAttachmentMetadataForMessage(msg.id);
  const replyAttachments: RuntimeAttachmentMetadata[] = linked.map((a) => ({
    id: a.id,
    filename: a.originalFilename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    kind: a.kind,
  }));

  return { rendered, replyAttachments };
}

function isToolResultUserMessage(msg: PersistedMessage): boolean {
  if (msg.role !== "user") {
    return false;
  }
  try {
    const parsed = msg.content as unknown;
    return (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (block) =>
          block !== null &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_result",
      )
    );
  } catch {
    return false;
  }
}

export function findAssistantReplyMessageIdForTurn(
  conversationId: string,
  userMessageId: string,
): string | undefined {
  const msgs = getMessages(conversationId);
  const userIndex = msgs.findIndex((msg) => msg.id === userMessageId);
  if (userIndex === -1) {
    return undefined;
  }

  let turnEndIndex = msgs.length;
  for (let i = userIndex + 1; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role === "user" && !isToolResultUserMessage(msg)) {
      turnEndIndex = i;
      break;
    }
  }

  let sentinelRowId: string | undefined;
  for (let i = turnEndIndex - 1; i > userIndex; i--) {
    const msg = msgs[i];
    if (msg.role === "assistant") {
      const { rendered, replyAttachments } = readPersistedAssistantReply(msg);
      if (hasRealDeliverableReply(rendered, replyAttachments)) {
        return msg.id;
      }
      if (
        sentinelRowId === undefined &&
        hasNoResponseMarker(rendered.textSegments)
      ) {
        sentinelRowId = msg.id;
      }
    }
  }
  // Silence means the turn produced no real reply text anywhere — not "the
  // last row was a sentinel". Only when no row in the turn carries real
  // content does the bare <no_response/> row become the reply; delivering it
  // suppresses all output as deliberate silence.
  return sentinelRowId;
}

async function deliverPersistedAssistantMessageViaCallback(
  msg: PersistedMessage,
  externalChatId: string,
  callbackUrl: string,
  assistantId: string | undefined,
  options: DeliverReplyOptions | undefined,
  preRead?: ReturnType<typeof readPersistedAssistantReply>,
): Promise<boolean> {
  const { rendered, replyAttachments } =
    preRead ?? readPersistedAssistantReply(msg);
  if (!hasDeliverableReply(rendered, replyAttachments)) {
    return false;
  }

  // Compose an `onMessageTs` that reconciles the persisted assistant row's
  // provider message ids as the transport reports the authoritative ones.
  // The assistant row is written BEFORE the gateway POST, so its pre-send
  // envelope lacks the `messageId` a later reaction or delete naming it
  // resolves by. A reply split into several segments reports one id per
  // posted provider message, all reconciled onto this one row; see
  // `makeSentMessageIdReconciler`.
  const reconcileOnMessageTs = makeSentMessageIdReconciler(msg.id);
  const callerOnMessageTs = options?.onMessageTs;
  const composedOnMessageTs = async (ts: string): Promise<void> => {
    await reconcileOnMessageTs(ts);
    await callerOnMessageTs?.(ts);
  };

  await deliverRenderedReplyViaCallback({
    callbackUrl,
    chatId: externalChatId,
    textSegments: rendered.textSegments,
    fallbackText: rendered.text,
    attachments: replyAttachments,
    assistantId,
    startFromSegment: options?.startFromSegment,
    onSegmentDelivered: options?.onSegmentDelivered,
    audience: options?.audience,
    messageTs: options?.messageTs,
    onMessageTs: composedOnMessageTs,
  });
  return true;
}

export async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  assistantId?: string,
  options?: DeliverReplyOptions,
): Promise<void> {
  if (options?.messageId) {
    const msg = getMessageById(options.messageId, conversationId);
    if (!msg || msg.role !== "assistant") {
      throw new Error(
        `Target assistant reply message not found: ${options.messageId}`,
      );
    }
    // The targeted row is usually the turn's final assistant row, but a bare
    // <no_response/> or tool-only final row is not necessarily the turn's
    // reply — the model may have written the real reply in an earlier row of
    // the same turn. When the turn boundary is known, defer to the turn scan
    // below; it returns this same sentinel row (deliberate silence) only when
    // no row in the turn carries real content.
    const preRead = readPersistedAssistantReply(msg);
    if (
      hasRealDeliverableReply(preRead.rendered, preRead.replyAttachments) ||
      !options.sinceMessageId
    ) {
      await deliverPersistedAssistantMessageViaCallback(
        msg,
        externalChatId,
        callbackUrl,
        assistantId,
        options,
        preRead,
      );
      return;
    }
  }

  if (options?.sinceMessageId) {
    const replyMessageId = findAssistantReplyMessageIdForTurn(
      conversationId,
      options.sinceMessageId,
    );
    if (replyMessageId) {
      const msg = getMessageById(replyMessageId, conversationId);
      if (msg && msg.role === "assistant") {
        await deliverPersistedAssistantMessageViaCallback(
          msg,
          externalChatId,
          callbackUrl,
          assistantId,
          options,
        );
      }
    }
    return;
  }

  const msgs = getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") {
      continue;
    }
    const delivered = await deliverPersistedAssistantMessageViaCallback(
      msgs[i],
      externalChatId,
      callbackUrl,
      assistantId,
      options,
    );
    if (delivered) {
      break;
    }
  }
}
