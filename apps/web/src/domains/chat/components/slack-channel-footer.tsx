import { ExternalLink, Hash } from "lucide-react";

import type {
  Conversation,
  ConversationChannelBinding,
} from "@/domains/chat/api/conversations.js";
import {
  getSlackLinkUrl,
  type DisplayMessage,
  type SlackMessageLink,
} from "@/domains/chat/types/types.js";

export interface SlackChannelFooterProps {
  conversation:
    | Pick<Conversation, "channelBinding" | "originChannel">
    | null
    | undefined;
  messages?: DisplayMessage[];
}

function getSlackChannelLink(
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

function getSlackMessageChannel(
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

function isChannelIdFallback(
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

function getSlackChannelDisplayText(
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

export function SlackChannelFooter({
  conversation,
  messages,
}: SlackChannelFooterProps) {
  if (conversation?.originChannel !== "slack" || !conversation.channelBinding) {
    return null;
  }

  const slackChannel = conversation.channelBinding.slackChannel;
  const channelId =
    slackChannel?.channelId ??
    slackChannel?.id ??
    conversation.channelBinding.externalChatId;
  const messageChannel = getSlackMessageChannel(messages, channelId);
  const displayText = getSlackChannelDisplayText(
    conversation.channelBinding,
    messageChannel?.channelName,
  );
  if (!displayText) return null;

  const href = getSlackChannelLink(
    slackChannel,
    messageChannel?.messageLink,
    channelId,
  );
  const content = (
    <>
      <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{displayText}</span>
      {href ? (
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : null}
    </>
  );

  return (
    <div className="mb-2 flex justify-center text-body-small-default text-[var(--content-tertiary)]">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-[var(--content-secondary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {content}
        </a>
      ) : (
        <div className="inline-flex max-w-full items-center gap-1.5 truncate px-1.5 py-1">
          {content}
        </div>
      )}
    </div>
  );
}
