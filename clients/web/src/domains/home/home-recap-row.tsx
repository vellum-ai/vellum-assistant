import { useMemo } from "react";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { useHoverCapable } from "@/hooks/use-hover-affordance";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import { useTranslation } from "@/i18n";
import { formatRelativeDate } from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import {
  cn,
  CrossfadeStack,
  Typography,
  type TypographyVariant,
} from "@vellumai/design-library";

import { FeedCategoryChip } from "./feed-category-chip";
import { resolvePreview } from "./feed-preview";
import {
  buildRecapActions,
  RecapActionButtons,
  RecapActions,
  RecapActionsTrigger,
  swipeActionsFor,
  type HomeRecapRowTrailingAction,
} from "./home-recap-actions";
import { resolveFeedItemTitle } from "./utils";

/**
 * Marks the card's own click target, the one control a long press may arm on:
 * it covers the whole card, so requiring a press to miss it would leave no
 * gesture at all. Every other control (an inline action, a button a swipe has
 * revealed) owns its own press.
 */
const CARD_LINK_ATTRIBUTE = "data-recap-card-link";
const cardLinkProps = { [CARD_LINK_ATTRIBUTE]: "" };

const skipRowControls = (target: Element | null) => {
  const control = target?.closest("button, a");
  return control != null && !control.hasAttribute(CARD_LINK_ATTRIBUTE);
};

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

/**
 * One item of the home recap, as a card: the item's category and source, its
 * title, a preview of its summary, when it arrived, and the commands that act
 * on it.
 *
 * Every command has a path for each input. A pointer reveals the row's inline
 * buttons, which share a cell with the timestamp and cross-fade with it. Where
 * the device cannot hover there is nothing to trade that cell with, so the
 * timestamp keeps it and the commands move behind one button beside it that
 * opens them as a sheet. A swipe reaches the state changes directly and a long
 * press opens the same sheet: accelerators for a thumb, on top of a control that
 * is always there to be found, named, and focused.
 */
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
  const densityStyle = DENSITY_STYLES[density];

  const actions = buildRecapActions({
    item,
    isUnread,
    validConversationIds,
    onDismiss,
    onToggleRead,
    onGoToThread,
    trailingAction,
    t,
  });

  /* Which shape the commands take, not whether they are reachable: the row
     offers all of them either way. */
  const showsActionButtons = useHoverCapable();
  const longPress = useLongPressSheet({ shouldSkip: skipRowControls });
  const actionsLabel = t("homeRecapRow.actionsTitle");

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

  /* `data-reveal-yield` only where the buttons take the cell over on hover:
     without them the timestamp is the cell's only occupant and has nothing to
     stand down for. */
  const timestamp = (
    <Typography
      variant="body-small-default"
      className="text-[var(--content-tertiary)]"
      {...(showsActionButtons ? { "data-reveal-yield": "" } : {})}
    >
      {formatRelativeDate(item.timestamp)}
    </Typography>
  );

  const card = (
    <div
      data-reveal-row=""
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
        {...cardLinkProps}
        className="absolute inset-0 w-full cursor-pointer rounded-[var(--radius-lg)]"
      />

      {/* The gutter is reserved whether or not the item is unread, so a card
          keeps the same text alignment once it is marked read. h-8 is the
          height of the first line, which the h-8 action buttons set, so the dot
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

          {showsActionButtons ? (
            /* Timestamp and buttons share one cell so the card keeps a stable
               width as they cross-fade. */
            <CrossfadeStack className="ml-auto justify-items-end">
              {timestamp}

              <span
                data-reveal=""
                className="flex items-center gap-[var(--app-spacing-sm)]"
              >
                <RecapActionButtons actions={actions} />
              </span>
            </CrossfadeStack>
          ) : (
            <span className="ml-auto flex items-center gap-[var(--app-spacing-sm)]">
              {timestamp}
              <RecapActionsTrigger label={actionsLabel} />
            </span>
          )}
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

  return (
    <RecapActions
      actions={actions}
      title={actionsLabel}
      open={longPress.open}
      onOpenChange={longPress.onOpenChange}
    >
      <div {...longPress.wrapperProps}>
        <SwipeActionReveal
          leadingActions={swipeActionsFor(actions, "leading")}
          trailingActions={swipeActionsFor(actions, "trailing")}
          className="rounded-[var(--radius-lg)]"
        >
          {card}
        </SwipeActionReveal>
      </div>
    </RecapActions>
  );
}
