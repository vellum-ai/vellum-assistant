import { Mail, MailOpen, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useTranslation } from "@/i18n";
import { formatRelativeDate } from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import {
  cn,
  Tooltip,
  Typography,
  type TypographyVariant,
} from "@vellumai/design-library";

import { FeedCategoryChip } from "./feed-category-chip";
import { resolvePreview } from "./feed-preview";
import { resolveFeedItemTitle } from "./utils";

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

export type HomeRecapRowDensity = "comfortable" | "compact";

interface DensityStyle {
  /** Card padding. */
  card: string;
  /** Gap between the rows of the content stack. */
  stack: string;
  titleVariant: TypographyVariant;
  clamp: string;
  /**
   * Whether the first line is a meta row naming the item's category and
   * source, with the title on its own line under it. Without that row the
   * title takes the first line and shares it with the timestamp.
   */
  showsMetaRow: boolean;
}

const DENSITY_STYLES: Record<HomeRecapRowDensity, DensityStyle> = {
  comfortable: {
    card: "p-[var(--app-spacing-md)]",
    stack: "gap-[var(--app-spacing-xs)]",
    titleVariant: "title-small",
    clamp: "line-clamp-2",
    showsMetaRow: true,
  },
  compact: {
    card: "p-[var(--app-spacing-sm)]",
    stack: "gap-[var(--app-spacing-xxs)]",
    titleVariant: "body-medium-default",
    clamp: "line-clamp-1",
    showsMetaRow: false,
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
  const { t } = useTranslation("home");
  const isUnread = item.status === "new";
  const isRestore = trailingAction === "restore";
  const densityStyle = DENSITY_STYLES[density];

  const sourceLabel =
    item.sourceLabel && !GENERIC_SOURCE_LABELS.has(item.sourceLabel)
      ? item.sourceLabel
      : null;

  // Both memoized: each parses the summary as markdown, and the feed re-renders
  // every card whenever its filter changes.
  const title = useMemo(
    () => resolveFeedItemTitle({ title: item.title, summary: item.summary }),
    [item.title, item.summary],
  );

  const preview = useMemo(
    () => resolvePreview(title, item.summary),
    [title, item.summary],
  );

  // leading-snug: the title-small token is line-height:1, and line-clamp's
  // overflow clipping would cut descenders without real line height.
  const titleLine = (
    <Typography
      data-testid="home-recap-row-title"
      variant={densityStyle.titleVariant}
      className={cn(
        "leading-snug text-[var(--content-default)]",
        // On the first line the title has to yield to the timestamp beside it,
        // so it shrinks and ellipsizes rather than pushing the timestamp out.
        densityStyle.showsMetaRow
          ? densityStyle.clamp
          : "min-w-0 flex-1 truncate",
      )}
    >
      {title}
    </Typography>
  );

  return (
    <div
      className={cn(
        "group relative flex w-full items-start gap-[var(--app-spacing-sm)]",
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

      {/* The gutter is reserved whether or not the item is unread, so a card
          keeps the same text alignment once it is marked read. h-8 is the
          height of the first line, which the h-8 hover actions set, so the dot
          sits against the meta row or the title depending on density. */}
      <div
        data-testid="home-recap-row-dot-gutter"
        className="pointer-events-none relative flex h-8 w-2 shrink-0 items-center"
      >
        {isUnread && (
          <span
            data-testid="home-recap-row-unread-dot"
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-[var(--system-mid-strong)]"
          />
        )}
      </div>

      <div
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 flex-col",
          densityStyle.stack,
        )}
      >
        <div className="flex items-center gap-[var(--app-spacing-sm)]">
          {densityStyle.showsMetaRow ? (
            <>
              <FeedCategoryChip category={item.category} />

              {sourceLabel !== null && (
                <Typography
                  variant="body-small-default"
                  className="min-w-0 truncate text-[var(--content-tertiary)]"
                >
                  {sourceLabel}
                </Typography>
              )}
            </>
          ) : (
            titleLine
          )}

          {/* Timestamp and actions share one grid cell so the card keeps a
              stable width as they cross-fade. */}
          <span className="ml-auto grid shrink-0 items-center justify-items-end">
            <Typography
              variant="body-small-default"
              className={cn(
                "col-start-1 row-start-1 text-[var(--content-tertiary)]",
                "transition-opacity duration-150",
                "group-hover:opacity-0 group-focus-within:opacity-0",
              )}
            >
              {formatRelativeDate(item.timestamp)}
            </Typography>

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
                  label={t("actions.restore")}
                  onClick={() => onDismiss(item.id)}
                  className="w-auto gap-[var(--app-spacing-xs)] px-2"
                >
                  <RotateCcw width={16} height={16} aria-hidden="true" />
                  <span className="text-body-small-default">
                    {t("actions.restore")}
                  </span>
                </HoverIconButton>
              ) : (
                <>
                  {onToggleRead && (
                    <HoverIconButton
                      label={
                        isUnread
                          ? t("actions.markAsRead")
                          : t("actions.markAsUnread")
                      }
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
                        label={t("actions.goToThread")}
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
                    label={t("actions.dismiss")}
                    onClick={() => onDismiss(item.id)}
                  >
                    <Trash2 width={16} height={16} />
                  </HoverIconButton>
                </>
              )}
            </span>
          </span>
        </div>

        {densityStyle.showsMetaRow && titleLine}

        {preview !== null && (
          <Typography
            variant="body-medium-lighter"
            className={cn(
              "leading-normal text-[var(--content-secondary)]",
              densityStyle.clamp,
            )}
          >
            {preview}
          </Typography>
        )}
      </div>
    </div>
  );
}
