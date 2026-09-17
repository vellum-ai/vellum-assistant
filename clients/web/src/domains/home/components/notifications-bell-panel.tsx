import { Ellipsis, MailCheck, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { useTranslation } from "@/i18n";
import {
  ActionMenu,
  Button,
  Toggle,
  Typography,
} from "@vellumai/design-library";

import { NOTIFICATIONS_PANEL_HEADER_CLASS } from "./notifications-bell-detail";

export interface NotificationsBellPanelProps {
  /** How many notifications the current filter displays. */
  count: number;
  /** Whether at least one eligible notification can be marked read in bulk. */
  canMarkAllRead: boolean;
  /** Whether the list is showing only unread notifications. */
  unreadOnly: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  /**
   * Whether the overflow menu renders at all. The bell withholds it for an
   * assistant without the bulk status route, and when no bulk action can act.
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
 * it, the unread filter and overflow actions, then the content below.
 * Presentational, so the bell owns every query and mutation and this can be
 * seen on its own.
 *
 * The heading's accessible name is the panel's alone. The count beside it is
 * decoration outside the heading element.
 */
export function NotificationsBellPanel({
  count,
  canMarkAllRead,
  unreadOnly,
  onUnreadOnlyChange,
  showsBulkActions,
  isBulkPending = false,
  onMarkAllRead,
  onClearAll,
  children,
}: NotificationsBellPanelProps) {
  const { t } = useTranslation("home");

  return (
    <>
      <div
        className={`${NOTIFICATIONS_PANEL_HEADER_CLASS} justify-between gap-[var(--app-spacing-md)]`}
      >
        <div className="flex min-w-0 items-center gap-[var(--app-spacing-sm)]">
          <Typography
            variant="title-small"
            as="h2"
            className="truncate text-[var(--content-emphasised)]"
          >
            {t("notificationsBell.heading")}
          </Typography>
          <span className="inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-[var(--avatar-accent-fill,var(--system-positive-weak))] px-2 py-0.5">
            <Typography
              variant="body-small-default"
              data-testid="notifications-bell-count"
              className="text-[var(--avatar-accent-ink,var(--system-positive-on-weak))]"
            >
              {count}
            </Typography>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-[var(--app-spacing-sm)]">
          <Typography
            variant="body-medium-default"
            className="text-optical-center text-[var(--content-secondary)]"
          >
            {t("notificationsBell.unread")}
          </Typography>
          <Toggle
            size="sm"
            checked={unreadOnly}
            onChange={onUnreadOnlyChange}
            aria-label={t("notificationsBell.unread")}
            className="flex items-center [&_[role=switch][aria-checked=true]]:bg-[var(--avatar-accent,var(--system-positive-strong))]"
          />
          {showsBulkActions ? (
            <ActionMenu.Root>
              <ActionMenu.Trigger asChild>
                <Button
                  variant="ghost"
                  iconOnly={<Ellipsis />}
                  aria-label={t("notificationsBell.actionsTitle")}
                />
              </ActionMenu.Trigger>
              <ActionMenu.Content
                title={t("notificationsBell.actionsTitle")}
                side="bottom"
                align="end"
              >
                {canMarkAllRead ? (
                  <ActionMenu.Item
                    icon={MailCheck}
                    label={t("actions.markAllAsRead")}
                    onSelect={onMarkAllRead}
                    disabled={isBulkPending}
                  />
                ) : null}
                <ActionMenu.Item
                  icon={Trash2}
                  label={t("actions.clearAll")}
                  onSelect={onClearAll}
                  disabled={isBulkPending}
                  tone="destructive"
                />
              </ActionMenu.Content>
            </ActionMenu.Root>
          ) : null}
        </div>
      </div>

      {children}
    </>
  );
}
