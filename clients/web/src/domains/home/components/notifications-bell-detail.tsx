import { ChevronLeft } from "lucide-react";

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
  onBack: () => void;
  onGoToConversation: (conversationId: string) => void;
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
  onBack,
  onGoToConversation,
}: NotificationsBellDetailProps) {
  const conversationId = item.conversationId;
  // Same rule as the Activity page's detail panel, plus a pending case the
  // page doesn't have: the lists start loading when this view opens, so the
  // link is offered until they come back without it rather than withheld until
  // they come back with it. Withholding would drop a footer into a popover the
  // user is already reading, and the notifications that reference background
  // and scheduled jobs are exactly the ones whose lists arrive last.
  const hasValidConversation =
    !!conversationId &&
    (areConversationListsPending || validConversationIds.has(conversationId));

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

      {conversationId && hasValidConversation ? (
        <div className="mt-[var(--app-spacing-sm)] flex items-center justify-end border-t border-[var(--border-base)] pt-[var(--app-spacing-sm)]">
          <Button
            variant="primary"
            onClick={() => onGoToConversation(conversationId)}
          >
            Go to Conversation
          </Button>
        </div>
      ) : null}
    </>
  );
}
