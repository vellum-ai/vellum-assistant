import { MessageSquare } from "lucide-react";
import { useMemo } from "react";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { useHoverCapable } from "@/hooks/use-hover-affordance";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import { useTranslation } from "@/i18n";
import { formatRelativeDate } from "@/utils/format-date";
import {
  isPendingGuardianFeedItem,
  type FeedItem,
  type FeedItemStatus,
} from "@vellumai/assistant-api";
import {
  Button,
  cn,
  CrossfadeStack,
  Typography,
} from "@vellumai/design-library";

import { flattenSummary, resolvePreview } from "./feed-preview";
import {
  buildRecapActions,
  RecapActionButtons,
  RecapActions,
  RecapActionsTrigger,
  swipeActionsFor,
  type HomeRecapRowTrailingAction,
} from "./home-recap-actions";
import { guardianLabelKey, resolveFeedItemTitle } from "./utils";

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

/**
 * The decision a row's inline buttons submit for a pending approval. Mirrors
 * the canonical decision route's `action` field, so the bell can hand it to
 * the mutation unchanged.
 */
export type HomeRecapRowDecision = "approve_once" | "reject";

/**
 * The line under the title, in the indented column: a description where the
 * title alone does not say what the row needs, and the thread it came from.
 * The dot's gutter (8px) plus the gap beside it (8px) is what this indent
 * matches, so the column starts where the title starts.
 */
const BODY_COLUMN_CLASS =
  "pointer-events-none relative flex min-w-0 flex-col gap-[var(--app-spacing-xs)] pl-[var(--app-spacing-lg)]";

export interface HomeRecapRowProps {
  item: FeedItem;
  isActive?: boolean;
  validConversationIds?: Set<string>;
  /**
   * The name of the thread the item came from, resolved by the caller from
   * the conversation lists. Read under the title; omitted when unknown.
   */
  threadName?: string | null;
  onSelect: (item: FeedItem) => void;
  onDismiss: (itemId: string) => void;
  onToggleRead?: (itemId: string, newStatus: FeedItemStatus) => void;
  onGoToThread?: (conversationId: string) => void;
  /**
   * Submits a decision on a pending approval from the row itself. Without it
   * the row offers no buttons and the request is decided from its detail.
   */
  onDecide?: (item: FeedItem, decision: HomeRecapRowDecision) => void;
  /** True while a decision is in flight, holding every row's buttons inert. */
  isDecisionPending?: boolean;
  /**
   * True once this request was decided this session, so the buttons stay
   * down while the feed still projects it as pending.
   */
  isDecided?: boolean;
  trailingAction?: HomeRecapRowTrailingAction;
}

/**
 * One notification in the bell: an unread dot, the title, when it arrived,
 * and under it the thread it came from.
 *
 * The title carries the row. A description only appears when the row needs
 * something of the user and the title cannot say what: a pending question
 * quotes the ask, a pending approval describes what is being asked for, and
 * an item the assistant attached offers to previews the body behind them.
 * Every description is also checked against the title (`resolvePreview`) so
 * a body that only restates it is dropped. A row that only reports shows its
 * title alone; its body waits in the detail.
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
  threadName = null,
  onSelect,
  onDismiss,
  onToggleRead,
  onGoToThread,
  onDecide,
  isDecisionPending = false,
  isDecided = false,
  trailingAction = "dismiss",
}: HomeRecapRowProps) {
  const { t } = useTranslation("home");
  const isUnread = item.status === "new";

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

  const needsAttention = isPendingGuardianFeedItem(item);
  const isPendingQuestion =
    needsAttention && item.guardianRequest?.intent === "question";
  const isPendingApproval =
    needsAttention && item.guardianRequest?.intent === "approval";

  /* A waiting request is named by what it asks of the user, since its own
     title is the generic name of the kind of request, and the ask itself
     (which lives in the body) reads underneath. */
  const attentionLabelKey = needsAttention ? guardianLabelKey(item) : null;

  // Both memoized: each parses the summary as markdown, and the bell re-renders
  // every row whenever the feed changes.
  const title = useMemo(
    () =>
      attentionLabelKey
        ? t(attentionLabelKey)
        : resolveFeedItemTitle({ title: item.title, summary: item.summary }),
    [attentionLabelKey, t, item.title, item.summary],
  );

  const hasOffers = (item.actions?.length ?? 0) > 0;
  const description = useMemo(() => {
    if (attentionLabelKey) {
      const ask = flattenSummary(item.summary);
      return ask.length > 0 ? ask : null;
    }
    return hasOffers ? resolvePreview(title, item.summary) : null;
  }, [attentionLabelKey, hasOffers, title, item.summary]);

  const titleLine = (
    <Typography
      data-testid="home-recap-row-title"
      variant="body-medium-default"
      // On the first line the title has to yield to the timestamp beside it,
      // so it shrinks and ellipsizes rather than pushing the timestamp out.
      className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
    >
      {title}
    </Typography>
  );

  /* `data-reveal-yield` only where the buttons take the cell over on hover:
     without them the timestamp is the cell's only occupant and has nothing to
     stand down for. */
  const timestamp = (
    <Typography
      variant="label-small-default"
      className="whitespace-nowrap text-[var(--content-disabled)]"
      {...(showsActionButtons ? { "data-reveal-yield": "" } : {})}
    >
      {formatRelativeDate(item.timestamp)}
    </Typography>
  );

  const decisionButtons =
    isPendingApproval && onDecide && !isDecided ? (
      /* The buttons stand above the stretched link and take their own
         clicks, so deciding a request does not also open it. */
      <div
        data-testid="home-recap-row-decision"
        className="pointer-events-auto flex gap-[var(--app-spacing-sm)] pt-[var(--app-spacing-sm)]"
      >
        <Button
          variant="primary"
          disabled={isDecisionPending}
          onClick={(event) => {
            event.stopPropagation();
            onDecide(item, "approve_once");
          }}
        >
          {t("homeRecapRow.approve")}
        </Button>
        <Button
          variant="outlined"
          disabled={isDecisionPending}
          onClick={(event) => {
            event.stopPropagation();
            onDecide(item, "reject");
          }}
        >
          {t("homeRecapRow.reject")}
        </Button>
      </div>
    ) : null;

  const card = (
    <div
      data-reveal-row=""
      data-needs-attention={needsAttention ? "" : undefined}
      className={cn(
        "group relative flex w-full flex-col gap-[var(--app-spacing-xs)]",
        "transition-[background-color] duration-150",
        isActive && "bg-[var(--surface-active)]",
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
        // Bleeds a little past the text on every side, so the hover wash
        // reads as the row's own; the list keeps the rule between rows
        // outside this box.
        className="absolute -inset-x-[var(--app-spacing-sm)] -inset-y-[var(--app-spacing-xs)] cursor-pointer rounded-[var(--radius-md)] hover:bg-[var(--surface-hover)]"
      />

      <div className="pointer-events-none relative flex items-center gap-[var(--app-spacing-sm)]">
        {/* The dot marks the row whether or not it is unread, so a row keeps
            its alignment once it is marked read: unread carries the positive
            hue, read fades to the divider colour. */}
        <div
          data-testid="home-recap-row-dot-gutter"
          className="flex w-2 shrink-0 items-center justify-center"
        >
          <span
            data-testid={
              isUnread ? "home-recap-row-unread-dot" : "home-recap-row-read-dot"
            }
            aria-hidden="true"
            className={cn(
              "h-2 w-2 rounded-full",
              isUnread
                ? "bg-[var(--system-positive-strong)]"
                : "bg-[var(--border-subtle)]",
            )}
          />
        </div>

        {titleLine}

        {showsActionButtons ? (
          /* Timestamp and buttons share one cell so the row keeps a stable
             width as they cross-fade. */
          <CrossfadeStack className="ml-auto justify-items-end">
            {timestamp}

            <span
              data-reveal=""
              className="flex items-center gap-[var(--app-spacing-xs)]"
            >
              <RecapActionButtons actions={actions} />
            </span>
          </CrossfadeStack>
        ) : (
          <span className="ml-auto flex items-center gap-[var(--app-spacing-xs)]">
            {timestamp}
            <RecapActionsTrigger label={actionsLabel} />
          </span>
        )}
      </div>

      {description !== null || threadName !== null || decisionButtons ? (
        <div className={BODY_COLUMN_CLASS}>
          {description !== null ? (
            isPendingQuestion ? (
              /* The ask, set as the quoted message it is, so the row reads as
                 someone waiting on a reply rather than as a report. */
              <div
                data-testid="home-recap-row-question"
                className="flex h-8 min-w-0 items-center gap-[var(--app-spacing-xs)] rounded-[var(--radius-md)] bg-[var(--surface-hover)] px-[var(--app-spacing-sm)]"
              >
                <MessageSquare
                  className="size-4 shrink-0 text-[var(--content-secondary)]"
                  aria-hidden="true"
                />
                <Typography
                  variant="body-medium-lighter"
                  className="min-w-0 truncate text-[var(--content-tertiary)]"
                >
                  {description}
                </Typography>
              </div>
            ) : (
              <Typography
                data-testid="home-recap-row-description"
                variant="label-medium-default"
                className="line-clamp-2 leading-normal text-[var(--content-secondary)]"
              >
                {description}
              </Typography>
            )
          ) : null}

          {threadName !== null ? (
            <Typography
              data-testid="home-recap-row-thread"
              variant="label-medium-default"
              className="truncate leading-normal text-[var(--content-tertiary)]"
            >
              {threadName}
            </Typography>
          ) : null}

          {decisionButtons}
        </div>
      ) : null}
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
        >
          {card}
        </SwipeActionReveal>
      </div>
    </RecapActions>
  );
}
