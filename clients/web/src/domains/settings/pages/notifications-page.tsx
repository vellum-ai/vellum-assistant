import {
    AlertTriangle,
    Bell,
    BellOff,
    Check,
    CheckCheck,
    Loader2,
    Moon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import {
    SNOOZE_OPTIONS,
    formatRelativeDate,
    invalidateNotificationQueries,
    isSnoozed,
} from "@/domains/settings/utils/notification";
import {
    organizationsNotificationsAcknowledgeCreateMutation,
    organizationsNotificationsListOptions,
    organizationsNotificationsPauseRulesCreateMutation,
    organizationsNotificationsPauseRulesDestroyMutation,
    organizationsNotificationsSnoozeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
    NotificationList,
    PauseRuleRead,
} from "@/generated/api/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { toastOnError } from "@/utils/mutation-error";
import { routes } from "@/utils/routes";
import { BottomSheet } from "@vellumai/design-library/components/bottom-sheet";
import { Input } from "@vellumai/design-library/components/input";
import { Menu } from "@vellumai/design-library/components/menu";
import { Notice } from "@vellumai/design-library/components/notice";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Popover } from "@vellumai/design-library/components/popover";
import { toast } from "@vellumai/design-library/components/toast";

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
  const snoozeMutation = useMutation(
    organizationsNotificationsSnoozeCreateMutation(),
  );
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const invalidate = () => invalidateNotificationQueries(queryClient);

  const handleSnooze = (hours: number) => {
    const now = new Date();
    const snoozedUntil = new Date(
      now.getTime() + hours * 60 * 60 * 1000,
    ).toISOString();
    snoozeMutation.mutate(
      {
        path: { id: notificationId },
        body: { snoozed_until: snoozedUntil },
      },
      {
        onSuccess: invalidate,
        onError: toastOnError("Failed to snooze notification"),
      },
    );
  };

  const handleUnsnooze = () => {
    snoozeMutation.mutate(
      {
        path: { id: notificationId },
        body: { snoozed_until: null },
      },
      {
        onSuccess: invalidate,
        onError: toastOnError("Failed to clear snooze"),
      },
    );
  };

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
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
                  if (snoozeMutation.isPending) return;
                  setOpen(false);
                  handleSnooze(hours);
                }}
              />
            ))}
            {currentlySnoozed && (
              <PanelItem
                label="Clear snooze"
                onSelect={() => {
                  if (snoozeMutation.isPending) return;
                  setOpen(false);
                  handleUnsnooze();
                }}
              />
            )}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger>{children}</Menu.Trigger>
      <Menu.Content align="start" className="min-w-[12rem]">
        <Menu.Label>Snooze until…</Menu.Label>
        {SNOOZE_OPTIONS.map(({ label, hours }) => (
          <Menu.Item
            key={label}
            disabled={snoozeMutation.isPending}
            onSelect={() => handleSnooze(hours)}
          >
            {label}
          </Menu.Item>
        ))}
        {currentlySnoozed && (
          <>
            <Menu.Separator />
            <Menu.Item
              disabled={snoozeMutation.isPending}
              onSelect={() => handleUnsnooze()}
            >
              Clear snooze
            </Menu.Item>
          </>
        )}
      </Menu.Content>
    </Menu.Root>
  );
}

interface PauseAlertsContentProps {
  existingRules: PauseRuleRead[];
  onClose: () => void;
  onPauseCreated: (rule: PauseRuleRead) => void;
  onPauseDeleted: (ruleId: string) => void;
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
  const createRule = useMutation(
    organizationsNotificationsPauseRulesCreateMutation(),
  );
  const deleteRule = useMutation(
    organizationsNotificationsPauseRulesDestroyMutation(),
  );
  const [reason, setReason] = useState("");

  const invalidate = () => invalidateNotificationQueries(queryClient);

  const handleCreate = () => {
    const now = new Date();
    const oneYearFromNow = new Date(
      now.getTime() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    createRule.mutate(
      {
        body: {
          notification_type: "alert",
          dedupe_key_prefix: "",
          reason: reason.trim() || "User requested pause",
          expires_at: oneYearFromNow,
        },
      },
      {
        onSuccess: (created) => {
          onPauseCreated(created);
          invalidate();
          onClose();
        },
        onError: toastOnError("Failed to pause alerts"),
      },
    );
  };

  const handleDelete = (ruleId: string) => {
    deleteRule.mutate(
      { path: { rule_id: ruleId } },
      {
        onSuccess: () => {
          onPauseDeleted(ruleId);
          invalidate();
          onClose();
        },
        onError: toastOnError("Failed to resume alerts"),
      },
    );
  };

  const isPending = createRule.isPending || deleteRule.isPending;

  return (
    <div>
      {!hideTitle && (
        <p className="mb-2 text-body-medium-default text-[var(--content-default)]">
          Pause alerts
        </p>
      )}

      {existingRules.length > 0 ? (
        <div className="space-y-2">
          <p className="text-body-small-default text-[var(--content-secondary)]">
            Active pause rules:
          </p>
          {existingRules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-small-default text-[var(--content-default)]">
                  {rule.reason || "All alerts paused"}
                </p>
                {rule.expires_at && (
                  <p className="text-body-small-default text-[var(--content-secondary)]">
                    Expires {formatRelativeDate(rule.expires_at)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(rule.id)}
                disabled={isPending}
                className="ml-2 shrink-0 cursor-pointer rounded px-2 py-1 text-body-small-default text-[var(--system-negative-strong)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Resume
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-body-small-default text-[var(--content-secondary)]">
            Temporarily mute all alert notifications.
          </p>
          <Input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
          />
          <button
            type="button"
            onClick={() => handleCreate()}
            disabled={isPending}
            className="w-full cursor-pointer rounded-md bg-[var(--primary-base)] px-3 py-1.5 text-body-medium-default text-[var(--content-inset)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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

interface NotificationCardProps {
  notification: NotificationList;
  onAck: (id: string, acknowledged: boolean) => void;
  isAcking: boolean;
}

function NotificationCard({
  notification,
  onAck,
  isAcking,
}: NotificationCardProps) {
  const isAlert = notification.notification_type === "alert";
  const snoozedNow = isSnoozed(notification);
  const unread = !notification.is_read;

  return (
    <div
      className="relative rounded-lg border border-[var(--border-base)] p-4"
      style={{
        background: notification.is_resolved
          ? "var(--surface-base)"
          : "var(--surface-lift)",
        opacity: notification.is_resolved ? 0.75 : 1,
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {unread && !notification.is_resolved && (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full bg-[var(--primary-base)]"
              />
            )}
            {isAlert && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--system-negative-strong)_14%,transparent)] px-2 py-0.5 text-body-small-default text-[var(--system-negative-strong)]">
                <AlertTriangle className="h-3 w-3" />
                Alert
              </span>
            )}
            {snoozedNow && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-base)] px-2 py-0.5 text-body-small-default text-[var(--content-secondary)]">
                <Moon className="h-3 w-3" />
                Snoozed
              </span>
            )}
            {notification.is_resolved && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--system-positive-strong)_14%,transparent)] px-2 py-0.5 text-body-small-default text-[var(--system-positive-strong)]">
                <Check className="h-3 w-3" />
                Resolved
              </span>
            )}
          </div>

          <h3
            className="text-body-medium-default leading-tight"
            style={{
              color: notification.is_resolved
                ? "var(--content-secondary)"
                : "var(--content-default)",
            }}
          >
            {notification.title}
          </h3>

          {notification.body && (
            <p className="text-body-small-default leading-relaxed text-[var(--content-secondary)]">
              {notification.body}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-body-small-default text-[var(--content-secondary)]">
        <span>Last seen {formatRelativeDate(notification.last_seen_at)}</span>
        {notification.occurrence_count > 1 && (
          <span>· {notification.occurrence_count}× occurrences</span>
        )}
      </div>

      {!notification.is_resolved && (
        <div className="mt-3 flex items-center gap-2 border-t border-[var(--border-base)] pt-3">
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
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-1.5 text-body-small-default text-[var(--content-secondary)] transition-opacity hover:opacity-80"
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

type StatusFilter = "open" | "resolved";

export function NotificationsPage() {
  // platformHostedOnly: the standard gate would still resolve to "full" for
  // a logged-in platform session pointed at a self-hosted assistant (i.e.
  // platform-mode app + `is_local: true` API response → lifecycle
  // `kind: "self_hosted"`), which is exactly the case we need to hide.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so a
  // fresh deep-link to this page renders with the lifecycle still in
  // `{ kind: "loading" }`. The gate above returns `"full"` during that
  // window (no UI flicker on the page chrome), but firing the org
  // notifications request before lifecycle resolves to platform-hosted
  // would still hit a self-hosted assistant in the race window. Pair
  // the gate value with a strict "positively resolved as platform-hosted"
  // check in the query's `enabled`.
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  // Race-window indicator for UX (showLoading, pause-popover auto-close).
  // Narrow to the genuine lifecycle-loading window: in already-resolved
  // non-hosted states (`retired`, `error`)
  // the query is disabled (above), `data` is undefined → notifications
  // = []; the empty-state branch should render, not a stuck spinner.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseRules, setPauseRules] = useState<PauseRuleRead[]>([]);

  // Notifications are an organization-scoped platform concept — they have no
  // meaningful behavior when the active assistant is self-hosted. The query
  // requires BOTH (a) `platformGate === "full"` (UI is rendering the live
  // surface, not chrome+notice) AND (b) lifecycle positively resolved as
  // platform-hosted (so we never fire during the `loading` window on a
  // deep-link to settings).
  const {
    data,
    isLoading: queryIsLoading,
    isError: queryIsError,
    refetch,
  } = useQuery({
    ...organizationsNotificationsListOptions({
      query: { status: statusFilter },
    }),
    enabled: platformGate === "full" && isPlatformHosted,
  });

  // `useQuery` with `enabled: false` reports `isLoading: false`, so during
  // the lifecycle-loading race we need to compute "still loading"
  // ourselves — otherwise the render falls through to the empty state
  // ("No open notifications") AND mutation-firing controls (pause-rules
  // popover) render interactively. Treat the lifecycle-loading window
  // as loading: hide / disable mutation triggers, show the loading
  // spinner. After the lifecycle resolves (any kind), this falls back
  // to the query's own `isLoading` signal.
  const isResolving = platformGate === "full" && isLifecycleLoading;
  const isLoading = isPlatformHosted ? queryIsLoading : false;
  const showLoading = isResolving || isLoading;

  // The pause-alerts trigger is unmounted whenever `!isPlatformHosted`
  // (below) — that covers both the race window AND already-resolved
  // non-hosted states like `retired` / `error`,
  // where the org-scoped pause-rules mutation has no valid target. Reset
  // `pauseOpen` on the same condition so the popover doesn't re-mount
  // with stale `open={true}` when `isPlatformHosted` flips back true
  // (assistant switch back to hosted, etc.). The structural unmount
  // already closes the popover; this keeps the state honest.
  useEffect(() => {
    if (!isPlatformHosted && pauseOpen) {
      setPauseOpen(false);
    }
  }, [isPlatformHosted, pauseOpen]);

  // The `useQuery` is `enabled: false` in any non-hosted state, but React
  // Query keeps the observer state alive: `data`, `isError`, and the
  // `refetch()` action all survive (and `refetch()` *bypasses* `enabled`
  // by design — manual triggers always fire). If the user loaded
  // notifications while hosted and the lifecycle then moved to a resolved
  // non-hosted state (`retired`, `error`,
  // `self_hosted`) in the same session, ANY surviving query status can
  // render an interactive control whose handler fires an org-scoped
  // request against an org with no platform-hosted target:
  //
  //   - cached `data`  → notification cards render → "Mark all as read"
  //                      / per-row ack / SnoozeMenu mutations.
  //   - cached error   → "Failed to load notifications. Retry" button
  //                      renders → click → manual `refetch()` GET.
  //
  // Mirror the `enabled` predicate at the derivation layer for *every*
  // piece of query state we render. One source of truth (`isPlatformHosted`)
  // collapses both leak surfaces into a single gate without scattering
  // `isPlatformHosted &&` checks across the render tree.
  const isError = isPlatformHosted ? queryIsError : false;
  const notifications = isPlatformHosted ? (data?.results ?? []) : [];
  const unreadOpen = notifications.filter(
    (n) => !n.is_read && !n.is_resolved,
  );

  const ackMutation = useMutation(
    organizationsNotificationsAcknowledgeCreateMutation(),
  );
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);

  const invalidateLists = useCallback(
    () => invalidateNotificationQueries(queryClient),
    [queryClient],
  );

  const handleAck = async (id: string, acknowledged: boolean) => {
    setAckingIds((prev) => new Set(prev).add(id));
    // `ackMutation` is one observer shared by every row, so await this call's
    // own promise (rather than `.mutate` callbacks, which only fire for the
    // latest call) to keep overlapping acks from leaving a row stuck.
    try {
      await ackMutation.mutateAsync({ path: { id }, body: { acknowledged } });
      invalidateLists();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update notification",
      );
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleMarkAllRead = async () => {
    if (unreadOpen.length === 0 || markingAll) return;
    setMarkingAll(true);
    try {
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

  const pauseButton = (
    <button
      type="button"
      className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-1.5 text-body-small-default text-[var(--content-secondary)] transition-opacity hover:opacity-80"
      title="Pause alerts"
    >
      <BellOff className="h-3.5 w-3.5" />
      Pause alerts
    </button>
  );

  const pauseContent = (
    <PauseAlertsContent
      existingRules={pauseRules}
      onClose={() => setPauseOpen(false)}
      onPauseCreated={(rule) => setPauseRules((prev) => [...prev, rule])}
      onPauseDeleted={(ruleId) =>
        setPauseRules((prev) => prev.filter((r) => r.id !== ruleId))
      }
    />
  );

  // The page is fully platform-routed (organization-scoped notifications and
  // pause-rule APIs). On a self-hosted assistant the page is meaningless,
  // so redirect to the general settings page instead of rendering null —
  // a bookmark or shared link should land somewhere reasonable. (Sidebar
  // entry is already filtered out in `settings-layout.tsx`, so the most
  // likely way to reach this state is a deep link or browser back/forward.)
  // Render the page chrome with a login notice when logged out.
  if (platformGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }

  if (platformGate === "disabled") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-[var(--content-secondary)]" />
          <div className="flex-1">
            <h2 className="text-title-medium text-[var(--content-default)]">
              Notifications
            </h2>
            <p className="text-body-medium-lighter text-[var(--content-secondary)]">
              Platform alerts and status notifications
            </p>
          </div>
        </div>
        <PlatformLoginNotice>
          Log in to the Vellum platform to view notifications.
        </PlatformLoginNotice>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Bell className="h-5 w-5 text-[var(--content-secondary)]" />
        <div className="flex-1">
          <h2 className="text-title-medium text-[var(--content-default)]">
            Notifications
          </h2>
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            Platform alerts and status notifications
          </p>
        </div>
        {/*
          Hide the pause-alerts trigger unless the lifecycle is positively
          resolved as platform-hosted. The popover content fires
          `createRule` mutations against the organization — those have no
          valid target during the race window OR in already-resolved
          non-hosted states (`retired`, `error`). Re-renders when
          `isPlatformHosted`
          flips, so the control appears as soon as we know it's safe.
          (Other mutation-firing controls on this page — "Mark all as
          read", per-row ack, snooze — are gated by data-availability:
          `notifications` is explicitly forced to `[]` when
          `!isPlatformHosted` (see derivation above), which covers both
          the disabled-query case AND the surviving-cache case where the
          user loaded notifications while hosted then transitioned to a
          resolved non-hosted state in the same session.)
        */}
        {isPlatformHosted && (
          isMobile ? (
            <BottomSheet.Root open={pauseOpen} onOpenChange={setPauseOpen}>
              <BottomSheet.Trigger asChild>{pauseButton}</BottomSheet.Trigger>
              <BottomSheet.Content>
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
                      setPauseRules((prev) =>
                        prev.filter((r) => r.id !== ruleId),
                      )
                    }
                    hideTitle
                  />
                </BottomSheet.Body>
              </BottomSheet.Content>
            </BottomSheet.Root>
          ) : (
            <Popover.Root open={pauseOpen} onOpenChange={setPauseOpen}>
              <Popover.Trigger asChild>{pauseButton}</Popover.Trigger>
              <Popover.Content align="end" className="w-72">
                {pauseContent}
              </Popover.Content>
            </Popover.Root>
          )
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex gap-1 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] p-1">
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
            onClick={() => void handleMarkAllRead()}
            disabled={markingAll}
            className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-transparent px-3 py-1.5 text-body-small-default text-[var(--content-secondary)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
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

      {showLoading ? (
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading notifications…
        </div>
      ) : isError ? (
        <Notice tone="error">
          Failed to load notifications.{" "}
          <button
            type="button"
            onClick={() => void refetch()}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-base)]">
            <Bell className="h-5 w-5 text-[var(--content-secondary)]" />
          </div>
          <p className="text-body-medium-default text-[var(--content-default)]">
            No {statusFilter} notifications
          </p>
          <p className="text-body-small-default text-[var(--content-secondary)]">
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
              onAck={(id, ack) => void handleAck(id, ack)}
              isAcking={ackingIds.has(notification.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
