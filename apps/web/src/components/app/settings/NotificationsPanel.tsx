
// TODO: migrate the notification card wrapper to the Card primitive — the
// current bespoke wrapper uses token-based styling identical to Card but
// with opacity/is_resolved variations that don't cleanly map to a Card
// variant yet.

import {
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Loader2,
  Moon,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { BottomSheet } from "@vellum/design-library/components/bottom-sheet";
import { Input } from "@vellum/design-library/components/input";
import { Menu } from "@vellum/design-library/components/menu";
import { Notice } from "@vellum/design-library/components/notice";
import { PanelItem } from "@/components/app/core/PanelItem/PanelItem.js";
import { Popover } from "@vellum/design-library/components/popover";
import { useIsMobile } from "@/lib/hooks/useIsMobile.js";
import {
  organizationsNotificationsAcknowledgeCreateMutation,
  organizationsNotificationsListOptions,
  organizationsNotificationsListQueryKey,
  organizationsNotificationsPauseRulesCreateMutation,
  organizationsNotificationsPauseRulesDestroyMutation,
  organizationsNotificationsSnoozeCreateMutation,
  organizationsNotificationsSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { NotificationList, PauseRuleRead } from "@/generated/api/types.gen.js";
import {
  SNOOZE_OPTIONS,
  formatRelativeDate,
  isSnoozed,
} from "@/lib/notifications/utils.js";

// Re-exported for test compatibility; implementation lives in
// `@/lib/notifications/utils` so it can be shared with the header popover.
export { formatRelativeDate } from "@/lib/notifications/utils.js";

// ---------------------------------------------------------------------------
// Snooze menu (anchored to its trigger button via the Menu primitive)
// ---------------------------------------------------------------------------

interface SnoozeMenuProps {
  notificationId: string;
  currentlySnoozed: boolean;
  children: ReactNode;
}

function SnoozeMenu({
  notificationId,
  currentlySnoozed,
  children,
}: SnoozeMenuProps) {
  const queryClient = useQueryClient();
  const snoozeMutation = useMutation(organizationsNotificationsSnoozeCreateMutation());
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: organizationsNotificationsListQueryKey() });
    queryClient.invalidateQueries({ queryKey: organizationsNotificationsSummaryRetrieveQueryKey() });
  };

  const handleSnooze = async (hours: number) => {
    const now = new Date();
    const snoozedUntil = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
    await snoozeMutation.mutateAsync({
      path: { id: notificationId },
      body: { snoozed_until: snoozedUntil },
    });
    invalidate();
  };

  const handleUnsnooze = async () => {
    await snoozeMutation.mutateAsync({
      path: { id: notificationId },
      body: { snoozed_until: null },
    });
    invalidate();
  };

  return (
    <SnoozeMenuView
      open={open}
      onOpenChange={setOpen}
      pending={snoozeMutation.isPending}
      currentlySnoozed={currentlySnoozed}
      isMobile={isMobile}
      onSnooze={(hours) => void handleSnooze(hours)}
      onUnsnooze={() => void handleUnsnooze()}
    >
      {children}
    </SnoozeMenuView>
  );
}

// ---------------------------------------------------------------------------
// SnoozeMenuView — presentational shell. Exported so the desktop dropdown
// vs mobile bottom-sheet branch can be unit-tested without standing up the
// notifications query/mutation graph.
// ---------------------------------------------------------------------------

export interface SnoozeMenuViewProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  pending: boolean;
  currentlySnoozed: boolean;
  /** Branch hint — production callers pass `useIsMobile()`. */
  isMobile: boolean;
  onSnooze: (hours: number) => void;
  onUnsnooze: () => void;
  children: ReactNode;
}

export function SnoozeMenuView({
  open,
  onOpenChange,
  pending,
  currentlySnoozed,
  isMobile,
  onSnooze,
  onUnsnooze,
  children,
}: SnoozeMenuViewProps) {
  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>{children}</BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header>
            <BottomSheet.Title>Snooze until…</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body>
            {SNOOZE_OPTIONS.map(({ label, hours }) => (
              <PanelItem
                key={label}
                label={label}
                onSelect={() => {
                  if (pending) return;
                  onOpenChange(false);
                  onSnooze(hours);
                }}
              />
            ))}
            {currentlySnoozed ? (
              <PanelItem
                label="Clear snooze"
                onSelect={() => {
                  if (pending) return;
                  onOpenChange(false);
                  onUnsnooze();
                }}
              />
            ) : null}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger>{children}</Menu.Trigger>
      <Menu.Content align="start" className="min-w-[12rem]">
        <Menu.Label>Snooze until…</Menu.Label>
        {SNOOZE_OPTIONS.map(({ label, hours }) => (
          <Menu.Item
            key={label}
            disabled={pending}
            onSelect={() => onSnooze(hours)}
          >
            {label}
          </Menu.Item>
        ))}
        {currentlySnoozed && (
          <>
            <Menu.Separator />
            <Menu.Item disabled={pending} onSelect={() => onUnsnooze()}>
              Clear snooze
            </Menu.Item>
          </>
        )}
      </Menu.Content>
    </Menu.Root>
  );
}

// ---------------------------------------------------------------------------
// Pause alerts popover content (rendered inside a Popover primitive)
// ---------------------------------------------------------------------------

interface PauseAlertsContentProps {
  existingRules: PauseRuleRead[];
  onClose: () => void;
  onPauseCreated: (rule: PauseRuleRead) => void;
  onPauseDeleted: (ruleId: string) => void;
  /**
   * Suppress the inline "Pause alerts" header — the bottom-sheet wrapper
   * renders the title via `BottomSheet.Title` so duplicating it inside the
   * body is noise. Defaults to false to preserve the desktop popover
   * layout.
   */
  hideTitle?: boolean;
}

function PauseAlertsContent({
  existingRules,
  onClose,
  onPauseCreated,
  onPauseDeleted,
  hideTitle = false,
}: PauseAlertsContentProps) {
  const queryClient = useQueryClient();
  const createRule = useMutation(organizationsNotificationsPauseRulesCreateMutation());
  const deleteRule = useMutation(organizationsNotificationsPauseRulesDestroyMutation());
  const [reason, setReason] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: organizationsNotificationsListQueryKey() });
    queryClient.invalidateQueries({ queryKey: organizationsNotificationsSummaryRetrieveQueryKey() });
  };

  const handleCreate = async () => {
    // Far-future expires_at (1 year) so the rule self-expires even if the UI
    // loses track after remount; the list endpoint for rules doesn't exist yet.
    const now = new Date();
    const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const created = await createRule.mutateAsync({
      body: {
        notification_type: "alert",
        dedupe_key_prefix: "",
        reason: reason.trim() || "User requested pause",
        expires_at: oneYearFromNow,
      },
    });
    onPauseCreated(created);
    invalidate();
    onClose();
  };

  const handleDelete = async (ruleId: string) => {
    await deleteRule.mutateAsync({ path: { rule_id: ruleId } });
    onPauseDeleted(ruleId);
    invalidate();
    onClose();
  };

  const isPending = createRule.isPending || deleteRule.isPending;

  return (
    <div>
      {!hideTitle ? (
        <p
          className="mb-2 text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Pause alerts
        </p>
      ) : null}

      {existingRules.length > 0 ? (
        <div className="space-y-2">
          <p
            className="text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            Active pause rules:
          </p>
          {existingRules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between rounded-md px-2 py-2"
              style={{
                background: "var(--surface-base)",
                border: "1px solid var(--border-base)",
              }}
            >
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-body-small-default"
                  style={{ color: "var(--content-default)" }}
                >
                  {rule.reason || "All alerts paused"}
                </p>
                {rule.expires_at && (
                  <p
                    className="text-body-small-default"
                    style={{ color: "var(--content-secondary)" }}
                  >
                    Expires {formatRelativeDate(rule.expires_at)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(rule.id)}
                disabled={isPending}
                className="ml-2 shrink-0 cursor-pointer rounded px-2 py-1 text-body-small-default transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "var(--system-negative-strong)" }}
              >
                Resume
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <p
            className="text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            Temporarily mute all alert notifications.
          </p>
          <Input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            fullWidth
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={isPending}
            className="w-full cursor-pointer rounded-md px-3 py-1.5 text-body-medium-default transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: "var(--primary-base)",
              color: "var(--content-inset)",
            }}
          >
            {createRule.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Pausing…
              </span>
            ) : (
              "Pause all alerts"
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification card
// ---------------------------------------------------------------------------

interface NotificationCardProps {
  notification: NotificationList;
  onAck: (id: string, acknowledged: boolean) => void;
  isAcking: boolean;
}

function NotificationCard({ notification, onAck, isAcking }: NotificationCardProps) {
  const isAlert = notification.notification_type === "alert";
  const snoozedNow = isSnoozed(notification);
  const unread = !notification.is_read;

  return (
    <div
      className="relative rounded-lg p-4"
      style={{
        background: notification.is_resolved
          ? "var(--surface-base)"
          : "var(--surface-lift)",
        border: "1px solid var(--border-base)",
        opacity: notification.is_resolved ? 0.75 : 1,
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {unread && !notification.is_resolved && (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: "var(--primary-base)" }}
              />
            )}
            {isAlert && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-body-small-default"
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
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-body-small-default"
                style={{
                  background: "var(--surface-base)",
                  color: "var(--content-secondary)",
                }}
              >
                <Moon className="h-3 w-3" />
                Snoozed
              </span>
            )}
            {notification.is_resolved && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-body-small-default"
                style={{
                  background: "color-mix(in oklab, var(--system-positive-strong) 14%, transparent)",
                  color: "var(--system-positive-strong)",
                }}
              >
                <Check className="h-3 w-3" />
                Resolved
              </span>
            )}
          </div>

          <h3
            className="!m-0 text-body-medium-default leading-tight"
            style={{
              color: notification.is_resolved
                ? "var(--content-secondary)"
                : "var(--content-default)",
            }}
          >
            {notification.title}
          </h3>

          {notification.body && (
            <p
              className="!m-0 text-body-small-default leading-relaxed"
              style={{ color: "var(--content-secondary)" }}
            >
              {notification.body}
            </p>
          )}
        </div>
      </div>

      <div
        className="mt-3 flex items-center gap-3 text-body-small-default"
        style={{ color: "var(--content-secondary)" }}
      >
        <span>Last seen {formatRelativeDate(notification.last_seen_at)}</span>
        {notification.occurrence_count > 1 && (
          <span>· {notification.occurrence_count}× occurrences</span>
        )}
      </div>

      {!notification.is_resolved && (
        <div
          className="mt-3 flex items-center gap-2 pt-3"
          style={{ borderTop: "1px solid var(--border-base)" }}
        >
          <button
            type="button"
            onClick={() => onAck(notification.id, unread)}
            disabled={isAcking}
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-body-small-default transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: unread
                ? "var(--primary-base)"
                : "var(--surface-base)",
              color: unread
                ? "var(--content-inset)"
                : "var(--content-secondary)",
            }}
          >
            {isAcking ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {unread ? "Mark as read" : "Mark as unread"}
          </button>

          <SnoozeMenu
            notificationId={notification.id}
            currentlySnoozed={snoozedNow}
          >
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-body-small-default transition-opacity hover:opacity-80"
              style={{
                background: "var(--surface-base)",
                color: "var(--content-secondary)",
              }}
            >
              <Moon className="h-3 w-3" />
              {snoozedNow ? "Change snooze" : "Snooze"}
            </button>
          </SnoozeMenu>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

type StatusFilter = "open" | "resolved";

/**
 * NotificationsPanel fetches and renders organization notifications from the
 * Django hub. Supports acknowledge/snooze/pause controls and shows deduped
 * cards. Alert-type notifications receive an explicit "Alert" badge.
 */
export function NotificationsPanel() {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseRules, setPauseRules] = useState<PauseRuleRead[]>([]);

  const { data, isLoading, isError, refetch } = useQuery(
    organizationsNotificationsListOptions({ query: { status: statusFilter } }),
  );

  const notifications = data?.results ?? [];
  const unreadOpen = notifications.filter(
    (n) => !n.is_read && !n.is_resolved,
  );

  const ackMutation = useMutation(organizationsNotificationsAcknowledgeCreateMutation());
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);

  const invalidateLists = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: organizationsNotificationsListQueryKey() });
    queryClient.invalidateQueries({ queryKey: organizationsNotificationsSummaryRetrieveQueryKey() });
  }, [queryClient]);

  const handleAck = async (id: string, acknowledged: boolean) => {
    setAckingIds((prev) => new Set(prev).add(id));
    try {
      await ackMutation.mutateAsync({
        path: { id },
        body: { acknowledged },
      });
      invalidateLists();
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleMarkAllRead = async () => {
    if (unreadOpen.length === 0 || markingAll) {
      return;
    }
    setMarkingAll(true);
    try {
      // Use allSettled so a single failed ack doesn't skip invalidation for
      // the ones that succeeded; refresh regardless of partial failures.
      await Promise.allSettled(
        unreadOpen.map((n) =>
          ackMutation.mutateAsync({
            path: { id: n.id },
            body: { acknowledged: true },
          }),
        ),
      );
    } finally {
      invalidateLists();
      setMarkingAll(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Bell
          className="h-5 w-5"
          style={{ color: "var(--content-secondary)" }}
        />
        <div className="flex-1">
          <h2
            className="!m-0 text-title-medium"
            style={{ color: "var(--content-default)" }}
          >
            Notifications
          </h2>
          <p
            className="!m-0 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            Platform alerts and status notifications
          </p>
        </div>
        {isMobile ? (
          <BottomSheet.Root open={pauseOpen} onOpenChange={setPauseOpen}>
            <BottomSheet.Trigger asChild>
              <button
                type="button"
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-body-small-default transition-opacity hover:opacity-80"
                style={{
                  background: "var(--surface-base)",
                  color: "var(--content-secondary)",
                  border: "1px solid var(--border-base)",
                }}
                title="Pause alerts"
              >
                <BellOff className="h-3.5 w-3.5" />
                Pause alerts
              </button>
            </BottomSheet.Trigger>
            <BottomSheet.Content aria-label="Pause alerts">
              <BottomSheet.Header>
                <BottomSheet.Title>Pause alerts</BottomSheet.Title>
              </BottomSheet.Header>
              <BottomSheet.Body>
                <PauseAlertsContent
                  existingRules={pauseRules}
                  onClose={() => setPauseOpen(false)}
                  onPauseCreated={(rule) =>
                    setPauseRules((prev) => [...prev, rule])
                  }
                  onPauseDeleted={(ruleId) =>
                    setPauseRules((prev) => prev.filter((r) => r.id !== ruleId))
                  }
                  /* In the bottom sheet, the BottomSheet.Header already
                     renders the "Pause alerts" title — suppress the inline
                     duplicate that the desktop popover renders. */
                  hideTitle
                />
              </BottomSheet.Body>
            </BottomSheet.Content>
          </BottomSheet.Root>
        ) : (
          <Popover.Root open={pauseOpen} onOpenChange={setPauseOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-body-small-default transition-opacity hover:opacity-80"
                style={{
                  background: "var(--surface-base)",
                  color: "var(--content-secondary)",
                  border: "1px solid var(--border-base)",
                }}
                title="Pause alerts"
              >
                <BellOff className="h-3.5 w-3.5" />
                Pause alerts
              </button>
            </Popover.Trigger>
            <Popover.Content align="end" className="w-72" aria-label="Pause alerts">
              <PauseAlertsContent
                existingRules={pauseRules}
                onClose={() => setPauseOpen(false)}
                onPauseCreated={(rule) =>
                  setPauseRules((prev) => [...prev, rule])
                }
                onPauseDeleted={(ruleId) =>
                  setPauseRules((prev) => prev.filter((r) => r.id !== ruleId))
                }
              />
            </Popover.Content>
          </Popover.Root>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div
          className="flex gap-1 rounded-md p-1"
          style={{
            background: "var(--surface-base)",
            border: "1px solid var(--border-base)",
          }}
        >
          {(["open", "resolved"] as const).map((f) => {
            const active = statusFilter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className="cursor-pointer rounded px-3 py-1 text-body-small-default capitalize transition-colors"
                style={{
                  background: active ? "var(--surface-lift)" : "transparent",
                  color: active
                    ? "var(--content-default)"
                    : "var(--content-secondary)",
                  boxShadow: active
                    ? "0 1px 2px rgba(0,0,0,0.08)"
                    : undefined,
                }}
              >
                {f}
              </button>
            );
          })}
        </div>

        {statusFilter === "open" && unreadOpen.length > 1 && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={markingAll}
            className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-body-small-default transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--content-secondary)",
              border: "1px solid var(--border-base)",
            }}
          >
            {markingAll ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCheck className="h-3 w-3" />
            )}
            Mark all as read ({unreadOpen.length})
          </button>
        )}
      </div>

      {isLoading ? (
        <div
          className="flex items-center gap-2 py-6 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notifications…
        </div>
      ) : isError ? (
        <Notice tone="error">
          Failed to load notifications.{" "}
          <button
            type="button"
            onClick={() => refetch()}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: "var(--surface-base)" }}
          >
            <Bell
              className="h-5 w-5"
              style={{ color: "var(--content-secondary)" }}
            />
          </div>
          <p
            className="!m-0 text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            No {statusFilter} notifications
          </p>
          <p
            className="!m-0 text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {statusFilter === "open"
              ? "You're all caught up!"
              : "Nothing to show here."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => (
            <NotificationCard
              key={notification.id}
              notification={notification}
              onAck={handleAck}
              isAcking={ackingIds.has(notification.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
