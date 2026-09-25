import {
  Bookmark,
  Check,
  Copy,
  ExternalLink,
  FileCode,
  GitBranch,
  ListCollapse,
  Loader2,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { ExternalAnchor } from "@/components/external-anchor";
import { useProfileLabel } from "@/assistant/use-profile-label";
import { useMessageReadAloudStore } from "@/domains/chat/message-read-aloud-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messageCopyText } from "@/domains/chat/utils/message-plain-text";
import {
  useBookmarkToggle,
  useCanBookmark,
  useIsBookmarked,
} from "@/hooks/use-bookmarks";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export type MessageHoverActionsProps = {
  /** The message whose text is copied and whose role/timestamp drive the row. */
  message: DisplayMessage;
  /** Hide Copy and Read aloud when the rendered row has no message text. */
  showTextActions?: boolean;
  /** Conversation the message belongs to. Required for the bookmark toggle —
   *  the bookmark API keys on (messageId, conversationId). */
  conversationId?: string | null;
  /** Slack permalink for the message, shown as a hover action when present. */
  openInSlackUrl?: string;
  /** Callback when "Fork from here" is clicked. */
  onFork?: () => void;
  /** Callback when "Summarize up to here" is clicked. */
  onSummarizeUpToHere?: () => void;
  /** Callback when "Inspect" is clicked. */
  onInspect?: () => void;
  /** Callback when "Retry" is clicked. Only provided on the latest assistant
   *  message while no turn is in flight — retry discards that response and
   *  regenerates it. */
  onRetry?: () => void;
};

/**
 * Which default profile the Auto profile picked for this row. Its own
 * component so the profile-label query mounts only for Auto rows, keeping
 * the rest of the hover row free of any query client (same reason the
 * bookmark toggle lives in `MessageBookmarkButton`).
 */
function AutoRoutedProfileBadge({ profileKey }: { profileKey: string }) {
  const { t } = useTranslation("chat");
  const label = useProfileLabel(profileKey);
  return (
    <span
      data-slot="auto-routed-profile"
      className="select-none px-1 text-body-small-default text-[var(--content-tertiary)]"
    >
      {t("messageHoverActions.autoRouted", { profile: label })}
    </span>
  );
}

/**
 * Every control in the row is a 24px ghost `Button`; `expandOnMobile` is off
 * because the row is laid out for 24px boxes and the long-press sheet is the
 * touch affordance.
 */
const ACTION_BUTTON_PROPS = {
  variant: "ghost",
  size: "compact",
  expandOnMobile: false,
} as const;

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
  showTextActions = true,
  conversationId,
  openInSlackUrl,
  onFork,
  onSummarizeUpToHere,
  onInspect,
  onRetry,
}: MessageHoverActionsProps) {
  const { t } = useTranslation("chat");
  const { role } = message;

  // The toggle's data hooks live in `MessageBookmarkButton` so they only mount
  // (and only touch TanStack Query) for bookmarkable rows; that keeps the
  // unsupported-assistant and no-conversation paths free of any query client.
  const canBookmark = useCanBookmark(message, conversationId);

  // Flat plain-text body derived from the message's text blocks (empty for a
  // row deleted on its channel); this is the copy payload and mirrors the
  // daemon's `joinWithSpacing`.
  const content = useMemo(() => messageCopyText(message), [message]);
  const timestamp = useMemo(
    () => latestMessageActivityTimestamp(message),
    [message],
  );

  const { copy, copied: showCopied } = useCopyToClipboard({
    errorMessage: t("messageHoverActions.copyFailed"),
  });
  // Stable fallback so history messages (which lack a client-side timestamp)
  // still display one without re-computing on every render.
  const [fallbackTimestamp] = useState(() => Date.now());
  const displayTimestamp = timestamp ?? fallbackTimestamp;

  const hasCopyableText = showTextActions && content.trim().length > 0;

  const handleCopy = useCallback(() => copy(content), [copy, content]);

  return (
    // The timestamp and these controls are chrome, not message content: a
    // selection that overshoots onto them still copies as the message alone.
    <div
      data-copy-exclude
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
      {message.autoRoutedProfile && (
        <AutoRoutedProfileBadge profileKey={message.autoRoutedProfile} />
      )}

      {hasCopyableText && (
        <Button
          {...ACTION_BUTTON_PROPS}
          onClick={handleCopy}
          title={
            showCopied
              ? t("messageHoverActions.copied")
              : t("messageHoverActions.copy")
          }
          aria-label={
            showCopied
              ? t("messageHoverActions.copied")
              : t("messageHoverActions.copy")
          }
          iconOnly={
            showCopied ? (
              <Check className="text-[var(--system-positive-strong)]" />
            ) : (
              <Copy />
            )
          }
        />
      )}

      {hasCopyableText && message.id && (
        <MessageReadAloudButton
          messageId={message.id}
          text={content}
          conversationId={conversationId}
        />
      )}

      <div className="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-200 ease-out group-hover/msg:opacity-100 group-hover/msg:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto group-data-[revealed=true]/msg:opacity-100 group-data-[revealed=true]/msg:pointer-events-auto motion-reduce:transition-none">
        {onRetry && (
          <Button
            {...ACTION_BUTTON_PROPS}
            onClick={onRetry}
            title={t("messageHoverActions.retry")}
            aria-label={t("messageHoverActions.retry")}
            iconOnly={<RotateCcw />}
          />
        )}

        {canBookmark && conversationId && message.id && (
          <MessageBookmarkButton
            messageId={message.id}
            conversationId={conversationId}
          />
        )}

        {openInSlackUrl && (
          <Button
            {...ACTION_BUTTON_PROPS}
            asChild
            aria-label={t("messageHoverActions.openInSlack")}
            title={t("messageHoverActions.openInSlack")}
            iconOnly={<ExternalLink />}
          >
            <ExternalAnchor href={openInSlackUrl} glyph={false} />
          </Button>
        )}

        {onFork && (
          <Button
            {...ACTION_BUTTON_PROPS}
            onClick={onFork}
            title={t("messageHoverActions.forkFromHere")}
            aria-label={t("messageHoverActions.forkFromHere")}
            iconOnly={<GitBranch />}
          />
        )}

        {onSummarizeUpToHere && (
          <Button
            {...ACTION_BUTTON_PROPS}
            onClick={onSummarizeUpToHere}
            title={t("messageHoverActions.summarizeUpToHere")}
            aria-label={t("messageHoverActions.summarizeUpToHere")}
            iconOnly={<ListCollapse />}
          />
        )}

        {onInspect && (
          <Button
            {...ACTION_BUTTON_PROPS}
            onClick={onInspect}
            title={t("messageHoverActions.inspect")}
            aria-label={t("messageHoverActions.inspect")}
            iconOnly={<FileCode />}
          />
        )}
      </div>
    </div>
  );
}

function MessageReadAloudButton({
  messageId,
  text,
  conversationId,
}: {
  messageId: string;
  text: string;
  conversationId?: string | null;
}) {
  const { t } = useTranslation("chat");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeMessageId = useMessageReadAloudStore.use.messageId();
  const status = useMessageReadAloudStore.use.status();
  const isThisMessage = activeMessageId === messageId;
  const isLoading = isThisMessage && status === "loading";
  const isPlaying = isThisMessage && status === "playing";

  const title = isLoading
    ? t("messageHoverActions.loading")
    : isPlaying
      ? t("messageHoverActions.stop")
      : t("messageHoverActions.readAloud");

  const handleClick = useCallback(() => {
    useMessageReadAloudStore.getState().toggle({
      messageId,
      text,
      assistantId,
      conversationId,
    });
  }, [assistantId, conversationId, messageId, text]);

  return (
    // Not `loading`: the button stays clickable while the audio loads, since
    // the same press cancels the request.
    <Button
      {...ACTION_BUTTON_PROPS}
      onClick={handleClick}
      title={title}
      aria-label={title}
      aria-pressed={isPlaying}
      aria-busy={isLoading}
      iconOnly={
        isLoading ? (
          <Loader2 className="animate-spin" />
        ) : isPlaying ? (
          <Square />
        ) : (
          <Volume2 />
        )
      }
    />
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
  const { t } = useTranslation("chat");
  const isBookmarked = useIsBookmarked(messageId);
  const toggleBookmark = useBookmarkToggle();
  const handleToggle = useCallback(() => {
    void toggleBookmark(messageId, conversationId, isBookmarked);
  }, [messageId, conversationId, isBookmarked, toggleBookmark]);

  return (
    <Button
      {...ACTION_BUTTON_PROPS}
      onClick={handleToggle}
      title={
        isBookmarked
          ? t("messageHoverActions.removeBookmark")
          : t("messageHoverActions.bookmark")
      }
      aria-label={
        isBookmarked
          ? t("messageHoverActions.removeBookmark")
          : t("messageHoverActions.bookmark")
      }
      aria-pressed={isBookmarked}
      iconOnly={
        <Bookmark
          className={
            isBookmarked ? "fill-current text-[var(--content-default)]" : ""
          }
        />
      }
    />
  );
}
