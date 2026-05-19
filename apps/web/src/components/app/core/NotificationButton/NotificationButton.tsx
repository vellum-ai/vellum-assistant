
import { Bell } from "lucide-react";
import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Popover } from "@vellum/design-library/components/popover";
import { organizationsNotificationsSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { useAuth } from "@/lib/auth.js";

import { NotificationPopover } from "@/components/app/core/NotificationButton/_NotificationPopover.js";

const POLL_INTERVAL_MS = 60_000;

export function NotificationButton() {
  const { isLoggedIn } = useAuth();
  const [open, setOpen] = useState(false);

  const { data: summary } = useQuery({
    ...organizationsNotificationsSummaryRetrieveOptions(),
    refetchInterval: POLL_INTERVAL_MS,
    enabled: isLoggedIn,
  });

  const close = useCallback(() => setOpen(false), []);

  const unreadCount = summary?.unread_count ?? 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:opacity-80"
          style={{
            background: "var(--surface-base)",
            color: "var(--content-secondary)",
          }}
          aria-label={
            unreadCount > 0
              ? `Notifications (${unreadCount} unread)`
              : "Notifications"
          }
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--system-negative-strong)] px-1 text-label-small-default leading-none text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={8}
        className="w-[360px] overflow-hidden p-0"
        aria-label="Notifications"
      >
        <NotificationPopover onClose={close} />
      </Popover.Content>
    </Popover.Root>
  );
}
