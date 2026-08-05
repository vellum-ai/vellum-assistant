import {
  Calendar,
  ChevronLeft,
  Mail,
  MailOpen,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { Button, Tag, Typography } from "@vellumai/design-library";

import { HomeGenericDetail } from "../detail-panel/home-generic-detail";
import { HomeToolPermissionCard } from "../detail-panel/home-tool-permission-card";
import { getFeedItemScheduleId, resolveFeedItemTitle } from "../utils";

/**
 * Layout of the panel's header row. Shared with the notifications list so the
 * header occupies the same box in both views and the popover keeps its shape
 * when they swap.
 */
export const NOTIFICATIONS_PANEL_HEADER_CLASS =
  "mb-[var(--app-spacing-sm)] flex min-h-8 items-center gap-[var(--app-spacing-xs)]";

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
  /** True while an action item's conversation is being created. */
  isActionPending: boolean;
  onBack: () => void;
  onGoToConversation: (conversationId: string) => void;
  onViewSchedule: (scheduleId: string) => void;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
  onDismiss: (itemId: string) => void;
  onTriggerAction: (actionId: string) => void;
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
  isActionPending,
  onBack,
  onGoToConversation,
  onViewSchedule,
  onUpdateStatus,
  onDismiss,
  onTriggerAction,
}: NotificationsBellDetailProps) {
  const conversationId = item.conversationId ?? null;
  const scheduleId = getFeedItemScheduleId(item);
  const isUnread = item.status === "new";
  const isDismissed = item.status === "dismissed";
  const actions = item.actions ?? [];

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
          {resolveFeedItemTitle(item)}
        </Typography>

        {/*
          Status actions ride in the header as icon-only buttons, the
          arrangement and labelling the Activity panel's mobile nav bar uses.
          The pair holds its own width opposite the back control, leaving the
          title the rest of the row to truncate into rather than pushing the
          header onto a second line.
        */}
        <div className="flex shrink-0 items-center gap-[var(--app-spacing-xs)]">
          <Button
            variant="ghost"
            iconOnly={isUnread ? <MailOpen /> : <Mail />}
            onClick={() => onUpdateStatus(item.id, isUnread ? "seen" : "new")}
            aria-label={isUnread ? "Mark as read" : "Mark as unread"}
            tooltip={isUnread ? "Mark as read" : "Mark as unread"}
          />
          {isDismissed ? (
            <Button
              variant="ghost"
              iconOnly={<RotateCcw />}
              onClick={() => onUpdateStatus(item.id, "seen")}
              aria-label="Restore"
              tooltip="Restore"
            />
          ) : (
            <Button
              variant="ghost"
              iconOnly={<Trash2 />}
              onClick={() => onDismiss(item.id)}
              aria-label="Dismiss"
              tooltip="Dismiss"
            />
          )}
        </div>
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

        {/*
          The assistant's own offers on this notification, so they sit with the
          content rather than in the footer of navigation links. Each one starts
          a fresh conversation, so all of them go inert together while one is in
          flight and no second conversation can be opened by a double click. A
          label longer than the panel truncates instead of widening the row.
        */}
        {actions.length > 0 ? (
          <div
            data-testid="notifications-bell-detail-actions"
            className="mt-[var(--app-spacing-md)] flex flex-wrap gap-[var(--app-spacing-sm)]"
          >
            {actions.map((action) => (
              <Button
                key={action.id}
                variant="outlined"
                className="max-w-full"
                disabled={isActionPending}
                onClick={() => onTriggerAction(action.id)}
              >
                <Typography
                  variant="body-medium-default"
                  className="min-w-0 truncate"
                >
                  {action.label}
                </Typography>
              </Button>
            ))}
          </div>
        ) : null}
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
