import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  RefreshCw,
  Rocket,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import { useTranslation } from "@/i18n";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { extractErrorMessage } from "@/utils/api-errors";
import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Select } from "@vellumai/design-library/components/select";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Radio, RadioGroup } from "@vellumai/design-library/components/radio";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

interface PreviewReleaseChannelProps {
  assistantId: string;
  onComplete?: () => void;
}

type ReleaseChannelMode = "stable" | "preview";

function normalizeChannel(channel: string | undefined): ReleaseChannelMode {
  return channel === "preview" ? "preview" : "stable";
}

function formatDate(
  value: string | undefined | null,
  unknownLabel: string,
): string {
  if (!value) {
    return unknownLabel;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return unknownLabel;
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const { t } = useTranslation("settings");
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

  const {
    data: status,
    isLoading,
    isError,
  } = useQuery({
    ...statusQueryOptions,
    enabled: previewChannel,
    retry: false,
  });

  const availableRestoreBackups = useMemo(
    () => readyBackups(status?.preview_backups ?? []),
    [status?.preview_backups],
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
  const isChangingChannel = optInMutation.isPending || optOutMutation.isPending;
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

  const standardUpgradeAvailable = status?.standard_upgrade_available ?? false;

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
      toast.success(
        result.detail || t("previewReleaseChannel.previewEnabledToast"),
      );
      setShowOptInModal(false);
      refreshQueries();
    } catch (error) {
      toast.error(
        extractErrorMessage(
          error,
          undefined,
          t("previewReleaseChannel.previewEnableFailedToast"),
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
      toast.success(
        result.detail || t("previewReleaseChannel.stableEnabledToast"),
      );
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
                {t("previewReleaseChannel.title")}
              </span>
              {status && (
                <Tag
                  tone={currentChannel === "preview" ? "warning" : "neutral"}
                >
                  {currentChannel === "preview"
                    ? t("previewReleaseChannel.preview")
                    : t("previewReleaseChannel.stable")}
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
                  {t("previewReleaseChannel.loading")}
                </div>
              )}

              {isError && (
                <Notice
                  tone="error"
                  title={t("previewReleaseChannel.loadErrorTitle")}
                >
                  {t("previewReleaseChannel.loadErrorBody")}
                </Notice>
              )}

              {status && (
                <>
                  {statusUnavailable(status) && (
                    <Notice
                      tone="neutral"
                      title={t("previewReleaseChannel.unavailableTitle")}
                    >
                      {t("previewReleaseChannel.unavailableBody")}
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
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-4">
      <ReleaseChannelFacts status={status} />
      {!status.latest_preview_release && (
        <Notice
          tone="neutral"
          title={t("previewReleaseChannel.noPreviewTitle")}
        >
          {t("previewReleaseChannel.noPreviewBody")}
        </Notice>
      )}
      <Button
        variant="outlined"
        leftIcon={
          isChangingChannel ? <Loader2 className="animate-spin" /> : <Rocket />
        }
        disabled={optInDisabled}
        onClick={onOptIn}
      >
        {t("previewReleaseChannel.optIn")}
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
  const { t } = useTranslation("settings");
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
        {t("previewReleaseChannel.switchBack")}
      </Button>
    </div>
  );
}

function ReleaseChannelFacts({ status }: { status: ReleaseChannelStatus }) {
  const { t } = useTranslation("settings");
  return (
    <dl className="grid gap-3 text-body-medium-lighter sm:grid-cols-2">
      <div>
        <dt className="text-[var(--content-tertiary)]">
          {t("previewReleaseChannel.latestStable")}
        </dt>
        <dd className="break-all text-[var(--content-default)]">
          {status.latest_stable_release?.version ??
            t("previewReleaseChannel.none")}
        </dd>
      </div>
      <div>
        <dt className="text-[var(--content-tertiary)]">
          {t("previewReleaseChannel.latestPreview")}
        </dt>
        <dd className="break-all text-[var(--content-default)]">
          {status.latest_preview_release?.version ??
            t("previewReleaseChannel.none")}
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
  const { t } = useTranslation("settings");
  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Modal.Content size="md" hideCloseButton={isPending}>
        <Modal.Header icon={AlertTriangle}>
          <Modal.Title>{t("previewReleaseChannel.optInTitle")}</Modal.Title>
          <Modal.Description>
            {t("previewReleaseChannel.optInDescription")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-3">
            <Notice
              tone="warning"
              title={t("previewReleaseChannel.dataLossTitle")}
            >
              {t("previewReleaseChannel.dataLossBody")}
            </Notice>
            <ol className="list-decimal space-y-2 pl-5 text-body-medium-lighter text-[var(--content-secondary)]">
              <li>{t("previewReleaseChannel.optInStep1")}</li>
              <li>
                {t("previewReleaseChannel.optInStep2", {
                  version:
                    previewVersion ?? t("previewReleaseChannel.latest"),
                })}
              </li>
              <li>{t("previewReleaseChannel.optInStep3")}</li>
            </ol>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" disabled={isPending} onClick={onCancel}>
            {t("previewReleaseChannel.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={isPending}
            leftIcon={
              isPending ? <Loader2 className="animate-spin" /> : <Rocket />
            }
            onClick={onConfirm}
          >
            {isPending
              ? t("previewReleaseChannel.switching")
              : t("previewReleaseChannel.takeBackupAndSwitch")}
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
  const { t } = useTranslation("settings");
  const unknownLabel = t("previewReleaseChannel.unknownDate");

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Modal.Content size="md" hideCloseButton={isPending}>
        <Modal.Header icon={AlertTriangle}>
          <Modal.Title>{t("previewReleaseChannel.optOutTitle")}</Modal.Title>
          <Modal.Description>
            {t("previewReleaseChannel.optOutDescription")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-4">
            <RadioGroup<ModeEnum>
              value={mode}
              onValueChange={onModeChange}
              disabled={isPending}
              aria-label={t("previewReleaseChannel.returnMethodAriaLabel")}
            >
              <Radio<ModeEnum>
                value="restore_backup"
                disabled={backups.length === 0}
                label={t("previewReleaseChannel.restoreBackupLabel")}
                helperText={t("previewReleaseChannel.restoreBackupHelper")}
              />
              <Radio<ModeEnum>
                value="standard_upgrade"
                disabled={!standardUpgradeAvailable}
                label={t("previewReleaseChannel.standardUpgradeLabel")}
                helperText={
                  standardUpgradeAvailable
                    ? t("previewReleaseChannel.standardUpgradeHelper")
                    : t("previewReleaseChannel.standardUpgradeUnavailable")
                }
              />
            </RadioGroup>

            {mode === "restore_backup" && backups.length > 0 && (
              <label className="flex flex-col gap-1 text-body-medium-default text-[var(--content-secondary)]">
                {t("previewReleaseChannel.safetyBackup")}
                <Select
                  value={selectedSnapshotName}
                  onChange={onSnapshotChange}
                  disabled={isPending}
                  options={backups.map((backup) => {
                    const name = backup.source_release_version
                      ? t("previewReleaseChannel.stableBackupLabel", {
                          version: backup.source_release_version,
                        })
                      : backup.snapshot_name;
                    return {
                      value: backup.snapshot_name,
                      label: t("previewReleaseChannel.backupOptionLabel", {
                        name,
                        date: formatDate(backup.created_at, unknownLabel),
                      }),
                    };
                  })}
                />
              </label>
            )}

            {mode === "restore_backup" &&
              backups.length === 0 &&
              !standardUpgradeAvailable && (
                <Notice
                  tone="error"
                  title={t("previewReleaseChannel.requiresBackupTitle")}
                >
                  {t("previewReleaseChannel.requiresBackupBody")}
                </Notice>
              )}

            {mode === "standard_upgrade" && (
              <Notice
                tone="error"
                title={t("previewReleaseChannel.mayNotSurviveTitle")}
              >
                {t("previewReleaseChannel.mayNotSurviveBody")}
              </Notice>
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" disabled={isPending} onClick={onCancel}>
            {t("previewReleaseChannel.cancel")}
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
            {isPending
              ? t("previewReleaseChannel.switching")
              : t("previewReleaseChannel.switchToStable")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
