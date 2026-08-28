import { useEffect, useMemo, useState } from "react";

import { useTranslation, type TFunction } from "@/i18n";
import {
  getUnreadBadgeSurface,
  setDockBadge,
  supportsUnreadBadges,
} from "@/runtime/dock";
import { detectElectronHostOS } from "@/runtime/platform-detection";
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
  availableOnWindows?: boolean;
}

interface LocalPermissionRowMeta {
  id: LocalPermissionRowId;
  type: "local";
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
  },
  {
    id: "screen",
    type: "system",
    sourceKind: "screen",
    availableOnWindows: true,
  },
  {
    id: "microphone",
    type: "system",
    sourceKind: "microphone",
    availableOnWindows: true,
  },
  {
    id: "speechRecognition",
    type: "system",
    sourceKind: "speechRecognition",
    availableOnWindows: true,
  },
  {
    id: "notifications",
    type: "system",
    sourceKind: "notifications",
    availableOnWindows: true,
  },
];

const LOCAL_PERMISSION_ROWS: LocalPermissionRowMeta[] = [
  {
    id: "notificationBadges",
    type: "local",
  },
];

type SystemPermissionRowId = (typeof SYSTEM_PERMISSION_ROWS)[number]["id"];

function systemPermissionCopy(
  id: SystemPermissionRowId,
  t: TFunction,
  isWindowsHost: boolean,
): { label: string; description: string } {
  switch (id) {
    case "accessibility":
      return {
        label: t("systemPermissionsCard.accessibilityLabel"),
        description: t("systemPermissionsCard.accessibilityDescription"),
      };
    case "screen":
      return {
        label: t("systemPermissionsCard.screenLabel"),
        description: t("systemPermissionsCard.screenDescription"),
      };
    case "microphone":
      return {
        label: t("systemPermissionsCard.microphoneLabel"),
        description: t("systemPermissionsCard.microphoneDescription"),
      };
    case "speechRecognition":
      return {
        label: t("systemPermissionsCard.speechRecognitionLabel"),
        description: isWindowsHost
          ? t("systemPermissionsCard.speechRecognitionWindowsDescription")
          : t("systemPermissionsCard.speechRecognitionDescription"),
      };
    case "notifications":
      return {
        label: t("systemPermissionsCard.notificationsLabel"),
        description: isWindowsHost
          ? t("systemPermissionsCard.notificationsWindowsDescription")
          : t("systemPermissionsCard.notificationsDescription"),
      };
    default: {
      // Rows only use the kinds above; other SystemPermissionKind values
      // (inputMonitoring, automation) are not shown in this card.
      throw new Error(`Unsupported system permission row: ${id}`);
    }
  }
}

function usePendingKind() {
  const [pendingKind, setPendingKind] = useState<PermissionRowId | null>(null);

  const run = async (kind: PermissionRowId, action: () => Promise<unknown>) => {
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
    if (!next) {
      setDockBadge(0);
    }
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
  const { t } = useTranslation();
  const { state, loading, error, supported, refresh } =
    useSystemPermissionsState();
  const { pendingKind, run } = usePendingKind();
  const [notificationBadgesEnabled, setNotificationBadgesEnabled] =
    useNotificationBadgesEnabled();

  const isWindowsHost = detectElectronHostOS() === "windows";
  const visibleSystemRows = useMemo(
    () =>
      SYSTEM_PERMISSION_ROWS.filter(
        (meta) => !isWindowsHost || meta.availableOnWindows,
      ),
    [isWindowsHost],
  );

  const systemRowsById = useMemo(() => {
    const rows = new Map<
      SystemPermissionKind,
      { meta: SystemPermissionRowMeta; item: SystemPermissionStateItem }
    >();
    if (!state) {
      return rows;
    }

    for (const meta of visibleSystemRows) {
      const item = state[meta.sourceKind];
      if (item && item.status !== "not-applicable") {
        rows.set(meta.id, { meta, item });
      }
    }

    return rows;
  }, [state, visibleSystemRows]);

  const rows = useMemo<PermissionRowViewModel[]>(() => {
    const systemRows = visibleSystemRows
      .map((meta) => {
        const item = systemRowsById.get(meta.id)?.item;
        if (!item) {
          return null;
        }

        const copy = systemPermissionCopy(meta.id, t, isWindowsHost);

        return {
          id: meta.id,
          label: copy.label,
          description: copy.description,
          checked: item.status === "granted",
          disabled: pendingKind === meta.id || item.status === "restricted",
          ...(item.error ? { error: item.error } : {}),
        };
      })
      .filter(Boolean) as PermissionRowViewModel[];

    const badgeSurface =
      getUnreadBadgeSurface() === "taskbar icon"
        ? t("systemPermissionsCard.taskbarIcon")
        : t("systemPermissionsCard.dockIcon");

    const localRows = supportsUnreadBadges()
      ? LOCAL_PERMISSION_ROWS.map((meta) => ({
          id: meta.id,
          label: t("systemPermissionsCard.notificationBadgesLabel"),
          description: t(
            "systemPermissionsCard.notificationBadgesDescription",
            { surface: badgeSurface },
          ),
          checked: notificationBadgesEnabled,
          disabled: pendingKind === meta.id,
        }))
      : [];

    return [...systemRows, ...localRows];
  }, [
    isWindowsHost,
    notificationBadgesEnabled,
    pendingKind,
    systemRowsById,
    t,
    visibleSystemRows,
  ]);

  if (!supported && rows.length === 0) {
    return null;
  }

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
    <section className="w-full rounded-[20px] border border-[var(--border-hover)] bg-[var(--surface-lift)] px-4 pb-3 pt-5">
      <h2 className="text-[18px] font-semibold leading-[22px] text-[var(--content-emphasised)]">
        {t("systemPermissionsCard.title")}
      </h2>
      {loading && rows.length === 0 ? (
        <div className="mt-6 flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <LoadingSpinner />
          {t("systemPermissionsCard.checking")}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <PermissionRow key={row.id} row={row} onToggle={handleToggle} />
          ))}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-6 rounded-md border border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)] bg-[var(--system-negative-weak)] p-3 text-body-medium-lighter text-[var(--content-secondary)]"
        >
          {error}
        </div>
      )}
    </section>
  );
}
