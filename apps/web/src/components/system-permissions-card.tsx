import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  openSystemPermissionSettings,
  requestSystemPermission,
  useSystemPermissionsState,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
} from "@/runtime/system-permissions";
import { cn } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";

type PermissionRowId = SystemPermissionKind | "notificationBadges";

interface PermissionRowMeta {
  id: PermissionRowId;
  sourceKind: SystemPermissionKind;
  label: string;
  description: string;
}

const PERMISSION_ROWS: PermissionRowMeta[] = [
  {
    id: "accessibility",
    sourceKind: "accessibility",
    label: "Accessibility",
    description:
      "Allows your assistant to click, type, and control apps on your behalf.",
  },
  {
    id: "screen",
    sourceKind: "screen",
    label: "Screen Recording",
    description:
      "Allows your assistant to capture screen context during computer-use tasks.",
  },
  {
    id: "microphone",
    sourceKind: "microphone",
    label: "Microphone",
    description:
      "Allows your assistant to capture audio for voice input and recordings.",
  },
  {
    id: "speechRecognition",
    sourceKind: "speechRecognition",
    label: "Speech Recognition",
    description:
      "Allows your assistant to transcribe your speech into text on-device.",
  },
  {
    id: "notifications",
    sourceKind: "notifications",
    label: "Notifications",
    description:
      "Allows your assistant to send macOS alerts for approvals, messages, and task updates.",
  },
  {
    id: "notificationBadges",
    sourceKind: "notifications",
    label: "Notification Badges",
    description:
      "Allows your assistant to show unseen conversation counts on the Dock icon.",
  },
] as const;

function usePendingKind() {
  const [pendingKind, setPendingKind] = useState<PermissionRowId | null>(null);

  const run = async (
    kind: PermissionRowId,
    action: () => Promise<unknown>,
  ) => {
    setPendingKind(kind);
    try {
      await action();
    } finally {
      setPendingKind((current) => (current === kind ? null : current));
    }
  };

  return { pendingKind, run };
}

function PermissionRow({
  item,
  meta,
  pending,
  onToggle,
}: {
  item: SystemPermissionStateItem;
  meta: PermissionRowMeta;
  pending: boolean;
  onToggle: (meta: PermissionRowMeta, item: SystemPermissionStateItem) => void;
}) {
  const checked = item.status === "granted";
  const disabled = pending || item.status === "restricted";

  return (
    <div className="flex items-start gap-3">
      <Toggle
        checked={checked}
        disabled={disabled}
        aria-label={meta.label}
        onChange={() => onToggle(meta, item)}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onToggle(meta, item)}
          className={cn(
            "block w-full text-left",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
          )}
        >
          <span className="block text-[14px] font-semibold leading-[18px] text-[var(--content-emphasised)]">
            {meta.label}
          </span>
          <span className="mt-1 block text-[13px] font-medium leading-[18px] text-[var(--content-tertiary)]">
            {meta.description}
          </span>
        </button>
        {item.error && (
          <p className="mt-1 text-body-small-default text-[var(--system-negative-strong)]">
            {item.error}
          </p>
        )}
      </div>
    </div>
  );
}

export function SystemPermissionsCard({
  compact: _compact = false,
}: {
  compact?: boolean;
}) {
  const { state, loading, error, supported } = useSystemPermissionsState();
  const { pendingKind, run } = usePendingKind();

  const items = useMemo(
    () =>
      PERMISSION_ROWS.map((meta) => {
        const item = state?.[meta.sourceKind];
        return item ? { meta, item } : null;
      }).filter(Boolean) as Array<{
        meta: PermissionRowMeta;
        item: SystemPermissionStateItem;
      }>,
    [state],
  );

  if (!supported) return null;

  const handleToggle = (
    meta: PermissionRowMeta,
    item: SystemPermissionStateItem,
  ) => {
    void run(meta.id, () => {
      if (
        item.status === "granted" ||
        item.status === "denied" ||
        !item.canRequest
      ) {
        return openSystemPermissionSettings(meta.sourceKind);
      }
      return requestSystemPermission(meta.sourceKind);
    });
  };

  return (
    <section
      className="w-full rounded-[20px] border border-[var(--border-hover)] bg-[var(--surface-lift)] px-4 pb-3 pt-5"
    >
      <h2 className="text-[18px] font-semibold leading-[22px] text-[var(--content-emphasised)]">
        System Permissions
      </h2>
      {loading && items.length === 0 ? (
        <div className="mt-6 flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking permissions...
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {items.map(({ meta, item }) => (
            <PermissionRow
              key={meta.id}
              item={item}
              meta={meta}
              pending={pendingKind === meta.id}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </section>
  );
}
