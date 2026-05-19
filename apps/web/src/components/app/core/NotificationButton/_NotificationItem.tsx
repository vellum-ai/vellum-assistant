
import { AlertTriangle, Check, Loader2, Moon } from "lucide-react";

import type { NotificationList } from "@/generated/api/types.gen.js";
import { formatRelativeDate, isSnoozed } from "@/lib/notifications/utils.js";

interface NotificationItemProps {
  notification: NotificationList;
  onAck: (id: string) => void;
  isAcking: boolean;
}

/**
 * Compact row used inside the header popover. Shows the title, body snippet,
 * last-seen time, a type chip, and a single-click "mark as read" action.
 * Snooze/unsnooze and full controls live on the Settings → Notifications page.
 */
export function NotificationItem({ notification, onAck, isAcking }: NotificationItemProps) {
  const isAlert = notification.notification_type === "alert";
  const snoozedNow = isSnoozed(notification);
  const unread = !notification.is_read;

  return (
    <div
      className="group flex items-start gap-3 px-4 py-3 transition-colors"
      style={{
        background: unread ? "var(--surface-base)" : "transparent",
        borderBottom: "1px solid var(--border-base)",
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {unread && (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: "var(--primary-base)" }}
            />
          )}
          {isAlert && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-small-default"
              style={{
                background: "color-mix(in oklab, var(--system-negative-strong) 14%, transparent)",
                color: "var(--system-negative-strong)",
              }}
            >
              <AlertTriangle className="h-3 w-3" />
              Alert
            </span>
          )}
          {snoozedNow && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-small-default"
              style={{
                background: "var(--surface-base)",
                color: "var(--content-secondary)",
              }}
            >
              <Moon className="h-3 w-3" />
              Snoozed
            </span>
          )}
          <span
            className={"ml-auto shrink-0 text-[11px]" /* typography: off-scale — 11px off-scale */}
            style={{ color: "var(--content-secondary)" }}
          >
            {formatRelativeDate(notification.last_seen_at)}
          </span>
        </div>
        <p
          className="truncate text-body-medium-default leading-tight"
          style={{ color: "var(--content-default)" }}
          title={notification.title}
        >
          {notification.title}
        </p>
        {notification.body && (
          <p
            className="line-clamp-2 text-body-small-default leading-snug"
            style={{ color: "var(--content-secondary)" }}
          >
            {notification.body}
          </p>
        )}
      </div>

      {unread && (
        <button
          type="button"
          onClick={() => onAck(notification.id)}
          disabled={isAcking}
          aria-label="Mark as read"
          title="Mark as read"
          className="mt-1 shrink-0 rounded-md p-1 opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            color: "var(--content-secondary)",
          }}
        >
          {isAcking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  );
}
