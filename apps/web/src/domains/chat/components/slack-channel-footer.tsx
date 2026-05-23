import { useEffect, useState } from "react";

import { ExternalLink, Hash, MessageCircle } from "lucide-react";

import { resolveSlackChannelName } from "@/domains/chat/api/slack-channel-name.js";
import type {
  Conversation,
  ConversationChannelBinding,
} from "@/domains/chat/api/conversations.js";
import {
  getSlackLinkUrl,
  type DisplayMessage,
  type SlackMessageLink,
} from "@/domains/chat/types/types.js";

type SlackFooterConversation = Pick<
  Conversation,
  "channelBinding" | "originChannel"
> &
  Partial<Pick<Conversation, "conversationId">>;
type SlackMessageChannel = NonNullable<DisplayMessage["slackMessage"]>;

export interface SlackChannelFooterProps {
  assistantId?: string;
  conversation: SlackFooterConversation | null | undefined;
  messages?: DisplayMessage[];
}

const slackChannelNameRequests = new Map<string, Promise<string | null>>();

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

function isSlackDmChannelId(channelId: string | undefined): boolean {
  return channelId?.startsWith("D") === true;
}

function cleanLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getSlackDmParticipantName(
  channelBinding: ConversationChannelBinding,
  messageChannel: SlackMessageChannel | undefined,
  friendlyChannelName: string | undefined,
): string | undefined {
  const sender = messageChannel?.sender;
  return (
    cleanLabel(channelBinding.displayName) ??
    cleanLabel(channelBinding.username) ??
    cleanLabel(sender?.displayName) ??
    cleanLabel(sender?.name) ??
    cleanLabel(sender?.username) ??
    friendlyChannelName
  );
}

function getSlackDmDisplayText(
  channelBinding: ConversationChannelBinding,
  channelId: string | undefined,
  messageChannel: SlackMessageChannel | undefined,
  friendlyChannelName: string | undefined,
): string | undefined {
  if (!isSlackDmChannelId(channelId)) return undefined;
  const participantName = getSlackDmParticipantName(
    channelBinding,
    messageChannel,
    friendlyChannelName,
  );
  return participantName ? `DM with ${participantName}` : "Slack DM";
}

export function SlackChannelFooter({
  assistantId,
  conversation,
  messages,
}: SlackChannelFooterProps) {
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
  const isDmChannel = isSlackDmChannelId(channelId);
  const channelDisplayText = channelBinding
    ? getSlackChannelDisplayText(channelBinding, messageChannel?.channelName)
    : undefined;
  const friendlyChannelName =
    channelBinding &&
    channelDisplayText &&
    !isChannelIdFallback(channelDisplayText, channelBinding)
      ? channelDisplayText
      : undefined;
  const fallbackDisplayText = channelBinding
    ? (getSlackDmDisplayText(
        channelBinding,
        channelId,
        messageChannel,
        friendlyChannelName,
      ) ?? channelDisplayText)
    : undefined;
  const conversationId = conversation?.conversationId;
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

  if (!channelBinding) {
    return null;
  }

  const resolvedDisplayText =
    resolutionKey && resolvedChannelName?.key === resolutionKey
      ? resolvedChannelName.channelName
      : undefined;
  const displayText = !isChannelIdFallback(fallbackDisplayText, channelBinding)
    ? fallbackDisplayText
    : (resolvedDisplayText ?? fallbackDisplayText);
  if (!displayText) return null;

  const href = getSlackChannelLink(
    slackChannel,
    messageChannel?.messageLink,
    channelId,
  );
  const LabelIcon = isDmChannel ? MessageCircle : Hash;
  const content = (
    <>
      <LabelIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
