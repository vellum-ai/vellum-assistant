import { ExternalLink, Hash } from "lucide-react";

import {
  type SlackConversationLike,
  useSlackChannelResolution,
} from "@/domains/chat/utils/slack-channel-helpers.js";
import type { DisplayMessage } from "@/domains/chat/types/types.js";

export interface SlackChannelFooterProps {
  assistantId?: string;
  conversation: SlackConversationLike | null | undefined;
  messages?: DisplayMessage[];
}

export function SlackChannelFooter({
  assistantId,
  conversation,
  messages,
}: SlackChannelFooterProps) {
  const { channelBinding, displayText, href } = useSlackChannelResolution(
    assistantId,
    conversation,
    messages,
  );

  if (!channelBinding || !displayText) {
    return null;
  }

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
