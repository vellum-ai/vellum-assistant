import { Calendar, ChevronLeft } from "lucide-react";

import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";
import type { FeedItem } from "@vellumai/assistant-api";
import { Button, Tag, Typography } from "@vellumai/design-library";

import { HomeGenericDetail } from "../detail-panel/home-generic-detail";
import { HomeToolPermissionCard } from "../detail-panel/home-tool-permission-card";
import { flattenSummary } from "../feed-preview";

/**
 * Layout of the panel's header row. Shared with the notifications list so the
 * header occupies the same box in both views and the popover keeps its shape
 * when they swap.
 */
export const NOTIFICATIONS_PANEL_HEADER_CLASS =
  "mb-[var(--app-spacing-sm)] flex min-h-8 items-center gap-[var(--app-spacing-xs)]";

/** Name for an item with neither a title nor a summary that renders as text. */
const UNNAMED_ITEM_TITLE = "Notification";

/**
 * Header name for a feed item: the same text its list row carries, so the
 * title the user clicked is the title they land on. `summary` is markdown, so
 * the fallback goes through the flattener rather than showing syntax.
 */
export function resolveNotificationTitle(item: FeedItem): string {
  const resolved = item.title ?? flattenSummary(item.summary);
  return resolved.length > 0 ? resolved : UNNAMED_ITEM_TITLE;
}

/**
 * Scheduled-run notifications (`schedule.notify`) carry their originating
 * schedule id in `metadata.scheduleId`, letting the detail link to the
 * schedule. Returns null for feed items not tied to a schedule.
 */
function getFeedItemScheduleId(item: FeedItem): string | null {
  const id = item.metadata?.scheduleId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface NotificationsBellDetailProps {
  item: FeedItem;
  /**
   * Max-height class for the scrollable body. The bell passes the cap it uses
   * for the list, so the panel never jumps height between the two views.
   */
  bodyMaxHeightClass: string;
  /**
   * Ids of the conversations that still exist, merged from the foreground,
   * background, and scheduled lists exactly as the Activity page merges them.
   */
  validConversationIds: Set<string>;
  /** True while any of those lists has yet to resolve. */
  areConversationListsPending: boolean;
  /** Ids of the schedules that still exist, from the Schedules page's list. */
  validScheduleIds: Set<string>;
  /** True while that list has yet to resolve. */
  isScheduleListPending: boolean;
  onBack: () => void;
  onGoToConversation: (conversationId: string) => void;
  onViewSchedule: (scheduleId: string) => void;
}

/**
 * One notification's detail, rendered inside the bell in place of the list.
 * The body renderers and the panel-kind rule are the Activity page's, so a
 * notification reads the same wherever it is opened from.
 */
export function NotificationsBellDetail({
  item,
  bodyMaxHeightClass,
  validConversationIds,
  areConversationListsPending,
  validScheduleIds,
  isScheduleListPending,
  onBack,
  onGoToConversation,
  onViewSchedule,
}: NotificationsBellDetailProps) {
  const conversationId = item.conversationId ?? null;
  const scheduleId = getFeedItemScheduleId(item);

  // Same rule as the Activity page's detail panel, plus a pending case the
  // page doesn't have: the lists start loading when this view opens. Every
  // list a candidate link depends on has to land before any link becomes
  // reachable, so the two buttons settle together rather than one at a time
  // and a deleted target is never linked to.
  const isValidationPending =
    (conversationId !== null && areConversationListsPending) ||
    (scheduleId !== null && isScheduleListPending);

  // A link the lists have yet to vouch for still renders, holding the row it
  // will occupy so the panel keeps its height once validation resolves. One
  // whose target turns out to be gone drops out, and a footer left with none
  // of them collapses away rather than holding empty space.
  const linkedConversationId =
    conversationId !== null &&
    (isValidationPending || validConversationIds.has(conversationId))
      ? conversationId
      : null;
  const linkedScheduleId =
    scheduleId !== null &&
    (isValidationPending || validScheduleIds.has(scheduleId))
      ? scheduleId
      : null;

  // `visibility: hidden` keeps a pending link's box while taking it out of the
  // accessibility tree, `inert` blocks pointer and keyboard interaction, and
  // the click handlers below stay unwired until validation resolves.
  const pendingLinkProps = {
    className: isValidationPending ? "invisible" : undefined,
    inert: isValidationPending,
    "aria-hidden": isValidationPending || undefined,
  };

  return (
    <>
      <div className={NOTIFICATIONS_PANEL_HEADER_CLASS}>
        <Button
          variant="ghost"
          iconOnly={<ChevronLeft />}
          onClick={onBack}
          aria-label="Back to notifications"
        />
        <Typography
          variant="body-medium-default"
          as="h2"
          className="min-w-0 flex-1 truncate text-[var(--content-default)]"
        >
          {resolveNotificationTitle(item)}
        </Typography>
      </div>

      <div
        className={`overflow-y-auto px-[var(--app-spacing-md)] ${bodyMaxHeightClass}`}
      >
        {item.detailPanel?.kind === "toolPermission" ? (
          <HomeToolPermissionCard item={item} />
        ) : (
          <HomeGenericDetail item={item} />
        )}
        <div className="mt-[var(--app-spacing-md)]">
          <Tag tone="neutral" title={formatFullLocalDate(item.timestamp)}>
            {formatRelativeDate(item.timestamp)}
          </Tag>
        </div>
      </div>

      {linkedScheduleId || linkedConversationId ? (
        // Both links can be offered at once. They sit on one right-aligned row
        // at the popover's width and wrap onto a second one below it in the
        // narrowest bottom sheets, so neither ever overflows the panel.
        <div
          data-testid="notifications-bell-detail-footer"
          className="mt-[var(--app-spacing-sm)] flex flex-wrap items-center justify-end gap-[var(--app-spacing-sm)] border-t border-[var(--border-base)] pt-[var(--app-spacing-sm)]"
        >
          {linkedScheduleId ? (
            <Button
              variant="outlined"
              leftIcon={<Calendar className="size-4" />}
              onClick={
                isValidationPending
                  ? undefined
                  : () => onViewSchedule(linkedScheduleId)
              }
              {...pendingLinkProps}
            >
              View schedule
            </Button>
          ) : null}
          {linkedConversationId ? (
            <Button
              variant="primary"
              onClick={
                isValidationPending
                  ? undefined
                  : () => onGoToConversation(linkedConversationId)
              }
              {...pendingLinkProps}
            >
              Go to Conversation
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
