import { useEffect, useState } from "react";

import { ExternalLink, Hash, Info, MessageCircle } from "lucide-react";

import { resolveSlackChannelName } from "@/domains/chat/api/slack-channel-name";
import type { Conversation } from "@/types/conversation-types";
import {
  getSlackConversationDisplay,
  shouldResolveSlackConversationDisplayName,
} from "@/domains/chat/utils/slack-conversation-display";
import { type DisplayMessage } from "@/domains/chat/types/types";

type SlackFooterConversation = Pick<
  Conversation,
  "channelBinding" | "originChannel"
> &
  Partial<Pick<Conversation, "conversationId">>;

export interface SlackChannelFooterProps {
  assistantId?: string;
  conversation: SlackFooterConversation | null | undefined;
  messages?: DisplayMessage[];
}

const slackChannelNameRequests = new Map<string, Promise<string | null>>();

export function SlackChannelFooter({
  assistantId,
  conversation,
  messages,
}: SlackChannelFooterProps) {
  const [resolvedChannelName, setResolvedChannelName] = useState<{
    key: string;
    channelName: string;
  } | null>(null);

  const unresolvedDisplay = getSlackConversationDisplay({
    conversation,
    messages,
  });
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
  const display = getSlackConversationDisplay({
    conversation,
    messages,
    resolvedChannelName: resolvedDisplayText,
  });
  if (!display) return null;

  const LabelIcon = display.isDm ? MessageCircle : Hash;

  return (
    <div className="mb-2 flex min-h-9 items-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-body-small-default text-[var(--content-tertiary)]">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate leading-5">
          This Slack conversation is read-only. You can reply in Slack.
        </span>
        <span className="hidden min-w-0 shrink items-center gap-1.5 text-[var(--content-secondary)] sm:inline-flex">
          <LabelIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate leading-5">{display.displayText}</span>
        </span>
      </div>
      {display.href ? (
        <a
          href={display.href}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in Slack"
          className="flex h-9 shrink-0 items-center gap-1.5 border-l border-[var(--border-subtle)] px-3 text-[10px] font-semibold uppercase tracking-normal text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
        >
          <span className="hidden sm:inline">Open in Slack</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}
