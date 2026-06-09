import {
  Bell,
  CheckCircle2,
  Eye,
  Keyboard,
  Loader2,
  Mic,
  Monitor,
  RefreshCcw,
  RotateCw,
  Settings,
  Shield,
  Volume2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import {
  openSystemPermissionSettings,
  quitAndReopenForPermissions,
  requestSystemPermission,
  SYSTEM_PERMISSION_KINDS,
  useSystemPermissionsState,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionStatus,
} from "@/runtime/system-permissions";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

interface PermissionMeta {
  label: string;
  description: string;
  deniedExplainer: string;
  Icon: LucideIcon;
}

const PERMISSION_META: Record<SystemPermissionKind, PermissionMeta> = {
  accessibility: {
    label: "Accessibility",
    description: "Lets Vellum observe app context and assist across macOS.",
    deniedExplainer: "App context and cross-app assistance stay disabled.",
    Icon: Shield,
  },
  screen: {
    label: "Screen Recording",
    description: "Lets Vellum inspect on-screen context when you ask for help.",
    deniedExplainer: "Screen context features stay unavailable.",
    Icon: Monitor,
  },
  microphone: {
    label: "Microphone",
    description: "Enables dictation and live voice conversations.",
    deniedExplainer: "Voice input stays unavailable.",
    Icon: Mic,
  },
  speechRecognition: {
    label: "Speech Recognition",
    description: "Allows macOS speech recognition for local dictation flows.",
    deniedExplainer: "Local speech recognition cannot transcribe audio.",
    Icon: Volume2,
  },
  inputMonitoring: {
    label: "Input Monitoring",
    description: "Enables system-level push-to-talk key detection.",
    deniedExplainer: "Global push-to-talk stays unavailable.",
    Icon: Keyboard,
  },
  automation: {
    label: "Automation",
    description: "Lets Vellum paste dictated text into the front app.",
    deniedExplainer: "Dictation-to-front-app paste stays unavailable.",
    Icon: Eye,
  },
  notifications: {
    label: "Notifications",
    description: "Allows macOS alerts for activity, approvals, and reminders.",
    deniedExplainer: "Desktop alerts stay disabled.",
    Icon: Bell,
  },
};

const STATUS_LABELS: Record<SystemPermissionStatus, string> = {
  unknown: "Unknown",
  restricted: "Restricted",
  denied: "Denied",
  "not-determined": "Not Requested",
  granted: "Granted",
};

function statusTone(status: SystemPermissionStatus): string {
  switch (status) {
    case "granted":
      return "text-[var(--system-positive-strong)]";
    case "denied":
    case "restricted":
      return "text-[var(--system-negative-strong)]";
    case "not-determined":
      return "text-[var(--system-mid-strong)]";
    case "unknown":
      return "text-[var(--content-tertiary)]";
  }
}

function statusIcon(status: SystemPermissionStatus) {
  if (status === "granted") {
    return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  }
  if (status === "denied" || status === "restricted") {
    return <XCircle className="h-4 w-4" aria-hidden="true" />;
  }
  return <RefreshCcw className="h-4 w-4" aria-hidden="true" />;
}

function usePendingKind() {
  const [pendingKind, setPendingKind] = useState<SystemPermissionKind | null>(
    null,
  );

  const run = async (
    kind: SystemPermissionKind,
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
  compact,
  pending,
  onRequest,
  onOpenSettings,
}: {
  item: SystemPermissionStateItem;
  compact: boolean;
  pending: boolean;
  onRequest: (kind: SystemPermissionKind) => void;
  onOpenSettings: (kind: SystemPermissionKind) => void;
}) {
  const meta = PERMISSION_META[item.kind];
  const { Icon } = meta;
  const showRequest =
    item.canRequest &&
    (item.status === "not-determined" ||
      item.status === "unknown" ||
      item.kind === "accessibility");
  const showSettings =
    item.canOpenSettings &&
    (item.status === "denied" ||
      item.status === "restricted" ||
      !showRequest);

  return (
    <div className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-lift)] text-[var(--content-secondary)]">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-body-medium-default text-[var(--content-default)]">
              {meta.label}
            </span>
            <span
              className={`inline-flex items-center gap-1 text-label-medium-default ${statusTone(item.status)}`}
            >
              {statusIcon(item.status)}
              {STATUS_LABELS[item.status]}
            </span>
          </div>
          {!compact && (
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              {item.status === "denied" || item.status === "restricted"
                ? meta.deniedExplainer
                : meta.description}
            </p>
          )}
          {item.requiresRestart && (
            <p className="mt-1 text-body-small-default text-[var(--system-mid-strong)]">
              Screen Recording changes may require reopening Vellum.
            </p>
          )}
          {item.error && (
            <p className="mt-1 text-body-small-default text-[var(--system-negative-strong)]">
              {item.error}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {showRequest && (
          <Button
            variant="primary"
            size="compact"
            onClick={() => onRequest(item.kind)}
            disabled={pending}
            leftIcon={
              pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : undefined
            }
          >
            Request
          </Button>
        )}
        {showSettings && (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => onOpenSettings(item.kind)}
            disabled={pending}
            leftIcon={<Settings className="h-3.5 w-3.5" />}
          >
            Open Settings
          </Button>
        )}
        {item.requiresRestart && (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => void quitAndReopenForPermissions()}
            leftIcon={<RotateCw className="h-3.5 w-3.5" />}
          >
            Quit & Reopen
          </Button>
        )}
      </div>
    </div>
  );
}

export function SystemPermissionsCard({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { state, loading, error, supported } = useSystemPermissionsState();
  const { pendingKind, run } = usePendingKind();

  const items = useMemo(
    () =>
      SYSTEM_PERMISSION_KINDS.map((kind) => state?.[kind]).filter(
        Boolean,
      ) as SystemPermissionStateItem[],
    [state],
  );

  if (!supported) return null;

  const content = (
    <div className="divide-y divide-[var(--surface-active)] dark:divide-[var(--surface-lift)]">
      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking permissions...
        </div>
      ) : (
        items.map((item) => (
          <PermissionRow
            key={item.kind}
            item={item}
            compact={compact}
            pending={pendingKind === item.kind}
            onRequest={(kind) =>
              void run(kind, () => requestSystemPermission(kind))
            }
            onOpenSettings={(kind) =>
              void run(kind, () => openSystemPermissionSettings(kind))
            }
          />
        ))
      )}
      {error && (
        <div className="pt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );

  if (compact) {
    return content;
  }

  return (
    <DetailCard
      title="Mac Permissions"
      subtitle="Request and re-check macOS permissions used by desktop features."
    >
      {content}
    </DetailCard>
  );
}
