/**
 * Shared helpers for resolving Slack channel display names and links.
 * Used by both SlackChannelFooter and SpectatorBar.
 */

import { useEffect, useState } from "react";

import type {
  Conversation,
  ConversationChannelBinding,
} from "@/domains/chat/api/conversations.js";
import { resolveSlackChannelName } from "@/domains/chat/api/slack-channel-name.js";
import {
  getSlackLinkUrl,
  type DisplayMessage,
  type SlackMessageLink,
} from "@/domains/chat/types/types.js";

export type SlackConversationLike = Pick<
  Conversation,
  "channelBinding" | "originChannel"
> &
  Partial<Pick<Conversation, "conversationKey">>;

export function getSlackChannelLink(
  slackChannel: ConversationChannelBinding["slackChannel"],
  messageLink?: SlackMessageLink,
  channelId?: string,
): string | undefined {
  if (slackChannel?.link) {
    if (typeof slackChannel.link === "string") return slackChannel.link;
    return getSlackLinkUrl(slackChannel.link);
  }
  return getSlackChannelLinkFromMessageLink(messageLink, channelId);
}

function getSlackChannelLinkFromMessageLink(
  messageLink: SlackMessageLink | undefined,
  channelId: string | undefined,
): string | undefined {
  if (!messageLink || !channelId) return undefined;

  if (messageLink.webUrl) {
    try {
      const url = new URL(messageLink.webUrl);
      const channelPath = `/archives/${channelId}`;
      if (url.pathname.startsWith(`${channelPath}/`)) {
        url.pathname = channelPath;
        url.search = "";
        url.hash = "";
        return url.toString();
      }
    } catch {
      // Fall through to app URL parsing.
    }
  }

  if (!messageLink.appUrl) return undefined;
  try {
    const url = new URL(messageLink.appUrl);
    if (url.protocol !== "slack:" || url.hostname !== "channel") {
      return undefined;
    }
    const team = url.searchParams.get("team");
    if (!team || url.searchParams.get("id") !== channelId) {
      return undefined;
    }
    return `slack://channel?${new URLSearchParams({
      team,
      id: channelId,
    }).toString()}`;
  } catch {
    return undefined;
  }
}

export function getSlackMessageChannel(
  messages: DisplayMessage[] | undefined,
  channelId: string | undefined,
) {
  if (!messages || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const slackMessage = messages[i]?.slackMessage;
    if (!slackMessage) continue;
    if (channelId && slackMessage.channelId !== channelId) continue;
    return slackMessage;
  }
  return undefined;
}

export function isChannelIdFallback(
  value: string | undefined,
  channelBinding: ConversationChannelBinding,
): boolean {
  return (
    value === undefined ||
    value === channelBinding.externalChatId ||
    value === channelBinding.slackChannel?.channelId ||
    value === channelBinding.slackChannel?.id
  );
}

export function getSlackChannelDisplayText(
  channelBinding: ConversationChannelBinding,
  fallbackChannelName?: string,
): string | undefined {
  const slackChannel = channelBinding.slackChannel;
  const primaryName = slackChannel?.name ?? channelBinding.externalChatName;

  if (!isChannelIdFallback(primaryName, channelBinding)) {
    return primaryName;
  }
  if (
    fallbackChannelName &&
    !isChannelIdFallback(fallbackChannelName, channelBinding)
  ) {
    return fallbackChannelName;
  }

  return (
    slackChannel?.channelId ??
    slackChannel?.id ??
    channelBinding.externalChatId
  );
}

function isSlackDmChannelId(channelId: string | undefined): boolean {
  return channelId?.startsWith("D") === true;
}

const slackChannelNameRequests = new Map<string, Promise<string | null>>();

export interface SlackChannelResolution {
  channelBinding: ConversationChannelBinding | undefined;
  channelId: string | undefined;
  displayText: string | undefined;
  href: string | undefined;
}

export function useSlackChannelResolution(
  assistantId: string | undefined,
  conversation: SlackConversationLike | null | undefined,
  messages: DisplayMessage[] | undefined,
): SlackChannelResolution {
  const [resolvedChannelName, setResolvedChannelName] = useState<{
    key: string;
    channelName: string;
  } | null>(null);

  const channelBinding =
    conversation?.originChannel === "slack"
      ? conversation.channelBinding
      : undefined;
  const slackChannel = channelBinding?.slackChannel;
  const channelId =
    slackChannel?.channelId ??
    slackChannel?.id ??
    channelBinding?.externalChatId;
  const messageChannel = getSlackMessageChannel(messages, channelId);
  const fallbackDisplayText = channelBinding
    ? getSlackChannelDisplayText(channelBinding, messageChannel?.channelName)
    : undefined;
  const conversationId = conversation?.conversationKey;
  const resolutionKey =
    assistantId && conversationId && channelId
      ? `${assistantId}:${conversationId}:${channelId}`
      : undefined;
  const shouldResolveChannelName =
    Boolean(assistantId && conversationId && channelId && channelBinding) &&
    !isSlackDmChannelId(channelId) &&
    channelBinding !== undefined &&
    isChannelIdFallback(fallbackDisplayText, channelBinding);

  useEffect(() => {
    if (
      !shouldResolveChannelName ||
      !assistantId ||
      !conversationId ||
      !channelId ||
      !resolutionKey
    ) {
      return;
    }

    let cancelled = false;
    let request = slackChannelNameRequests.get(resolutionKey);

    if (!request) {
      request = resolveSlackChannelName(assistantId, conversationId).then(
        (result) => {
          if (
            !result?.resolved ||
            result.channelId !== channelId ||
            !result.channelName
          ) {
            return null;
          }
          return result.channelName;
        },
      );
      slackChannelNameRequests.set(resolutionKey, request);
      request.finally(() => {
        if (slackChannelNameRequests.get(resolutionKey) === request) {
          slackChannelNameRequests.delete(resolutionKey);
        }
      });
    }

    request.then((channelName) => {
      if (!cancelled && channelName) {
        setResolvedChannelName({ key: resolutionKey, channelName });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    assistantId,
    channelId,
    conversationId,
    resolutionKey,
    shouldResolveChannelName,
  ]);

  const resolvedDisplayText =
    resolutionKey && resolvedChannelName?.key === resolutionKey
      ? resolvedChannelName.channelName
      : undefined;
  const displayText =
    channelBinding && !isChannelIdFallback(fallbackDisplayText, channelBinding)
      ? fallbackDisplayText
      : (resolvedDisplayText ?? fallbackDisplayText);
  const href = getSlackChannelLink(
    slackChannel,
    messageChannel?.messageLink,
    channelId,
  );

  return { channelBinding, channelId, displayText, href };
}
