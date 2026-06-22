/**
 * Typed transforms from daemon conversation responses to the client-side
 * `Conversation` shape.
 *
 * `toConversation` maps the generated `RawConversationSummary` (from the
 * daemon's list endpoint) into `Conversation`. `detailToConversation` does
 * the same for the single-conversation detail response.
 *
 * These transforms are the only place where daemon → client field mapping
 * happens: `id` → `conversationId`, attention flattening, `originChannel`
 * coalescing. Timestamps pass through as epoch-ms numbers.
 */

import type {
  ConversationsByIdGetResponse,
  ConversationsGetResponse,
} from "@/generated/daemon/types.gen";
import type {
  Conversation,
  ConversationChannelBinding,
} from "@/types/conversation-types";

/** Single conversation row from the generated daemon SDK response. */
export type RawConversationSummary =
  ConversationsGetResponse["conversations"][number];

/** Single conversation detail from the generated daemon SDK response. */
export type RawConversationDetail =
  ConversationsByIdGetResponse["conversation"];

function asNumber(value: number | unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: string | unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapChannelBinding(
  raw: RawConversationSummary["channelBinding"],
): ConversationChannelBinding | undefined {
  if (!raw) return undefined;
  return {
    sourceChannel: raw.sourceChannel,
    externalChatId: raw.externalChatId,
    externalThreadId: raw.externalThreadId,
    externalChatName: raw.externalChatName,
    externalUserId: asString(raw.externalUserId),
    displayName: asString(raw.displayName),
    username: asString(raw.username),
    slackChannel: raw.slackChannel
      ? {
          channelId: raw.slackChannel.channelId,
          name: raw.slackChannel.name,
          link: raw.slackChannel.link?.webUrl
            ? { webUrl: raw.slackChannel.link.webUrl }
            : undefined,
        }
      : undefined,
    slackThread: raw.slackThread
      ? {
          channelId: raw.slackThread.channelId,
          threadTs: raw.slackThread.threadTs,
          link:
            raw.slackThread.link?.appUrl || raw.slackThread.link?.webUrl
              ? {
                  appUrl: raw.slackThread.link.appUrl,
                  webUrl: raw.slackThread.link.webUrl,
                }
              : undefined,
        }
      : undefined,
  };
}

/**
 * Transform a typed daemon conversation summary into the client-side
 * `Conversation` shape. Handles `id` → `conversationId` rename,
 * attention field flattening, and `originChannel` coalescing.
 * Timestamps pass through as epoch-ms numbers.
 */
export function toConversation(raw: RawConversationSummary): Conversation {
  const attention = raw.assistantAttention;
  const originChannel =
    raw.channelBinding?.sourceChannel ??
    asString(raw.conversationOriginChannel);

  return {
    conversationId: raw.id,
    title: raw.title,
    createdAt: asNumber(raw.createdAt),
    lastMessageAt: asNumber(raw.lastMessageAt ?? raw.updatedAt),
    hasUnseenLatestAssistantMessage:
      attention?.hasUnseenLatestAssistantMessage,
    latestAssistantMessageAt: asNumber(attention?.latestAssistantMessageAt),
    lastSeenAssistantMessageAt: asNumber(
      attention?.lastSeenAssistantMessageAt,
    ),
    archivedAt: raw.archivedAt,
    surfacedAt: asNumber(raw.surfacedAt),
    groupId: asString(raw.groupId),
    source: raw.source,
    isPinned: raw.isPinned,
    conversationType: raw.conversationType,
    scheduleJobId: raw.scheduleJobId,
    displayOrder: asNumber(raw.displayOrder),
    channelBinding: mapChannelBinding(raw.channelBinding),
    originChannel,
    isProcessing: raw.isProcessing,
  };
}

/**
 * Transform a typed daemon conversation detail into the client-side
 * `Conversation` shape. The detail and summary types share the same
 * structure from the daemon serializer.
 */
export function detailToConversation(
  raw: RawConversationDetail,
): Conversation {
  return toConversation(raw as RawConversationSummary);
}
