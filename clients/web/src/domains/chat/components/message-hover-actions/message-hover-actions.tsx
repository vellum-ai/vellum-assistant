
import { Bookmark, Check, Copy, ExternalLink, FileCode, GitBranch, SmilePlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Popover } from "@vellumai/design-library";
import {
  hasUserReaction,
  QUICK_REACTION_EMOJI,
  useReactionsSupported,
  useUserReactionToggle,
} from "@/domains/chat/hooks/use-message-reactions";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import {
  useBookmarksEnabled,
  useBookmarkToggle,
  useIsBookmarked,
} from "@/hooks/use-bookmarks";

type MessageHoverActionsProps = {
  /** The message whose text is copied and whose role/timestamp drive the row. */
  message: DisplayMessage;
  /** Conversation the message belongs to. Required for the bookmark toggle —
   *  the bookmark API keys on (messageId, conversationId). */
  conversationId?: string | null;
  /** Slack permalink for the message, shown as a hover action when present. */
  openInSlackUrl?: string;
  /** Callback when "Fork from here" is clicked. */
  onFork?: () => void;
  /** Callback when "Inspect" is clicked. */
  onInspect?: () => void;
};

function formatTimestamp(epoch: number): string {
  const date = new Date(epoch);
  const now = new Date();

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isToday) {
    return `Today, ${timeStr}`;
  }

  const dayStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${dayStr}, ${timeStr}`;
}

function formatDetailedTimestamp(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });
}

/**
 * Latest activity timestamp for a message: the max of the message's own
 * timestamp and any tool-call start/completion times, so the displayed time
 * reflects when the row last did something rather than when it was created.
 */
function latestMessageActivityTimestamp(
  message: DisplayMessage,
): number | undefined {
  const latestToolTimestamp = message.toolCalls?.reduce<number | undefined>(
    (latest, toolCall) => {
      const toolTimestamp = toolCall.completedAt ?? toolCall.startedAt;
      if (toolTimestamp == null) {
        return latest;
      }
      return latest == null ? toolTimestamp : Math.max(latest, toolTimestamp);
    },
    undefined,
  );

  if (latestToolTimestamp == null) {
    return message.timestamp;
  }

  if (message.timestamp == null) {
    return latestToolTimestamp;
  }

  return Math.max(message.timestamp, latestToolTimestamp);
}

export function MessageHoverActions({
  message,
  conversationId,
  openInSlackUrl,
  onFork,
  onInspect,
}: MessageHoverActionsProps) {
  const { role } = message;

  // Bookmarks are feature-flag gated, and only persisted messages qualify —
  // optimistic/streaming rows carry a client-generated id the daemon can't
  // resolve. The toggle's data hooks live in `MessageBookmarkButton` so they
  // only mount (and only touch TanStack Query) for bookmarkable rows; that
  // keeps the flag-off and no-conversation paths free of any query client.
  const bookmarksEnabled = useBookmarksEnabled();
  const canBookmark =
    bookmarksEnabled &&
    Boolean(conversationId) &&
    Boolean(message.id) &&
    !message.isOptimistic;

  // Flat plain-text body derived from the message's text blocks; this is the
  // copy payload and mirrors the daemon's `joinWithSpacing`.
  const content = useMemo(
    () => messagePlainText(message),
    [message],
  );
  const timestamp = useMemo(
    () => latestMessageActivityTimestamp(message),
    [message],
  );

  const [showCopied, setShowCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable fallback so history messages (which lack a client-side timestamp)
  // still display one without re-computing on every render.
  const [fallbackTimestamp] = useState(() => Date.now());
  const displayTimestamp = timestamp ?? fallbackTimestamp;

  const hasCopyableText = content.trim().length > 0;

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setShowCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        setShowCopied(false);
        timerRef.current = null;
      }, 1500);
    }).catch(() => {
      // Clipboard write denied — silently ignore
    });
  }, [content]);

  return (
    <div
      className={`flex items-center gap-0.5 ${
        role === "user" ? "justify-end" : "justify-start"
      }`}
    >
      <span
        className="select-none px-1 text-body-small-default text-[var(--content-tertiary)]"
        title={formatDetailedTimestamp(displayTimestamp)}
      >
        {formatTimestamp(displayTimestamp)}
      </span>

      {hasCopyableText && (
        <button
          type="button"
          onClick={handleCopy}
          title={showCopied ? "Copied" : "Copy"}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          {showCopied ? (
            <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {canBookmark && conversationId && message.id && (
        <MessageBookmarkButton
          messageId={message.id}
          conversationId={conversationId}
        />
      )}

      {role === "assistant" &&
        conversationId &&
        message.id &&
        !message.isOptimistic && (
          <MessageReactionButton
            message={message}
            conversationId={conversationId}
          />
        )}

      {openInSlackUrl && (
        <a
          href={openInSlackUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Open in Slack"
          title="Open in Slack"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title="Fork from here"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <GitBranch className="h-3.5 w-3.5" />
        </button>
      )}

      {onInspect && (
        <button
          type="button"
          onClick={onInspect}
          title="Inspect"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <FileCode className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Quick-reaction picker for a persisted assistant message. Offers a small
 * curated emoji row in a popover; picking one toggles the user's reaction
 * on the message (already-placed reactions are highlighted and removed on
 * a second pick — chips on the bubble also remove on click).
 */
function MessageReactionButton({
  message,
  conversationId,
}: {
  message: DisplayMessage;
  conversationId: string;
}) {
  const [open, setOpen] = useState(false);
  const toggleReaction = useUserReactionToggle(conversationId);
  const supported = useReactionsSupported();
  if (!supported) {
    return null;
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="React"
          aria-label="React with an emoji"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <SmilePlus className="h-3.5 w-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Content side="top" align="start" className="flex gap-1 p-1.5">
        {QUICK_REACTION_EMOJI.map((emoji) => {
          const active = hasUserReaction(message, emoji);
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                setOpen(false);
                void toggleReaction(message, emoji);
              }}
              title={active ? `Remove ${emoji} reaction` : `React with ${emoji}`}
              aria-pressed={active}
              className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-[var(--surface-active)] ${
                active ? "bg-[var(--surface-active)]" : ""
              }`}
            >
              {emoji}
            </button>
          );
        })}
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * Bookmark toggle for a persisted message. Split out from the row so its
 * TanStack Query hooks only mount for bookmarkable messages — rows without a
 * conversation, optimistic rows, and flag-off installs never construct a query
 * observer (and SSR render tests need no QueryClientProvider).
 */
function MessageBookmarkButton({
  messageId,
  conversationId,
}: {
  messageId: string;
  conversationId: string;
}) {
  const isBookmarked = useIsBookmarked(messageId);
  const toggleBookmark = useBookmarkToggle();
  const handleToggle = useCallback(() => {
    void toggleBookmark(messageId, conversationId, isBookmarked);
  }, [messageId, conversationId, isBookmarked, toggleBookmark]);

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={isBookmarked ? "Remove bookmark" : "Bookmark"}
      aria-pressed={isBookmarked}
      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
    >
      <Bookmark
        className={`h-3.5 w-3.5 ${
          isBookmarked ? "fill-current text-[var(--content-default)]" : ""
        }`}
      />
    </button>
  );
}
