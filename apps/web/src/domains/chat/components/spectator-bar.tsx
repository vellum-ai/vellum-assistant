import { Eye, ExternalLink, Hash, Square } from "lucide-react";

import { Button } from "@vellum/design-library";
import type { DisplayMessage } from "@/domains/chat/types/types.js";
import {
  useSlackChannelResolution,
  type SlackConversationLike,
} from "@/domains/chat/utils/slack-channel-helpers.js";

export interface SpectatorBarProps {
  assistantName?: string;
  assistantId?: string;
  conversation: SlackConversationLike | null | undefined;
  messages?: DisplayMessage[];
  canStopGenerating?: boolean;
  onStopGenerating: () => void;
}

export function SpectatorBar({
  assistantName,
  assistantId,
  conversation,
  messages,
  canStopGenerating = false,
  onStopGenerating,
}: SpectatorBarProps) {
  const { displayText: channelDisplayText, href } = useSlackChannelResolution(
    assistantId,
    conversation,
    messages,
  );

  return (
    <div className="flex items-center justify-center gap-3 border-t border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
        <Eye size={14} className="shrink-0" />
        <span className="truncate">
          Watching
          {assistantName && (
            <>
              {" "}
              <span className="text-[var(--content-secondary)]">
                {assistantName}
              </span>
            </>
          )}
          {channelDisplayText && (
            <>
              {" in "}
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--content-secondary)] underline-offset-2 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Hash className="inline h-3 w-3 shrink-0" aria-hidden />
                  <span className="overflow-hidden text-ellipsis">
                    {channelDisplayText}
                  </span>
                  <ExternalLink
                    className="inline h-3 w-3 shrink-0"
                    aria-hidden
                  />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 text-[var(--content-secondary)]">
                  <Hash className="inline h-3 w-3 shrink-0" aria-hidden />
                  <span className="overflow-hidden text-ellipsis">
                    {channelDisplayText}
                  </span>
                </span>
              )}
            </>
          )}
        </span>
      </div>
      {canStopGenerating && (
        <Button
          variant="primary"
          iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
          onClick={onStopGenerating}
          aria-label="Stop generating"
          title="Stop generation"
        />
      )}
    </div>
  );
}
