import {
    ArrowLeft,
    Calendar,
    Mail,
    MailOpen,
    RotateCcw,
    Trash2,
    X,
} from "lucide-react";

import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";
import type {
    FeedItem,
    FeedItemCategory,
    FeedItemStatus,
} from "@vellumai/assistant-api";
import { Button, Tag, Typography } from "@vellumai/design-library";
import { CATEGORY_STYLES } from "../home-feed-filter-bar";
import { HomeGenericDetail } from "./home-generic-detail";
import { HomeToolPermissionCard } from "./home-tool-permission-card";

function resolveCategoryStyle(category?: FeedItemCategory) {
  if (category && CATEGORY_STYLES[category]) {
    return CATEGORY_STYLES[category];
  }
  return CATEGORY_STYLES.system;
}

// The header shows the item's own title when it has one. Many feed items omit
// a distinct title — for those, falling back to `summary` (which is also the
// body) duplicates the same text, so we surface the category label instead.
function resolveHeaderTitle(item: FeedItem): string {
  if (item.title) return item.title;
  if (item.category) {
    return item.category.charAt(0).toUpperCase() + item.category.slice(1);
  }
  return "Notification";
}

export interface HomeDetailPanelProps {
  item: FeedItem | null;
  isMobile?: boolean;
  validConversationIds: Set<string>;
  onClose: () => void;
  onGoToThread: (conversationId: string) => void;
  onUpdateStatus: (itemId: string, status: FeedItemStatus) => void;
  onDismiss: (itemId: string) => void;
  /**
   * Provided only when this item originated from a schedule that still exists.
   * Opens the Schedules page with that schedule selected.
   */
  onViewSchedule?: () => void;
}

export function HomeDetailPanel({
  item,
  isMobile,
  validConversationIds,
  onClose,
  onGoToThread,
  onUpdateStatus,
  onDismiss,
  onViewSchedule,
}: HomeDetailPanelProps) {
  if (!item) {
    return null;
  }

  const panelKind = item.detailPanel?.kind;
  const headerTitle = resolveHeaderTitle(item);
  const categoryStyle = resolveCategoryStyle(item.category);
  const CategoryIcon = categoryStyle.icon;
  const isUnread = item.status === "new";
  const isDismissed = item.status === "dismissed";
  const hasValidConversation =
    !!item.conversationId && validConversationIds.has(item.conversationId);

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-[var(--surface-overlay)]">
        {/* Nav bar */}
        <div className="relative flex shrink-0 items-center px-3 py-2">
          <Button
            variant="ghost"
            iconOnly={<ArrowLeft />}
            onClick={onClose}
            aria-label="Back"
            tooltip="Back"
          />

          <Typography
            variant="body-medium-default"
            className="pointer-events-none absolute inset-x-0 text-center text-[var(--content-secondary)]"
          >
            Details
          </Typography>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              iconOnly={isUnread ? <MailOpen /> : <Mail />}
              onClick={() =>
                onUpdateStatus(item.id, isUnread ? "seen" : "new")
              }
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

        {/* Detail header */}
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            className="flex shrink-0 items-center justify-center rounded-full"
            style={{
              width: 40,
              height: 40,
              backgroundColor: categoryStyle.weak,
            }}
            aria-hidden="true"
          >
            <CategoryIcon
              width={18}
              height={18}
              style={{ color: categoryStyle.strong }}
            />
          </span>
          <Typography
            variant="title-small"
            className="min-w-0 text-[var(--content-default)]"
          >
            {headerTitle}
          </Typography>
          <Tag
            tone="neutral"
            className="shrink-0"
            title={formatFullLocalDate(item.timestamp)}
          >
            {formatRelativeDate(item.timestamp)}
          </Tag>
        </div>

        {/* Divider */}
        <div className="mx-4 border-b border-[var(--border-disabled)]" />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4">
          {panelKind === "toolPermission" ? (
            <HomeToolPermissionCard item={item} />
          ) : (
            <HomeGenericDetail item={item} />
          )}
        </div>

        {/* Bottom CTA */}
        {hasValidConversation || onViewSchedule ? (
          <div className="flex shrink-0 flex-col gap-2 px-4 pb-4 pt-2">
            {onViewSchedule ? (
              <Button
                variant="outlined"
                fullWidth
                leftIcon={<Calendar className="size-4" />}
                onClick={onViewSchedule}
              >
                View schedule
              </Button>
            ) : null}
            {hasValidConversation ? (
              <Button
                variant="primary"
                fullWidth
                onClick={() => onGoToThread(item.conversationId!)}
              >
                Go to Conversation
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-[var(--radius-xl)] border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      {/* Header */}
      <div className="flex items-center gap-[var(--app-spacing-sm)] border-b border-[var(--border-base)] p-[var(--app-spacing-lg)]">
        <span
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 28,
            height: 28,
            backgroundColor: categoryStyle.weak,
          }}
          aria-hidden="true"
        >
          <CategoryIcon
            width={14}
            height={14}
            style={{ color: categoryStyle.strong }}
          />
        </span>

        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-default)]"
        >
          {headerTitle}
        </Typography>

        {hasValidConversation ? (
          <Button
            variant="outlined"
            onClick={() => onGoToThread(item.conversationId!)}
          >
            Go to Convo
          </Button>
        ) : null}

        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close detail panel"
          tooltip="Close"
        />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-[var(--app-spacing-lg)]">
        {panelKind === "toolPermission" ? (
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

      {/* Footer actions */}
      <div className="flex shrink-0 items-center justify-between gap-[var(--app-spacing-sm)] border-t border-[var(--border-base)] p-[var(--app-spacing-lg)]">
        <div>
          {onViewSchedule ? (
            <Button
              variant="outlined"
              leftIcon={<Calendar className="size-4" />}
              onClick={onViewSchedule}
            >
              View schedule
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-[var(--app-spacing-sm)]">
          {isDismissed ? (
            <Button
              variant="primary"
              onClick={() => onUpdateStatus(item.id, "seen")}
            >
              Restore
            </Button>
          ) : (
            <>
              <Button
                variant="outlined"
                onClick={() =>
                  onUpdateStatus(item.id, isUnread ? "seen" : "new")
                }
              >
                {isUnread ? "Mark as read" : "Mark as unread"}
              </Button>
              <Button variant="primary" onClick={() => onDismiss(item.id)}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
