import { Mail, MailOpen, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { formatRelativeDate } from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import {
  cn,
  Tooltip,
  Typography,
  type TypographyVariant,
} from "@vellumai/design-library";

import { FeedCategoryChip } from "./feed-category-chip";
import { flattenSummary, resolvePreview } from "./feed-preview";

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

/** Source labels that carry nothing the category chip does not already say. */
const GENERIC_SOURCE_LABELS = new Set(["Conversation", "Other"]);

/**
 * Name for an item with neither a title nor a summary that renders as text, so
 * the card's click target always has an accessible name. The category is not
 * used here: its chip is already on the card, and repeating it would read the
 * same word twice.
 */
const UNNAMED_ITEM_TITLE = "Notification";

export type HomeRecapRowDensity = "comfortable" | "compact";

interface DensityStyle {
  /** Card padding and the gap between the meta row, title, and preview. */
  card: string;
  titleVariant: TypographyVariant;
  clamp: string;
}

const DENSITY_STYLES: Record<HomeRecapRowDensity, DensityStyle> = {
  comfortable: {
    card: "gap-[var(--app-spacing-xs)] p-[var(--app-spacing-md)]",
    titleVariant: "title-small",
    clamp: "line-clamp-2",
  },
  compact: {
    card: "gap-[var(--app-spacing-xxs)] p-[var(--app-spacing-sm)]",
    titleVariant: "body-medium-default",
    clamp: "line-clamp-1",
  },
};

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
  density?: HomeRecapRowDensity;
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
  density = "comfortable",
}: HomeRecapRowProps) {
  const isUnread = item.status === "new";
  const isRestore = trailingAction === "restore";
  const densityStyle = DENSITY_STYLES[density];

  const sourceLabel =
    item.sourceLabel && !GENERIC_SOURCE_LABELS.has(item.sourceLabel)
      ? item.sourceLabel
      : null;

  // An item without its own title falls back to the summary, which is markdown:
  // it goes through the flattener so the title line and the click target's name
  // carry text rather than syntax.
  //
  // Both memoized: each parses the summary as markdown, and the feed re-renders
  // every card whenever its filter changes.
  const title = useMemo(() => {
    const resolved = item.title ?? flattenSummary(item.summary);
    return resolved.length > 0 ? resolved : UNNAMED_ITEM_TITLE;
  }, [item.title, item.summary]);

  const preview = useMemo(
    () => resolvePreview(title, item.summary),
    [title, item.summary],
  );

  return (
    <div
      className={cn(
        "group relative flex w-full flex-col",
        "rounded-[var(--radius-lg)] border border-[var(--border-base)]",
        "transition-[background-color,opacity] duration-150",
        densityStyle.card,
        isActive
          ? "bg-[var(--surface-active)]"
          : "bg-[var(--surface-overlay)] hover:bg-[var(--surface-hover)]",
        !isUnread && !isActive && "opacity-70",
      )}
    >
      {/* Stretched link: the card's single click target. Everything else stacks
          above it and so must stay `pointer-events-none` unless it is itself
          interactive, or clicks meant for the card get swallowed. */}
      <button
        type="button"
        aria-label={title}
        onClick={() => onSelect(item)}
        className="absolute inset-0 w-full cursor-pointer rounded-[var(--radius-lg)]"
      />

      <div className="pointer-events-none relative flex items-center gap-[var(--app-spacing-sm)]">
        <FeedCategoryChip category={item.category} />

        {sourceLabel !== null && (
          <Typography
            variant="body-small-default"
            className="min-w-0 truncate text-[var(--content-tertiary)]"
          >
            {sourceLabel}
          </Typography>
        )}

        {/* Timestamp and actions share one grid cell so the card keeps a stable
            width as they cross-fade. */}
        <span className="ml-auto grid shrink-0 items-center justify-items-end">
          <span
            className={cn(
              "col-start-1 row-start-1 flex items-center gap-[var(--app-spacing-xs)]",
              "transition-opacity duration-150",
              "group-hover:opacity-0 group-focus-within:opacity-0",
            )}
          >
            <Typography
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              {formatRelativeDate(item.timestamp)}
            </Typography>
            {isUnread && (
              <span
                data-testid="home-recap-row-unread-dot"
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full bg-[var(--system-mid-strong)]"
              />
            )}
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

      {/* leading-snug: the title-small token is line-height:1, and line-clamp's
          overflow clipping would cut descenders without real line height. */}
      <Typography
        variant={densityStyle.titleVariant}
        className={cn(
          "pointer-events-none relative leading-snug text-[var(--content-default)]",
          densityStyle.clamp,
        )}
      >
        {title}
      </Typography>

      {preview !== null && (
        <Typography
          variant="body-medium-lighter"
          className={cn(
            "pointer-events-none relative leading-normal text-[var(--content-secondary)]",
            densityStyle.clamp,
          )}
        >
          {preview}
        </Typography>
      )}
    </div>
  );
}
