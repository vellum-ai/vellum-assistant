import { ExternalLink, Hash, Info, MessageCircle } from "lucide-react";

import type { Conversation } from "@/types/conversation-types";
import { type DisplayMessage } from "@/domains/chat/types/types";
import { useSlackConversationDisplay } from "@/domains/chat/hooks/use-slack-conversation-display";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { getChannelBindingDisplayText } from "@/domains/chat/utils/channel-conversation-display";
import {
  ChannelIcon,
  getChannelReadonlyCopy,
} from "@/utils/channel-presentation";

type ChannelFooterConversation = Pick<
  Conversation,
  "channelBinding" | "originChannel"
> &
  Partial<Pick<Conversation, "conversationId">>;

export interface ChannelReadonlyFooterProps {
  assistantId?: string;
  conversation: ChannelFooterConversation | null | undefined;
  messages?: DisplayMessage[];
}

/**
 * Read-only footer shown beneath a conversation that originated from an
 * external channel (Slack, Telegram, WhatsApp, phone, …). Replaces the
 * composer for these conversations because the daemon does not mirror
 * outbound writes back to the source channel.
 *
 * Channel-agnostic by design (the "adapter" pattern that started with
 * Slack): the read-only label and icon come from the channel-presentation
 * registry, so adding a channel needs no change here.
 *
 * Slack keeps its richer display — channel-vs-DM detection, lazy channel
 * name resolution, and a deep link back to the message — via
 * {@link useSlackConversationDisplay}. Other channels derive a best-effort
 * name from the generic binding fields and currently have no message-level
 * deep link (Telegram/WhatsApp do not expose the data needed to build one),
 * so the "Open in …" action is shown only when a link is available.
 */
export function ChannelReadonlyFooter({
  assistantId,
  conversation,
  messages,
}: ChannelReadonlyFooterProps) {
  // Hooks must run unconditionally. `useSlackConversationDisplay` returns
  // null (and performs no network work) for non-Slack conversations.
  const slackDisplay = useSlackConversationDisplay({
    assistantId,
    conversation,
    messages,
  });

  if (!isChannelConversation(conversation)) return null;

  const channelId = conversation?.originChannel;
  const { label, message } = getChannelReadonlyCopy(channelId);

  // Slack carries a richer display (channel vs DM, lazy name, deep link);
  // other channels derive a best-effort name from the generic binding.
  const slack = channelId === "slack" ? slackDisplay : null;
  const displayText = slack
    ? slack.displayText
    : getChannelBindingDisplayText(conversation?.channelBinding);
  const href = slack ? slack.href : undefined;
  const secondaryIcon = slack ? (
    slack.isDm ? (
      <MessageCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    ) : (
      <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    )
  ) : (
    <ChannelIcon channelId={channelId} className="h-3.5 w-3.5 shrink-0" />
  );

  return (
    <div className="mb-2 flex min-h-9 items-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-body-small-default text-[var(--content-tertiary)]">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate leading-5">{message}</span>
        {displayText ? (
          <span className="hidden min-w-0 shrink items-center gap-1.5 text-[var(--content-secondary)] sm:inline-flex">
            {secondaryIcon}
            <span className="truncate leading-5">{displayText}</span>
          </span>
        ) : null}
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open in ${label}`}
          className="flex h-9 shrink-0 items-center gap-1.5 border-l border-[var(--border-subtle)] px-3 text-[10px] font-semibold uppercase tracking-normal text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
        >
          <span className="hidden sm:inline">Open in {label}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}
