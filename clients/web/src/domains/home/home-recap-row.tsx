import { Mail, MailOpen, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

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
  const style = resolveStyle(item.category);
  const Icon = style.icon;
  const isUnread = item.status === "new";
  const isRestore = trailingAction === "restore";
  const label = item.title ?? item.summary;

  return (
    <div
      className={cn(
        "group relative flex min-h-[48px] w-full items-center gap-[var(--app-spacing-sm)]",
        "rounded-[var(--radius-md)] px-[var(--app-spacing-md)] py-[var(--app-spacing-sm)]",
        "transition-[background-color,opacity] duration-150",
        isActive
          ? "bg-[var(--surface-active)]"
          : "bg-[var(--surface-overlay)] hover:bg-[var(--surface-hover)]",
        !isUnread && !isActive && "opacity-70",
      )}
    >
      {/* Stretched link: the row's single click target. Everything else stacks
          above it and so must stay `pointer-events-none` unless it is itself
          interactive, or clicks meant for the row get swallowed. */}
      <button
        type="button"
        aria-label={label}
        onClick={() => onSelect(item)}
        className="absolute inset-0 w-full cursor-pointer rounded-[var(--radius-md)]"
      />

      <span
        className="pointer-events-none relative shrink-0"
        aria-hidden="true"
      >
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
          "text-body-medium-default pointer-events-none relative min-w-0 flex-1 truncate text-left",
          "text-[var(--content-secondary)]",
        )}
      >
        {label}
      </span>

      {/* Timestamp and actions share one grid cell so the row keeps a stable
          width as they cross-fade. */}
      <span className="pointer-events-none relative grid shrink-0 items-center justify-items-end">
        <span
          className={cn(
            "col-start-1 row-start-1",
            "text-body-small-default text-[var(--content-tertiary)]",
            "transition-opacity duration-150",
            "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {formatRelativeDate(item.timestamp)}
        </span>

        <span
          className={cn(
            "col-start-1 row-start-1 flex items-center gap-[var(--app-spacing-sm)]",
            "pointer-events-none opacity-0 transition-opacity duration-150",
            "group-hover:pointer-events-auto group-hover:opacity-100",
            "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
        >
          {isRestore ? (
            <HoverIconButton
              label="Restore"
              onClick={() => onDismiss(item.id)}
              className="w-auto gap-[var(--app-spacing-xs)] px-2"
            >
              <RotateCcw width={16} height={16} aria-hidden="true" />
              <span className="text-body-small-default">Restore</span>
            </HoverIconButton>
          ) : (
            <>
              {onToggleRead && (
                <HoverIconButton
                  label={isUnread ? "Mark as read" : "Mark as unread"}
                  onClick={() =>
                    onToggleRead(item.id, isUnread ? "seen" : "new")
                  }
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
              <HoverIconButton
                label="Dismiss"
                onClick={() => onDismiss(item.id)}
              >
                <Trash2 width={16} height={16} />
              </HoverIconButton>
            </>
          )}
        </span>
      </span>
    </div>
  );
}
