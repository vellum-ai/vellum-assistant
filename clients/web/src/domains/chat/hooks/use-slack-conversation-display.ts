import { useEffect, useMemo, useState } from "react";

import { resolveSlackChannelName } from "@/domains/chat/api/slack-channel-name";
import {
  getSlackConversationDisplay,
  shouldResolveSlackConversationDisplayName,
  type SlackConversationDisplay,
  type SlackDisplayConversation,
} from "@/domains/chat/utils/slack-conversation-display";
import type { DisplayMessage } from "@/domains/chat/types/types";

type SlackConversationDisplayInput = {
  assistantId?: string;
  conversation:
    | (SlackDisplayConversation & { conversationId?: string })
    | null
    | undefined;
  messages?: DisplayMessage[];
};

const slackChannelNameRequests = new Map<string, Promise<string | null>>();

export function useSlackConversationDisplay({
  assistantId,
  conversation,
  messages,
}: SlackConversationDisplayInput): SlackConversationDisplay | null {
  const [resolvedChannelName, setResolvedChannelName] = useState<{
    key: string;
    channelName: string;
  } | null>(null);

  const unresolvedDisplay = useMemo(
    () => getSlackConversationDisplay({ conversation, messages }),
    [conversation, messages],
  );
  const channelId = unresolvedDisplay?.channelId;
  const conversationId = conversation?.conversationId;
  const resolutionKey =
    assistantId && conversationId && channelId
      ? `${assistantId}:${conversationId}:${channelId}`
      : undefined;
  const shouldResolveChannelName =
    Boolean(assistantId && conversationId && channelId) &&
    shouldResolveSlackConversationDisplayName(unresolvedDisplay);

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

  return useMemo(
    () =>
      getSlackConversationDisplay({
        conversation,
        messages,
        resolvedChannelName: resolvedDisplayText,
      }),
    [conversation, messages, resolvedDisplayText],
  );
}
