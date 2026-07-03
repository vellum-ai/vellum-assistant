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
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { type TagTone, Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

const MAX_POINT_IN_TIME_BACKUPS = 3;

const BACKUP_TYPE_CONFIG: Record<string, { label: string; tone: TagTone }> = {
  point_in_time: { label: "Point-in-time", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "positive" },
  preview_channel: { label: "Preview", tone: "warning" },
  doctor: { label: "Doctor", tone: "warning" },
};

function BackupTypeBadge({ type }: { type: string }) {
  const config = BACKUP_TYPE_CONFIG[type] ?? {
    label: type,
    tone: "neutral" as TagTone,
  };
  return <Tag tone={config.tone}>{config.label}</Tag>;
}

function formatTimestamp(value: unknown): string {
  if (value === null || value === undefined) return "—";
  let str = String(value);
  if (!/Z|[+-]\d{2}:?\d{2}$/.test(str)) {
    str = str + "Z";
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AssistantBackups({ assistantId }: { assistantId: string }) {
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

  const handleCopySnapshotName = useCallback((name: string) => {
    navigator.clipboard.writeText(name).then(() => {
      setCopiedSnapshot(name);
      setTimeout(() => setCopiedSnapshot(null), 2000);
    });
  }, []);

  const loading = resolvedId !== assistantId;

  useEffect(() => {
    let cancelled = false;

    listAssistantBackups(assistantId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setBackups(result.data);
          setError(null);
        } else {
          const detail =
            typeof result.error?.detail === "string"
              ? result.error.detail
              : "Failed to load backups.";
          setError(detail);
        }
        setResolvedId(assistantId);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Failed to load backups.");
        setResolvedId(assistantId);
      });

    return () => {
      cancelled = true;
    };
  }, [assistantId, refreshKey]);

  const handleRestoreConfirm = useCallback(async () => {
    if (!pendingBackup) return;

    const backup = pendingBackup;
    setPendingBackup(null);
    setRestoringSnapshot(backup.snapshot_name);
    try {
      const result = await restoreAssistantBackup(assistantId, backup);
      if (result.ok) {
        toast.success("Backup restored successfully.");
        setRefreshKey((k) => k + 1);
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to restore backup.";
        toast.error(detail);
      }
    } catch {
      toast.error("Failed to restore backup.");
    } finally {
      setRestoringSnapshot(null);
    }
  }, [assistantId, pendingBackup]);

  const handleCreateBackup = useCallback(async () => {
    setCreatingBackup(true);
    try {
      const result = await createAssistantBackup(assistantId);
      if (result.ok) {
        toast.success("Backup started. It will appear in the list shortly.");
        setRefreshKey((k) => k + 1);
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to create backup.";
        toast.error(detail);
      }
    } catch {
      toast.error("Failed to create backup.");
    } finally {
      setCreatingBackup(false);
    }
  }, [assistantId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading backups...
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
          Creating a new backup will remove the oldest one.
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
        {creatingBackup ? "Creating…" : "Create Backup"}
      </Button>
    </div>
  );

  if (backups.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{createBackupButton}</div>
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          No backups found for this assistant.
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
                <th className="w-[35%] pb-2 pr-4">Snapshot Name</th>
                <th className="w-[13%] pb-2 pr-4">Type</th>
                <th className="w-[12%] pb-2 pr-4">Ready</th>
                <th className="w-[20%] pb-2 pr-4">Created</th>
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
                    <div className="group/snapshot flex items-center gap-1">
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
                        className="shrink-0 text-[var(--content-secondary)] opacity-0 transition-opacity hover:text-[var(--content-default)] group-hover/snapshot:opacity-100"
                        title="Copy snapshot name"
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
                      {backup.ready_to_use ? "Ready" : "Pending"}
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
                          ? "Backup is not ready to use"
                          : undefined
                      }
                    >
                      Restore
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
              <div className="group/snapshot mb-2 flex items-center gap-1">
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
                  className="shrink-0 text-[var(--content-secondary)] hover:text-[var(--content-default)]"
                  title="Copy snapshot name"
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
                  {backup.ready_to_use ? "Ready" : "Pending"}
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
                disabled={
                  restoringSnapshot !== null || !backup.ready_to_use
                }
                title={
                  !backup.ready_to_use
                    ? "Backup is not ready to use"
                    : undefined
                }
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      </div>
      <ConfirmDialog
        open={pendingBackup !== null}
        title="Restore Backup"
        message={
          pendingBackup
            ? `Restore from backup "${pendingBackup.snapshot_name}"?\n\nThe assistant will be temporarily unavailable during the restore.`
            : ""
        }
        confirmLabel="Restore"
        destructive
        onConfirm={handleRestoreConfirm}
        onCancel={() => setPendingBackup(null)}
      />
    </>
  );
}
