import {
  Bookmark,
  Check,
  Copy,
  ExternalLink,
  FileCode,
  GitBranch,
  ListCollapse,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { MessageHoverActionsProps } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import {
  useBookmarksEnabled,
  useBookmarkToggle,
  useIsBookmarked,
} from "@/hooks/use-bookmarks";
import { BottomSheet, PanelItem } from "@vellumai/design-library";

type MessageLongPressActionsProps = MessageHoverActionsProps & {
  /** Controlled open state for the BottomSheet. */
  open: boolean;
  /** Called when the sheet should open or close. */
  onOpenChange: (open: boolean) => void;
};

/**
 * Mobile-only action sheet for a message — the BottomSheet counterpart of
 * `MessageHoverActions`. Renders the same action set (Copy, Bookmark, Open
 * in Slack, Fork from here, Summarize up to here, Inspect) as `PanelItem`
 * rows inside a `BottomSheet`, which is inherently mobile-only (renders
 * below 768px). Each action runs its callback and then dismisses the sheet
 * so the action's UI feedback (modals, toasts, navigation) doesn't fire
 * under a still-open sheet.
 */
export function MessageLongPressActions({
  message,
  conversationId,
  openInSlackUrl,
  onFork,
  onSummarizeUpToHere,
  onInspect,
  open,
  onOpenChange,
}: MessageLongPressActionsProps) {
  const bookmarksEnabled = useBookmarksEnabled();
  const canBookmark =
    bookmarksEnabled &&
    Boolean(conversationId) &&
    Boolean(message.id) &&
    !message.isOptimistic;

  const content = useMemo(() => messagePlainText(message), [message]);

  const [showCopied, setShowCopied] = useState(false);
  const hasCopyableText = content.trim().length > 0;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 1500);
    }).catch(() => {
      // Clipboard write denied — silently ignore
    });
  }, [content]);

  const buildItem = useCallback(
    ({
      key,
      icon,
      label,
      run,
    }: {
      key: string;
      icon?: LucideIcon;
      label: string;
      run: () => void;
    }) => (
      <PanelItem
        key={key}
        icon={icon}
        label={label}
        onSelect={() => {
          run();
          close();
        }}
      />
    ),
    [close],
  );

  const items: React.ReactNode[] = [];

  if (hasCopyableText) {
    items.push(
      showCopied ? (
        <PanelItem key="copy" icon={Check} label="Copied" />
      ) : (
        buildItem({ key: "copy", icon: Copy, label: "Copy", run: handleCopy })
      ),
    );
  }

  if (canBookmark && conversationId && message.id) {
    items.push(
      <BookmarkPanelItem
        key="bookmark"
        messageId={message.id}
        conversationId={conversationId}
        onClose={close}
      />,
    );
  }

  if (openInSlackUrl) {
    items.push(
      buildItem({
        key: "slack",
        icon: ExternalLink,
        label: "Open in Slack",
        run: () => {
          window.open(openInSlackUrl, "_blank", "noopener,noreferrer");
        },
      }),
    );
  }

  if (onFork) {
    items.push(
      buildItem({
        key: "fork",
        icon: GitBranch,
        label: "Fork from here",
        run: onFork,
      }),
    );
  }

  if (onSummarizeUpToHere) {
    items.push(
      buildItem({
        key: "summarize",
        icon: ListCollapse,
        label: "Summarize up to here",
        run: onSummarizeUpToHere,
      }),
    );
  }

  if (onInspect) {
    items.push(
      buildItem({
        key: "inspect",
        icon: FileCode,
        label: "Inspect",
        run: onInspect,
      }),
    );
  }

  return (
    <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
      <BottomSheet.Content aria-describedby={undefined}>
        <BottomSheet.Header className="sr-only">
          <BottomSheet.Title>Message actions</BottomSheet.Title>
        </BottomSheet.Header>
        <BottomSheet.Body className="pt-0">{items}</BottomSheet.Body>
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}

/**
 * Bookmark toggle PanelItem for a persisted message. Split out so its
 * TanStack Query hooks only mount for bookmarkable messages — mirroring the
 * `MessageBookmarkButton` pattern in `MessageHoverActions`.
 */
function BookmarkPanelItem({
  messageId,
  conversationId,
  onClose,
}: {
  messageId: string;
  conversationId: string;
  onClose: () => void;
}) {
  const isBookmarked = useIsBookmarked(messageId);
  const toggleBookmark = useBookmarkToggle();
  const handleToggle = useCallback(() => {
    void toggleBookmark(messageId, conversationId, isBookmarked);
    onClose();
  }, [messageId, conversationId, isBookmarked, toggleBookmark, onClose]);

  return (
    <PanelItem
      icon={Bookmark}
      label={isBookmarked ? "Remove bookmark" : "Bookmark"}
      onSelect={handleToggle}
    />
  );
}
