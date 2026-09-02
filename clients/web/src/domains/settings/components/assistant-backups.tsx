import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  RotateCcw,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  type AssistantBackup,
  createAssistantBackup,
  listAssistantBackups,
  restoreAssistantBackup,
} from "@/assistant/api";
import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { type TagTone, Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

const MAX_POINT_IN_TIME_BACKUPS = 3;

const BACKUP_TYPE_TONE: Record<string, TagTone> = {
  point_in_time: "neutral",
  scheduled: "positive",
  preview_channel: "warning",
  doctor: "warning",
};

function BackupTypeBadge({ type }: { type: string }) {
  const { t } = useTranslation("settings");
  let label = type;
  if (type === "point_in_time") {
    label = t("assistantBackups.typePointInTime");
  } else if (type === "scheduled") {
    label = t("assistantBackups.typeScheduled");
  } else if (type === "preview_channel") {
    label = t("assistantBackups.typePreview");
  } else if (type === "doctor") {
    label = t("assistantBackups.typeDoctor");
  }
  return <Tag tone={BACKUP_TYPE_TONE[type] ?? "neutral"}>{label}</Tag>;
}

function formatTimestamp(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  let str = String(value);
  if (!/Z|[+-]\d{2}:?\d{2}$/.test(str)) {
    str = str + "Z";
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AssistantBackups({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<AssistantBackup[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [restoringSnapshot, setRestoringSnapshot] = useState<string | null>(
    null,
  );
  const [pendingBackup, setPendingBackup] = useState<AssistantBackup | null>(
    null,
  );
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [copiedSnapshot, setCopiedSnapshot] = useState<string | null>(null);

  const handleCopySnapshotName = useCallback(
    (name: string) => {
      copyToClipboard(name, {
        errorMessage: t("assistantBackups.copyFailed"),
        onCopied: () => {
          setCopiedSnapshot(name);
          setTimeout(() => setCopiedSnapshot(null), 2000);
        },
      });
    },
    [t],
  );

  const loading = resolvedId !== assistantId;

  useEffect(() => {
    let cancelled = false;

    listAssistantBackups(assistantId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setBackups(result.data);
          setError(null);
        } else {
          const detail =
            typeof result.error?.detail === "string"
              ? result.error.detail
              : t("assistantBackups.loadFailed");
          setError(detail);
        }
        setResolvedId(assistantId);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setError(t("assistantBackups.loadFailed"));
        setResolvedId(assistantId);
      });

    return () => {
      cancelled = true;
    };
  }, [assistantId, refreshKey, t]);

  const handleRestoreConfirm = useCallback(async () => {
    if (!pendingBackup) {
      return;
    }

    const backup = pendingBackup;
    setPendingBackup(null);
    setRestoringSnapshot(backup.snapshot_name);
    try {
      const result = await restoreAssistantBackup(assistantId, backup);
      if (result.ok) {
        toast.success(t("assistantBackups.restoreSuccessToast"));
        setRefreshKey((k) => k + 1);
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : t("assistantBackups.restoreFailedToast");
        toast.error(detail);
      }
    } catch {
      toast.error(t("assistantBackups.restoreFailedToast"));
    } finally {
      setRestoringSnapshot(null);
    }
  }, [assistantId, pendingBackup, t]);

  const handleCreateBackup = useCallback(async () => {
    setCreatingBackup(true);
    try {
      const result = await createAssistantBackup(assistantId);
      if (result.ok) {
        toast.success(t("assistantBackups.createSuccessToast"));
        setRefreshKey((k) => k + 1);
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : t("assistantBackups.createFailedToast");
        toast.error(detail);
      }
    } catch {
      toast.error(t("assistantBackups.createFailedToast"));
    } finally {
      setCreatingBackup(false);
    }
  }, [assistantId, t]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("assistantBackups.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--system-negative-strong)]">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  const pitBackupCount = backups.filter(
    (b) => b.backup_type === "point_in_time",
  ).length;

  const createBackupButton = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {pitBackupCount >= MAX_POINT_IN_TIME_BACKUPS && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("assistantBackups.oldestRemovedNotice")}
        </p>
      )}
      <Button
        variant="outlined"
        leftIcon={
          creatingBackup ? <Loader2 className="animate-spin" /> : <Save />
        }
        onClick={handleCreateBackup}
        disabled={creatingBackup || restoringSnapshot !== null}
        className="shrink-0"
      >
        {creatingBackup
          ? t("assistantBackups.creating")
          : t("assistantBackups.createBackup")}
      </Button>
    </div>
  );

  if (backups.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{createBackupButton}</div>
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("assistantBackups.empty")}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {createBackupButton}
        {/* Desktop table */}
        <div className="hidden lg:block">
          <table className="w-full table-fixed text-body-medium-lighter">
            <thead>
              <tr className="border-b border-[var(--border-base)] text-left text-body-small-default text-[var(--content-secondary)]">
                <th className="w-[35%] pb-2 pr-4">{t("assistantBackups.columnSnapshotName")}</th>
                <th className="w-[13%] pb-2 pr-4">{t("assistantBackups.columnType")}</th>
                <th className="w-[12%] pb-2 pr-4">{t("assistantBackups.columnReady")}</th>
                <th className="w-[20%] pb-2 pr-4">{t("assistantBackups.columnCreated")}</th>
                <th className="w-[20%] pb-2" />
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr
                  key={backup.snapshot_name}
                  className="border-b border-[var(--border-base)] last:border-0"
                >
                  <td className="py-2.5 pr-4">
                    <div data-reveal-row="" className="flex items-center gap-1">
                      <code
                        className="truncate text-body-small-default text-[var(--content-default)]"
                        title={backup.snapshot_name}
                      >
                        {backup.snapshot_name}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          handleCopySnapshotName(backup.snapshot_name)
                        }
                        data-reveal=""
                        className="shrink-0 text-[var(--content-secondary)] hover:text-[var(--content-default)]"
                        title={t("assistantBackups.copySnapshotName")}
                      >
                        {copiedSnapshot === backup.snapshot_name ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="overflow-hidden whitespace-nowrap py-2.5 pr-4">
                    <BackupTypeBadge type={backup.backup_type} />
                  </td>
                  <td className="overflow-hidden whitespace-nowrap py-2.5 pr-4">
                    <Tag tone={backup.ready_to_use ? "positive" : "warning"}>
                      {backup.ready_to_use
                        ? t("assistantBackups.ready")
                        : t("assistantBackups.pending")}
                    </Tag>
                  </td>
                  <td className="overflow-hidden whitespace-nowrap py-2.5 pr-4 text-body-medium-default text-[var(--content-default)]">
                    {formatTimestamp(backup.created_at)}
                  </td>
                  <td className="py-2.5 text-right">
                    <Button
                      variant="ghost"
                      leftIcon={
                        restoringSnapshot === backup.snapshot_name ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RotateCcw />
                        )
                      }
                      onClick={() => setPendingBackup(backup)}
                      disabled={
                        restoringSnapshot !== null || !backup.ready_to_use
                      }
                      title={
                        !backup.ready_to_use
                          ? t("assistantBackups.notReady")
                          : undefined
                      }
                    >
                      {t("assistantBackups.restore")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile stacked layout */}
        <div className="flex flex-col gap-3 lg:hidden">
          {backups.map((backup) => (
            <div
              key={backup.snapshot_name}
              className="rounded-lg border border-[var(--border-base)] p-3"
            >
              <div className="mb-2 flex items-center gap-1">
                <code
                  className="truncate text-body-small-default text-[var(--content-default)]"
                  title={backup.snapshot_name}
                >
                  {backup.snapshot_name}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopySnapshotName(backup.snapshot_name)}
                  className="shrink-0 text-[var(--content-secondary)] hover:text-[var(--content-default)]"
                  title={t("assistantBackups.copySnapshotName")}
                >
                  {copiedSnapshot === backup.snapshot_name ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-body-medium-lighter">
                <BackupTypeBadge type={backup.backup_type} />
                <Tag tone={backup.ready_to_use ? "positive" : "warning"}>
                  {backup.ready_to_use
                        ? t("assistantBackups.ready")
                        : t("assistantBackups.pending")}
                </Tag>
                <span className="text-body-small-default text-[var(--content-secondary)]">
                  {formatTimestamp(backup.created_at)}
                </span>
              </div>
              <Button
                variant="ghost"
                leftIcon={
                  restoringSnapshot === backup.snapshot_name ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RotateCcw />
                  )
                }
                onClick={() => setPendingBackup(backup)}
                disabled={restoringSnapshot !== null || !backup.ready_to_use}
                title={
                  !backup.ready_to_use
                    ? t("assistantBackups.notReady")
                    : undefined
                }
              >
                {t("assistantBackups.restore")}
              </Button>
            </div>
          ))}
        </div>
      </div>
      <ConfirmDialog
        open={pendingBackup !== null}
        title={t("assistantBackups.restoreTitle")}
        message={
          pendingBackup
            ? t("assistantBackups.restoreMessage", {
                name: pendingBackup.snapshot_name,
              })
            : ""
        }
        confirmLabel={t("assistantBackups.restore")}
        destructive
        onConfirm={handleRestoreConfirm}
        onCancel={() => setPendingBackup(null)}
      />
    </>
  );
}
