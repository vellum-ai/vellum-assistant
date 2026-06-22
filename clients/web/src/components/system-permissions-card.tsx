import { useEffect, useMemo, useState } from "react";

import { setDockBadge } from "@/runtime/dock";
import {
  openSystemPermissionSettings,
  requestSystemPermission,
  useSystemPermissionsState,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
} from "@/runtime/system-permissions";
import {
  getDeviceBool,
  setDeviceBool,
  watchDeviceSetting,
} from "@/utils/device-settings";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { cn } from "@vellumai/design-library/utils/cn";

type LocalPermissionRowId = "notificationBadges";
type PermissionRowId = SystemPermissionKind | LocalPermissionRowId;

interface SystemPermissionRowMeta {
  id: SystemPermissionKind;
  type: "system";
  sourceKind: SystemPermissionKind;
  label: string;
  description: string;
}

interface LocalPermissionRowMeta {
  id: LocalPermissionRowId;
  type: "local";
  label: string;
  description: string;
}

interface PermissionRowViewModel {
  id: PermissionRowId;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  error?: string;
}

const SYSTEM_PERMISSION_ROWS: SystemPermissionRowMeta[] = [
  {
    id: "accessibility",
    type: "system",
    sourceKind: "accessibility",
    label: "Accessibility",
    description:
      "Allows your assistant to click, type, and control apps on your behalf.",
  },
  {
    id: "screen",
    type: "system",
    sourceKind: "screen",
    label: "Screen Recording",
    description:
      "Allows your assistant to capture screen context during computer-use tasks.",
  },
  {
    id: "microphone",
    type: "system",
    sourceKind: "microphone",
    label: "Microphone",
    description:
      "Allows your assistant to capture audio for voice input and recordings.",
  },
  {
    id: "speechRecognition",
    type: "system",
    sourceKind: "speechRecognition",
    label: "Speech Recognition",
    description:
      "Allows your assistant to transcribe your speech into text on-device.",
  },
  {
    id: "notifications",
    type: "system",
    sourceKind: "notifications",
    label: "Notifications",
    description:
      "Allows your assistant to send macOS alerts for approvals, messages, and task updates.",
  },
];

const LOCAL_PERMISSION_ROWS: LocalPermissionRowMeta[] = [
  {
    id: "notificationBadges",
    type: "local",
    label: "Notification Badges",
    description:
      "Allows your assistant to show unseen conversation counts on the Dock icon.",
  },
];

function usePendingKind() {
  const [pendingKind, setPendingKind] = useState<PermissionRowId | null>(null);

  const run = async (
    kind: PermissionRowId,
    action: () => Promise<unknown>,
  ) => {
    setPendingKind(kind);
    try {
      await action();
    } catch {
      // The action updates visible error state where possible; do not let a
      // failed macOS permission read escape as an unhandled UI promise.
    } finally {
      setPendingKind((current) => (current === kind ? null : current));
    }
  };

  return { pendingKind, run };
}

function useNotificationBadgesEnabled() {
  const [enabled, setEnabled] = useState(() =>
    getDeviceBool("dockBadgesEnabled", true),
  );

  useEffect(
    () =>
      watchDeviceSetting("dockBadgesEnabled", () => {
        setEnabled(getDeviceBool("dockBadgesEnabled", true));
      }),
    [],
  );

  const update = (next: boolean) => {
    setEnabled(next);
    setDeviceBool("dockBadgesEnabled", next);
    if (!next) setDockBadge(0);
  };

  return [enabled, update] as const;
}

function PermissionRow({
  row,
  onToggle,
}: {
  row: PermissionRowViewModel;
  onToggle: (id: PermissionRowId) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Toggle
        checked={row.checked}
        disabled={row.disabled}
        aria-label={row.label}
        onChange={() => onToggle(row.id)}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={row.disabled}
          onClick={() => onToggle(row.id)}
          className={cn(
            "block w-full text-left",
            row.disabled ? "cursor-not-allowed" : "cursor-pointer",
          )}
        >
          <span className="block text-[14px] font-semibold leading-[18px] text-[var(--content-emphasised)]">
            {row.label}
          </span>
          <span className="mt-1 block text-[13px] font-medium leading-[18px] text-[var(--content-tertiary)]">
            {row.description}
          </span>
        </button>
        {row.error && (
          <p className="mt-1 text-body-small-default text-[var(--system-negative-strong)]">
            {row.error}
          </p>
        )}
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-base)] border-t-[var(--content-tertiary)]"
    />
  );
}

export function SystemPermissionsCard({
  compact: _compact = false,
}: {
  compact?: boolean;
}) {
  const { state, loading, error, supported, refresh } =
    useSystemPermissionsState();
  const { pendingKind, run } = usePendingKind();
  const [notificationBadgesEnabled, setNotificationBadgesEnabled] =
    useNotificationBadgesEnabled();

  const systemRowsById = useMemo(() => {
    const rows = new Map<
      SystemPermissionKind,
      { meta: SystemPermissionRowMeta; item: SystemPermissionStateItem }
    >();
    if (!state) return rows;

    for (const meta of SYSTEM_PERMISSION_ROWS) {
      const item = state[meta.sourceKind];
      if (item) rows.set(meta.id, { meta, item });
    }

    return rows;
  }, [state]);

  const rows = useMemo<PermissionRowViewModel[]>(() => {
    const systemRows = SYSTEM_PERMISSION_ROWS.map((meta) => {
      const item = systemRowsById.get(meta.id)?.item;
      if (!item) return null;

      return {
        id: meta.id,
        label: meta.label,
        description: meta.description,
        checked: item.status === "granted",
        disabled: pendingKind === meta.id || item.status === "restricted",
        ...(item.error ? { error: item.error } : {}),
      };
    }).filter(Boolean) as PermissionRowViewModel[];

    const localRows = LOCAL_PERMISSION_ROWS.map((meta) => ({
      id: meta.id,
      label: meta.label,
      description: meta.description,
      checked: notificationBadgesEnabled,
      disabled: pendingKind === meta.id,
    }));

    return [...systemRows, ...localRows];
  }, [notificationBadgesEnabled, pendingKind, systemRowsById]);

  if (!supported) return null;

  const handleSystemToggle = async (
    meta: SystemPermissionRowMeta,
    item: SystemPermissionStateItem,
  ) => {
    if (
      item.status === "granted" ||
      item.status === "denied" ||
      !item.canRequest
    ) {
      await openSystemPermissionSettings(meta.sourceKind);
    } else {
      await requestSystemPermission(meta.sourceKind);
    }
    await refresh();
  };

  const handleToggle = (id: PermissionRowId) => {
    const systemRow = systemRowsById.get(id as SystemPermissionKind);
    if (systemRow) {
      void run(id, () => handleSystemToggle(systemRow.meta, systemRow.item));
      return;
    }

    if (id === "notificationBadges") {
      void run(id, async () => {
        setNotificationBadgesEnabled(!notificationBadgesEnabled);
      });
    }
  };

  return (
    <section
      className="w-full rounded-[20px] border border-[var(--border-hover)] bg-[var(--surface-lift)] px-4 pb-3 pt-5"
    >
      <h2 className="text-[18px] font-semibold leading-[22px] text-[var(--content-emphasised)]">
        System Permissions
      </h2>
      {loading && rows.length === 0 ? (
        <div className="mt-6 flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <LoadingSpinner />
          Checking permissions...
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <PermissionRow
              key={row.id}
              row={row}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)] bg-[var(--system-negative-weak)] p-3 text-body-medium-lighter text-[var(--content-secondary)]"
        >
          {error}
        </div>
      )}
    </section>
  );
}
