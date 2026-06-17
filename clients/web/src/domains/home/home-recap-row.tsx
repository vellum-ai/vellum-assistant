import { Mail, MailOpen, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { formatRelativeDate } from "@/utils/format-date";
import type {
    FeedItem,
    FeedItemCategory,
    FeedItemStatus,
} from "@vellumai/assistant-api";
import { cn, Tooltip } from "@vellumai/design-library";
import { CATEGORY_STYLES } from "./home-feed-filter-bar";

function HoverIconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cn(
          "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md",
          "text-[var(--content-secondary)] transition-colors",
          "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function resolveStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

export type HomeRecapRowTrailingAction = "dismiss" | "restore";

export interface HomeRecapRowProps {
  item: FeedItem;
  isActive?: boolean;
  validConversationIds?: Set<string>;
  onSelect: (item: FeedItem) => void;
  onDismiss: (itemId: string) => void;
  onToggleRead?: (itemId: string, newStatus: FeedItemStatus) => void;
  onGoToThread?: (conversationId: string) => void;
  trailingAction?: HomeRecapRowTrailingAction;
}

export function HomeRecapRow({
  item,
  isActive = false,
  validConversationIds,
  onSelect,
  onDismiss,
  onToggleRead,
  onGoToThread,
  trailingAction = "dismiss",
}: HomeRecapRowProps) {
  const [isHovering, setIsHovering] = useState(false);
  const style = resolveStyle(item.category);
  const Icon = style.icon;
  const isUnread = item.status === "new";
  const isRestore = trailingAction === "restore";

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      className={cn(
        "flex min-h-[48px] w-full cursor-pointer items-center gap-[var(--app-spacing-sm)]",
        "rounded-[var(--radius-md)] px-[var(--app-spacing-md)] py-[var(--app-spacing-sm)]",
        "transition-[background-color,opacity] duration-150",
        isActive
          ? "bg-[var(--surface-active)]"
          : isHovering
            ? "bg-[var(--surface-hover)]"
            : "bg-[var(--surface-overlay)]",
        !isUnread && !isActive && "opacity-70",
      )}
    >
      <span className="relative shrink-0" aria-hidden="true">
        <span
          className="flex items-center justify-center rounded-full"
          style={{
            width: 26,
            height: 26,
            backgroundColor: style.weak,
          }}
        >
          <Icon width={12} height={12} style={{ color: style.strong }} />
        </span>
        {isUnread && (
          <span className="absolute -left-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--system-mid-strong)]" />
        )}
      </span>

      <span
        className={cn(
          "text-body-medium-default min-w-0 flex-1 truncate text-left",
          "text-[var(--content-secondary)]",
        )}
      >
        {item.title ?? item.summary}
      </span>

      {isHovering && !isRestore ? (
        <span className="flex shrink-0 items-center gap-[var(--app-spacing-sm)]">
          {onToggleRead && (
            <HoverIconButton
              label={isUnread ? "Mark as read" : "Mark as unread"}
              onClick={() => onToggleRead(item.id, isUnread ? "seen" : "new")}
            >
              {isUnread ? (
                <MailOpen width={16} height={16} />
              ) : (
                <Mail width={16} height={16} />
              )}
            </HoverIconButton>
          )}
          {onGoToThread &&
            item.conversationId &&
            (!validConversationIds ||
              validConversationIds.has(item.conversationId)) && (
              <HoverIconButton
                label="Go to thread"
                onClick={() => {
                  if (isUnread && onToggleRead) {
                    onToggleRead(item.id, "seen");
                  }
                  onGoToThread(item.conversationId!);
                }}
              >
                <MessageSquare width={16} height={16} />
              </HoverIconButton>
            )}
          <HoverIconButton label="Dismiss" onClick={() => onDismiss(item.id)}>
            <Trash2 width={16} height={16} />
          </HoverIconButton>
        </span>
      ) : isHovering && isRestore ? (
        <HoverIconButton
          label="Restore"
          onClick={() => onDismiss(item.id)}
          className="w-auto gap-[var(--app-spacing-xs)] px-2"
        >
          <RotateCcw width={16} height={16} aria-hidden="true" />
          <span className="text-body-small-default">Restore</span>
        </HoverIconButton>
      ) : (
        <span className="shrink-0 text-body-small-default text-[var(--content-tertiary)]">
          {formatRelativeDate(item.timestamp)}
        </span>
      )}
    </button>
  );
}
