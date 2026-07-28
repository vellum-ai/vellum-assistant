/**
 * Slack's resolver for guardian approval source references.
 *
 * The exact provenance stamped at ingress (chat id + message `ts` on the
 * turn's trust context) identifies the precise triggering message and wins
 * outright when present. Turns without a stamped context (voice, retries)
 * fall back to reconstruction from persisted rows: `channel_inbound_events`
 * records each inbound message's chat id and `ts`, and the conversation's
 * channel binding carries the thread `ts` for threaded conversations.
 * Best-effort by design — a miss degrades to a card without a link, never a
 * failed approval.
 *
 * Registered under `"slack"` in the channel-neutral resolver registry in
 * `runtime/approval-source-link.ts`; only that registry should call this
 * directly.
 */

import { getLatestInboundEventReference } from "../../../persistence/delivery-crud.js";
import { getBindingByConversation } from "../../../persistence/external-conversation-store.js";
import type {
  ApprovalSourceHint,
  ApprovalSourceReference,
} from "../../../runtime/approval-source-link.js";
import { buildSlackPermalink } from "./deep-link.js";
import { isSlackTs } from "./message-metadata.js";

function toReference(
  chatId: string,
  messageTs: string | undefined,
  threadTs: string | undefined,
): ApprovalSourceReference {
  // Without a message ts, the thread root is still a valid anchor.
  const anchorTs = messageTs ?? threadTs;
  if (!anchorTs) {
    return { sourceChatId: chatId };
  }
  return {
    sourceChatId: chatId,
    sourceLink: {
      webUrl: buildSlackPermalink({
        channelId: chatId,
        messageTs: anchorTs,
        threadTs,
      }),
    },
  };
}

export function resolveSlackApprovalSource(
  conversationId: string,
  hint: ApprovalSourceHint | undefined,
): ApprovalSourceReference | null {
  // Exact provenance from the turn's trust context. An absent thread id here
  // is authoritative (the message arrived at the chat root), so no binding
  // lookup is needed.
  if (hint?.requesterChatId && isSlackTs(hint.sourceMessageId)) {
    return toReference(
      hint.requesterChatId,
      hint.sourceMessageId,
      isSlackTs(hint.sourceThreadId) ? hint.sourceThreadId : undefined,
    );
  }

  const inbound = getLatestInboundEventReference(conversationId, "slack");
  const rawBinding = getBindingByConversation(conversationId);
  const binding = rawBinding?.sourceChannel === "slack" ? rawBinding : null;

  const chatId =
    hint?.requesterChatId ?? inbound?.externalChatId ?? binding?.externalChatId;
  if (!chatId) {
    return null;
  }

  // `sourceMessageId` records the ts explicitly; the dedupe id is a usable
  // fallback only when it is itself ts-shaped (mirrors the slackMeta write in
  // `inbound-message-handler.ts`).
  const messageTs = isSlackTs(inbound?.sourceMessageId)
    ? inbound.sourceMessageId
    : isSlackTs(inbound?.externalMessageId)
      ? inbound.externalMessageId
      : undefined;
  const threadTs = isSlackTs(binding?.externalThreadId)
    ? binding.externalThreadId
    : undefined;

  return toReference(chatId, messageTs, threadTs);
}
