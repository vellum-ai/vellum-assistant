import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  RefreshCw,
  RotateCcw,
  Rocket,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Collapsible } from "@vellum/design-library/components/collapsible";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Radio, RadioGroup } from "@vellum/design-library/components/radio";
import { Tag } from "@vellum/design-library/components/tag";
import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsReleaseChannelPreviewOptInCreateMutation,
  assistantsReleaseChannelPreviewOptOutCreateMutation,
  assistantsReleaseChannelRetrieveOptions,
  assistantsReleaseChannelRetrieveQueryKey,
  assistantsRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  ModeEnum,
  PreviewSafetyBackup,
  ReleaseChannelStatus,
} from "@/generated/api/types.gen";
import { extractErrorMessage } from "@/lib/api-errors";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

interface PreviewReleaseChannelProps {
  assistantId: string;
  onComplete?: () => void;
}

type ReleaseChannelMode = "stable" | "preview";

function normalizeChannel(channel: string | undefined): ReleaseChannelMode {
  return channel === "preview" ? "preview" : "stable";
}

function formatDate(value: string | undefined | null): string {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function backupLabel(backup: PreviewSafetyBackup): string {
  return backup.source_release_version
    ? `Stable ${backup.source_release_version}`
    : backup.snapshot_name;
}

function readyBackups(
  backups: readonly PreviewSafetyBackup[],
): PreviewSafetyBackup[] {
  return backups.filter((backup) => backup.ready_to_use);
}

function statusUnavailable(status: ReleaseChannelStatus | undefined): boolean {
  return status?.feature_enabled === false;
}

export function PreviewReleaseChannel({
  assistantId,
  onComplete,
}: PreviewReleaseChannelProps) {
  const previewChannel = useClientFeatureFlagStore.use.previewChannel();
  const queryClient = useQueryClient();
  const [openSection, setOpenSection] = useState<string | undefined>();
  const [showOptInModal, setShowOptInModal] = useState(false);
  const [showOptOutModal, setShowOptOutModal] = useState(false);
  const [optOutMode, setOptOutMode] = useState<ModeEnum>("restore_backup");
  const [selectedSnapshotName, setSelectedSnapshotName] = useState("");

  const statusQueryOptions = assistantsReleaseChannelRetrieveOptions({
    path: { assistant_id: assistantId },
  });
  const statusQueryKey = assistantsReleaseChannelRetrieveQueryKey({
    path: { assistant_id: assistantId },
  });
  const assistantQueryKey = assistantsRetrieveQueryKey({
    path: { id: assistantId },
  });

  const { data: status, isLoading, isError } = useQuery({
    ...statusQueryOptions,
    enabled: previewChannel,
    retry: false,
  });

  const previewBackups = status?.preview_backups ?? [];
  const availableRestoreBackups = useMemo(
    () => readyBackups(previewBackups),
    [previewBackups],
  );
  const defaultRestoreBackup = availableRestoreBackups[0];
  const selectedRestoreBackup =
    availableRestoreBackups.find(
      (backup) => backup.snapshot_name === selectedSnapshotName,
    ) ?? defaultRestoreBackup;

  const refreshQueries = () => {
    void queryClient.invalidateQueries({ queryKey: statusQueryKey });
    void queryClient.invalidateQueries({ queryKey: assistantQueryKey });
    onComplete?.();
  };

  const optInMutation = useMutation(
    assistantsReleaseChannelPreviewOptInCreateMutation(),
  );
  const optOutMutation = useMutation(
    assistantsReleaseChannelPreviewOptOutCreateMutation(),
  );

  const currentChannel = normalizeChannel(status?.current_channel);
  const isChangingChannel =
    optInMutation.isPending || optOutMutation.isPending;
  const optInDisabled =
    isChangingChannel ||
    statusUnavailable(status) ||
    !status?.latest_preview_release;
  const restoreModeDisabled =
    optOutMode === "restore_backup" && !selectedRestoreBackup;

  useEffect(() => {
    setOpenSection(
      currentChannel === "preview" ? "release-channel" : undefined,
    );
  }, [currentChannel]);

  if (!previewChannel) {
    return null;
  }

  const standardUpgradeAvailable =
    status?.standard_upgrade_available ?? false;

  const openOptOutModal = () => {
    const backup = defaultRestoreBackup;
    setSelectedSnapshotName(backup?.snapshot_name ?? "");
    setOptOutMode(
      backup
        ? "restore_backup"
        : standardUpgradeAvailable
          ? "standard_upgrade"
          : "restore_backup",
    );
    setShowOptOutModal(true);
  };

  const handleOptIn = async () => {
    try {
      const result = await optInMutation.mutateAsync({
        path: { assistant_id: assistantId },
      });
      toast.success(result.detail || "Preview channel enabled.");
      setShowOptInModal(false);
      refreshQueries();
    } catch (error) {
      toast.error(
        extractErrorMessage(
          error,
          undefined,
          "Could not enable Preview channel.",
        ),
      );
    }
  };

  const handleOptOut = async () => {
    if (restoreModeDisabled) {
      return;
    }

    try {
      const result = await optOutMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body:
          optOutMode === "restore_backup"
            ? {
                mode: "restore_backup",
                snapshot_name: selectedRestoreBackup?.snapshot_name,
              }
            : { mode: "standard_upgrade" },
      });
      toast.success(result.detail || "Stable channel enabled.");
      setShowOptOutModal(false);
      refreshQueries();
    } catch (error) {
      toast.error(
        extractErrorMessage(error, undefined, "Could not switch to Stable."),
      );
    }
  };

  return (
    <>
      <Collapsible.Root
        type="single"
        collapsible
        value={openSection}
        onValueChange={(value) => setOpenSection(value || undefined)}
        className="mt-5 border-t border-[var(--border-base)] pt-5"
      >
        <Collapsible.Item value="release-channel" id="preview-release-channel">
          <Collapsible.Trigger className="group justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-body-medium-default text-[var(--content-secondary)]">
                Release Channel
              </span>
              {status && (
                <Tag
                  tone={currentChannel === "preview" ? "warning" : "neutral"}
                >
                  {currentChannel === "preview" ? "Preview" : "Stable"}
                </Tag>
              )}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180" />
          </Collapsible.Trigger>

          <Collapsible.Content>
            <div className="mt-4 space-y-4">
              {isLoading && (
                <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading release channel...
                </div>
              )}

              {isError && (
                <Notice
                  tone="error"
                  title="Could not load release channel status"
                >
                  Refresh this page before changing release channels.
                </Notice>
              )}

              {status && (
                <>
                  {statusUnavailable(status) && (
                    <Notice
                      tone="neutral"
                      title="Preview channel is unavailable"
                    >
                      The Preview channel is not enabled for this assistant.
                    </Notice>
                  )}

                  {currentChannel === "stable" ? (
                    <StablePreviewPanel
                      status={status}
                      isChangingChannel={isChangingChannel}
                      optInDisabled={optInDisabled}
                      onOptIn={() => setShowOptInModal(true)}
                    />
                  ) : (
                    <PreviewOptOutPanel
                      status={status}
                      isChangingChannel={isChangingChannel}
                      onOptOut={openOptOutModal}
                    />
                  )}
                </>
              )}
            </div>
          </Collapsible.Content>
        </Collapsible.Item>
      </Collapsible.Root>

      <OptInModal
        open={showOptInModal}
        isPending={optInMutation.isPending}
        previewVersion={status?.latest_preview_release?.version}
        onConfirm={handleOptIn}
        onCancel={() => setShowOptInModal(false)}
      />
      <OptOutModal
        open={showOptOutModal}
        backups={availableRestoreBackups}
        mode={optOutMode}
        selectedSnapshotName={selectedRestoreBackup?.snapshot_name ?? ""}
        isPending={optOutMutation.isPending}
        restoreModeDisabled={restoreModeDisabled}
        standardUpgradeAvailable={standardUpgradeAvailable}
        onModeChange={setOptOutMode}
        onSnapshotChange={setSelectedSnapshotName}
        onConfirm={handleOptOut}
        onCancel={() => setShowOptOutModal(false)}
      />
    </>
  );
}

function StablePreviewPanel({
  status,
  isChangingChannel,
  optInDisabled,
  onOptIn,
}: {
  status: ReleaseChannelStatus;
  isChangingChannel: boolean;
  optInDisabled: boolean;
  onOptIn: () => void;
}) {
  return (
    <div className="space-y-4">
      <ReleaseChannelFacts status={status} />
      {!status.latest_preview_release && (
        <Notice tone="neutral" title="No Preview release is available">
          Stable remains the only available release channel.
        </Notice>
      )}
      <Button
        variant="outlined"
        leftIcon={
          isChangingChannel ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Rocket />
          )
        }
        disabled={optInDisabled}
        onClick={onOptIn}
      >
        Opt in to Preview
      </Button>
    </div>
  );
}

function PreviewOptOutPanel({
  status,
  isChangingChannel,
  onOptOut,
}: {
  status: ReleaseChannelStatus;
  isChangingChannel: boolean;
  onOptOut: () => void;
}) {
  return (
    <div className="space-y-4">
      <ReleaseChannelFacts status={status} />
      <Button
        variant="outlined"
        leftIcon={
          isChangingChannel ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RotateCcw />
          )
        }
        disabled={isChangingChannel}
        onClick={onOptOut}
      >
        Switch back to Stable
      </Button>
    </div>
  );
}

function ReleaseChannelFacts({ status }: { status: ReleaseChannelStatus }) {
  return (
    <dl className="grid gap-3 text-body-medium-lighter sm:grid-cols-2">
      <div>
        <dt className="text-[var(--content-tertiary)]">Latest Stable</dt>
        <dd className="break-all text-[var(--content-default)]">
          {status.latest_stable_release?.version ?? "None"}
        </dd>
      </div>
      <div>
        <dt className="text-[var(--content-tertiary)]">Latest Preview</dt>
        <dd className="break-all text-[var(--content-default)]">
          {status.latest_preview_release?.version ?? "None"}
        </dd>
      </div>
    </dl>
  );
}

function OptInModal({
  open,
  isPending,
  previewVersion,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  isPending: boolean;
  previewVersion: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Modal.Content size="md" hideCloseButton={isPending}>
        <Modal.Header>
          <Modal.Title icon={AlertTriangle}>Opt in to Preview</Modal.Title>
          <Modal.Description>
            Preview releases may be unstable. A 90-day safety backup is taken
            before the image changes.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-3">
            <Notice
              tone="warning"
              title="Data loss may occur when returning to Stable"
            >
              Preview data may not be compatible with the Stable channel. The
              safety backup lets you restore the Stable-channel data that
              existed before opt-in.
            </Notice>
            <ol className="list-decimal space-y-2 pl-5 text-body-medium-lighter text-[var(--content-secondary)]">
              <li>Create and verify a Preview safety backup.</li>
              <li>Switch to Preview image {previewVersion ?? "latest"}.</li>
              <li>Run the normal upgrade path and wait for health.</li>
            </ol>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" disabled={isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={isPending}
            leftIcon={
              isPending ? <Loader2 className="animate-spin" /> : <Rocket />
            }
            onClick={onConfirm}
          >
            {isPending ? "Switching..." : "Take Backup and Switch"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

function OptOutModal({
  open,
  backups,
  mode,
  selectedSnapshotName,
  isPending,
  restoreModeDisabled,
  standardUpgradeAvailable,
  onModeChange,
  onSnapshotChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  backups: readonly PreviewSafetyBackup[];
  mode: ModeEnum;
  selectedSnapshotName: string;
  isPending: boolean;
  restoreModeDisabled: boolean;
  standardUpgradeAvailable: boolean;
  onModeChange: (mode: ModeEnum) => void;
  onSnapshotChange: (snapshotName: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Modal.Content size="md" hideCloseButton={isPending}>
        <Modal.Header>
          <Modal.Title icon={AlertTriangle}>
            Switch back to Stable
          </Modal.Title>
          <Modal.Description>
            Choose how this assistant should leave the Preview channel.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-4">
            <RadioGroup<ModeEnum>
              value={mode}
              onValueChange={onModeChange}
              disabled={isPending}
              aria-label="Stable channel return method"
            >
              <Radio<ModeEnum>
                value="restore_backup"
                disabled={backups.length === 0}
                label="Restore safety backup"
                helperText="Return to the Stable-channel data captured before Preview opt-in."
              />
              <Radio<ModeEnum>
                value="standard_upgrade"
                disabled={!standardUpgradeAvailable}
                label="Switch to Stable without restoring backup"
                helperText={
                  standardUpgradeAvailable
                    ? "Keep the current data and directly switch to the Stable image."
                    : "Unavailable because the latest Stable release is older than this assistant's Preview release."
                }
              />
            </RadioGroup>

            {mode === "restore_backup" && backups.length > 0 && (
              <label className="flex flex-col gap-1 text-body-medium-default text-[var(--content-secondary)]">
                Safety backup
                <Dropdown
                  value={selectedSnapshotName}
                  onChange={onSnapshotChange}
                  disabled={isPending}
                  options={backups.map((backup) => ({
                    value: backup.snapshot_name,
                    label: `${backupLabel(backup)} - ${formatDate(
                      backup.created_at,
                    )}`,
                  }))}
                />
              </label>
            )}

            {mode === "restore_backup" &&
              backups.length === 0 &&
              !standardUpgradeAvailable && (
                <Notice tone="error" title="Stable requires a safety backup">
                  This Preview release is newer than the latest Stable release,
                  so switching directly is blocked. Wait for a newer Stable
                  release, or run Vellum Doctor if the safety backup is missing.
                </Notice>
              )}

            {mode === "standard_upgrade" && (
              <Notice tone="error" title="Preview data may not survive this">
                Switching directly to the Stable image without restoring the
                safety backup may cause data loss or leave the assistant
                unusable if Preview data is incompatible with Stable.
              </Notice>
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" disabled={isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={mode === "standard_upgrade" ? "danger" : "primary"}
            disabled={
              isPending ||
              restoreModeDisabled ||
              (mode === "standard_upgrade" && !standardUpgradeAvailable)
            }
            leftIcon={
              isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />
            }
            onClick={onConfirm}
          >
            {isPending ? "Switching..." : "Switch to Stable"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
