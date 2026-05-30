import type {
  Conversation,
  ConversationChannelBinding,
} from "@/types/conversation-types";
import {
  getSlackLinkUrl,
  type DisplayMessage,
  type SlackMessageLink,
} from "@/domains/chat/types/types";

export type SlackDisplayConversation = Pick<
  Conversation,
  "channelBinding" | "originChannel"
>;

type SlackMessageChannel = NonNullable<DisplayMessage["slackMessage"]>;

export interface SlackConversationDisplay {
  channelBinding: ConversationChannelBinding;
  channelId: string | undefined;
  displayText: string;
  href: string | undefined;
  isDm: boolean;
  isFallback: boolean;
}

export function getSlackConversationDisplay({
  conversation,
  messages,
  resolvedChannelName,
}: {
  conversation: SlackDisplayConversation | null | undefined;
  messages?: DisplayMessage[];
  resolvedChannelName?: string;
}): SlackConversationDisplay | null {
  const channelBinding =
    conversation?.originChannel === "slack"
      ? conversation.channelBinding
      : undefined;
  if (!channelBinding) return null;

  const slackChannel = channelBinding.slackChannel;
  const channelId = slackChannel?.channelId ?? channelBinding.externalChatId;
  const messageChannel = getSlackMessageChannel(messages, channelId);
  const isDm = isSlackDmChannelId(channelId);
  const channelDisplayText = getSlackChannelDisplayText(
    channelBinding,
    messageChannel?.channelName,
  );
  const friendlyChannelName =
    channelDisplayText && !isChannelIdFallback(channelDisplayText, channelBinding)
      ? channelDisplayText
      : undefined;
  const fallbackDisplayText =
    getSlackDmDisplayText(
      channelBinding,
      channelId,
      messageChannel,
      friendlyChannelName,
    ) ?? channelDisplayText;

  if (!fallbackDisplayText) return null;

  const resolvedDisplayText =
    resolvedChannelName && !isChannelIdFallback(resolvedChannelName, channelBinding)
      ? resolvedChannelName
      : undefined;
  const displayText = !isChannelIdFallback(fallbackDisplayText, channelBinding)
    ? fallbackDisplayText
    : (resolvedDisplayText ?? fallbackDisplayText);

  return {
    channelBinding,
    channelId,
    displayText,
    href: getSlackConversationLink(channelBinding, messageChannel, channelId),
    isDm,
    isFallback: isChannelIdFallback(displayText, channelBinding),
  };
}

export function shouldResolveSlackConversationDisplayName(
  display: SlackConversationDisplay | null,
): boolean {
  return Boolean(display && !display.isDm && display.isFallback);
}

export function formatSlackConversationDisplayLabel(
  display: Pick<SlackConversationDisplay, "displayText" | "isDm" | "isFallback">,
): string {
  if (display.isDm || display.isFallback) return display.displayText;
  if (display.displayText.startsWith("#")) return display.displayText;
  return `#${display.displayText}`;
}

function getSlackConversationLink(
  channelBinding: ConversationChannelBinding,
  messageChannel: SlackMessageChannel | undefined,
  channelId: string | undefined,
): string | undefined {
  const threadLink = getSlackLinkUrl(channelBinding.slackThread?.link);
  if (threadLink) return threadLink;

  const messageThreadLink = getSlackLinkUrl(messageChannel?.threadLink);
  if (messageThreadLink) return messageThreadLink;

  const messageLink = getSlackLinkUrl(messageChannel?.messageLink);
  if (messageLink) return messageLink;

  return getSlackChannelLink(channelBinding.slackChannel, undefined, channelId);
}

function getSlackChannelLink(
  slackChannel: ConversationChannelBinding["slackChannel"],
  messageLink?: SlackMessageLink,
  channelId?: string,
): string | undefined {
  if (slackChannel?.link) {
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
    value === channelBinding.slackChannel?.channelId
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

  return slackChannel?.channelId ?? channelBinding.externalChatId;
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
