import { AlertTriangle, Clock, Loader2, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
    type AssistantBackup,
    createAssistantBackup,
    listAssistantBackups,
    restoreAssistantBackup,
} from "@/assistant/api";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

const MAX_POINT_IN_TIME_BACKUPS = 3;

function backupTypeLabel(type: string): string {
  switch (type) {
    case "point_in_time":
      return "Point-in-time";
    case "doctor":
      return "Doctor";
    default:
      return "Scheduled";
  }
}

function BackupTypeBadge({ type }: { type: string }) {
  return <Tag tone="neutral">{backupTypeLabel(type)}</Tag>;
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
    <div className="flex items-center gap-3">
      {pitBackupCount >= MAX_POINT_IN_TIME_BACKUPS && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Creating a new backup will remove the oldest one.
        </p>
      )}
      <Button
        variant="outlined"
        size="compact"
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
        <div className="flex justify-end">{createBackupButton}</div>
        {backups.map((backup) => (
          <Card.Root key={backup.snapshot_name}>
            <Card.Body
              padding="sm"
              className="flex items-center justify-between gap-4 px-4"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p
                  className="truncate font-mono text-body-small-default text-[var(--content-secondary)]"
                  title={backup.snapshot_name}
                >
                  {backup.snapshot_name}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <BackupTypeBadge type={backup.backup_type} />
                  {!backup.ready_to_use && (
                    <span className="inline-flex items-center rounded-full bg-[var(--system-mid-weak)] px-2 py-0.5 text-body-small-default text-[var(--system-mid-strong)]">
                      Not ready
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)]">
                  <Clock className="h-3 w-3" />
                  {new Date(backup.created_at).toLocaleString(undefined, {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
                <Button
                  variant="outlined"
                  size="compact"
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
                      ? "Backup is not ready to use"
                      : undefined
                  }
                  className="shrink-0"
                >
                  Restore
                </Button>
              </div>
            </Card.Body>
          </Card.Root>
        ))}
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
