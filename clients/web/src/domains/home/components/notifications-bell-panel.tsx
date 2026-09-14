import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { MidlineDot } from "@/components/midline-dot";
import { useTranslation } from "@/i18n";
import { Button, Typography } from "@vellumai/design-library";

import { NOTIFICATIONS_PANEL_HEADER_CLASS } from "./notifications-bell-detail";

export interface NotificationsBellPanelProps {
  /** How many notifications the panel holds; shown beside the heading when
   * there are any. */
  count: number;
  /** Whether any of them is unread, which is what earns "Mark all as read". */
  hasUnread: boolean;
  /**
   * Whether the bulk footer renders at all. The bell withholds it for a
   * daemon without the bulk status route, and for an empty panel.
   */
  showsBulkActions: boolean;
  /** True while a bulk mutation is in flight, holding both buttons inert. */
  isBulkPending?: boolean;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  /** The list, the empty state, or the failure notice. */
  children: ReactNode;
}

/**
 * The bell's list view: a header naming the panel and counting what is in
 * it, the content between, and a footer of bulk actions. Presentational, so
 * the bell owns every query and mutation and this can be seen on its own.
 *
 * The heading's accessible name is the panel's alone: the count beside it
 * and the dot between them are decoration outside the heading element.
 */
export function NotificationsBellPanel({
  count,
  hasUnread,
  showsBulkActions,
  isBulkPending = false,
  onMarkAllRead,
  onClearAll,
  children,
}: NotificationsBellPanelProps) {
  const { t } = useTranslation("home");

  return (
    <>
      <div className={`${NOTIFICATIONS_PANEL_HEADER_CLASS} gap-[6px]`}>
        <Typography
          variant="title-small"
          as="h2"
          className="text-[var(--content-emphasised)]"
        >
          {t("notificationsBell.heading")}
        </Typography>
        {count > 0 ? (
          <>
            <MidlineDot />
            <Typography
              variant="title-small"
              data-testid="notifications-bell-count"
              className="text-[var(--content-secondary)]"
            >
              {count}
            </Typography>
          </>
        ) : null}
      </div>

      {children}

      {showsBulkActions ? (
        <div className="flex items-center justify-end gap-[var(--app-spacing-sm)] border-t border-[var(--border-subtle)] p-[var(--app-spacing-lg)]">
          {hasUnread ? (
            <Button
              variant="ghost"
              onClick={onMarkAllRead}
              disabled={isBulkPending}
            >
              {t("actions.markAllAsRead")}
            </Button>
          ) : null}
          <Button
            variant="outlined"
            leftIcon={<Trash2 />}
            onClick={onClearAll}
            disabled={isBulkPending}
          >
            {t("actions.clearAll")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
