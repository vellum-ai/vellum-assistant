
import { Bell, Loader2, Settings as SettingsIcon } from "lucide-react";
import { AppLink as Link } from "@/adapters/app-link.js";
import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  organizationsNotificationsAcknowledgeCreateMutation,
  organizationsNotificationsListOptions,
  organizationsNotificationsListQueryKey,
  organizationsNotificationsSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { routes } from "@/lib/routes.js";

import { NotificationItem } from "@/components/app/core/NotificationButton/_NotificationItem.js";

const MAX_ITEMS = 6;

interface NotificationPopoverProps {
  onClose: () => void;
}

/**
 * Contents of the header notifications dropdown. Fetches the list of open
 * notifications (read + unread) scoped to the current organization and renders
 * up to MAX_ITEMS with unread sorted first. Provides a footer link to the full
 * Settings → Notifications page for management.
 */
export function NotificationPopover({ onClose }: NotificationPopoverProps) {
  const queryClient = useQueryClient();
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery(
    organizationsNotificationsListOptions({ query: { status: "open" } }),
  );

  const ackMutation = useMutation(organizationsNotificationsAcknowledgeCreateMutation());

  const handleAck = async (id: string) => {
    setAckingIds((prev) => new Set(prev).add(id));
    try {
      await ackMutation.mutateAsync({
        path: { id },
        body: { acknowledged: true },
      });
      queryClient.invalidateQueries({ queryKey: organizationsNotificationsListQueryKey() });
      queryClient.invalidateQueries({ queryKey: organizationsNotificationsSummaryRetrieveQueryKey() });
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const notifications = data?.results ?? [];
  const sorted = [...notifications].sort((a, b) => {
    if (a.is_read === b.is_read) {
      return 0;
    }
    return a.is_read ? 1 : -1;
  });
  const visible = sorted.slice(0, MAX_ITEMS);
  const hiddenCount = Math.max(0, sorted.length - visible.length);

  return (
    <div className="flex flex-col">
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--border-base)" }}
      >
        <p
          className="!m-0 text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Notifications
        </p>
        <Link
          href={routes.settings.notifications}
          onClick={onClose}
          className="flex items-center gap-1 text-body-small-default !no-underline transition-opacity hover:opacity-80"
          style={{ color: "var(--content-secondary)" }}
          title="Open notifications settings"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
          Manage
        </Link>
      </div>

      {isLoading ? (
        <div
          className="flex items-center gap-2 px-4 py-6 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notifications…
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-body-medium-lighter">
          <p className="!m-0" style={{ color: "var(--content-secondary)" }}>
            Failed to load notifications.{" "}
            <button
              type="button"
              onClick={() => refetch()}
              className="cursor-pointer underline hover:no-underline"
              style={{ color: "var(--content-default)" }}
            >
              Retry
            </button>
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
          <Bell
            className="h-5 w-5"
            style={{ color: "var(--content-secondary)" }}
          />
          <p
            className="!m-0 text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            You&apos;re all caught up
          </p>
          <p
            className="!m-0 text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            No open notifications.
          </p>
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {visible.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onAck={handleAck}
              isAcking={ackingIds.has(notification.id)}
            />
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <Link
          href={routes.settings.notifications}
          onClick={onClose}
          className="flex items-center justify-center gap-1 px-4 py-2.5 text-body-small-default !no-underline transition-opacity hover:opacity-80"
          style={{
            color: "var(--content-secondary)",
            borderTop: "1px solid var(--border-base)",
          }}
        >
          {hiddenCount > 0
            ? `View all (${data?.count ?? sorted.length})`
            : "View all notifications"}
        </Link>
      )}
    </div>
  );
}
