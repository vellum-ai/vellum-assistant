import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useDevModeVersionTap } from "@/domains/settings/components/dev-mode-version-unlock";
import {
  assistantsRetrieveOptions,
  assistantsRetrieveQueryKey,
  releasesListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import {
  assistantsRollbackDetailCreate,
  assistantsUpgradeDetailCreate,
} from "@/generated/api/sdk.gen";
import type {
  ReleaseChannelEnum,
  ReleaseListItem,
} from "@/generated/api/types.gen";
import { useLocalRuntimeUpgrade } from "@/hooks/use-local-runtime-upgrade";
import { Trans, t, useTranslation } from "@/i18n";
import {
  LOCAL_RUNTIME_RELEASES_FETCH_LIMIT,
  getLatestRuntimeRelease,
  getVisibleReleaseChannel,
  isRuntimeUpgradeAvailable,
} from "@/lib/local-runtime-upgrade";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { compareParsed, parseSemver } from "@/utils/semver";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Select } from "@vellumai/design-library/components/select";
import { toast } from "@vellumai/design-library/components/toast";

function releaseLabel(
  release: ReleaseListItem,
  currentVersion: string | null | undefined,
  latestVersion: string | undefined,
): string {
  const parts = [release.version];
  if (release.version === latestVersion) {
    parts.push(t("settings:assistantUpgrades.latestSuffix"));
  }
  if (currentVersion && release.version === currentVersion) {
    parts.push(t("settings:assistantUpgrades.currentSuffix"));
  }
  return parts.join(" ");
}

const POLL_INTERVAL_MS = 3000;

/**
 * The "Current" version value, doubling as the 7-tap developer-mode unlock
 * target (see `useDevModeVersionTap`). Shared by both the platform and local
 * upgrade panels so the unlock lives on the version label that is on screen.
 */
function CurrentVersionValue({
  version,
  assistantId,
}: {
  version: string | null | undefined;
  assistantId: string | null;
}) {
  const { onTap, message } = useDevModeVersionTap(assistantId);
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="block min-w-0 break-all text-left text-body-medium-lighter text-[var(--content-default)]"
        onClick={onTap}
      >
        {version ?? "—"}
      </button>
      {message && (
        <p className="mt-1 text-body-small-default text-[var(--content-accent)]">
          {message}
        </p>
      )}
    </div>
  );
}

interface AssistantUpgradesProps {
  assistantId: string;
  currentVersion?: string | null;
  releaseChannel?: ReleaseChannelEnum;
  onUpgradeComplete?: () => void;
}

export function AssistantUpgrades({
  assistantId,
  currentVersion,
  releaseChannel,
  onUpgradeComplete,
}: AssistantUpgradesProps) {
  const { t } = useTranslation("settings");
  const rollbackEnabled = useAssistantFeatureFlagStore.use.rollbackEnabled();
  const previewChannel = useClientFeatureFlagStore.use.previewChannel();
  const queryClient = useQueryClient();
  const visibleReleaseChannel = getVisibleReleaseChannel(
    releaseChannel,
    previewChannel,
  );
  const isPreviewReleaseChannel = visibleReleaseChannel === "preview";
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const targetVersionRef = useRef<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isPollingRollback, setIsPollingRollback] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const pollRefetchInterval = (version: string | null | undefined) => {
    if (
      version &&
      targetVersionRef.current &&
      version === targetVersionRef.current
    ) {
      queueMicrotask(() => {
        const msg = isPollingRollback
          ? t("assistantUpgrades.successRolledBack", {
              version: targetVersionRef.current,
            })
          : t("assistantUpgrades.successUpdated", {
              version: targetVersionRef.current,
            });
        setSuccessMessage(msg);
        setIsPollingUpgrade(false);
        targetVersionRef.current = null;
        setSelectedVersion(null);
        toast.success(
          isPollingRollback
            ? t("assistantUpgrades.toastRollbackComplete")
            : t("assistantUpgrades.toastUpdateComplete"),
          { id: "runtime-upgrade-complete", tone: "strong" },
        );
        onUpgradeComplete?.();
      });
      return false as const;
    }
    return POLL_INTERVAL_MS;
  };

  useQuery({
    ...assistantsRetrieveOptions({ path: { id: assistantId } }),
    refetchInterval: isPollingUpgrade
      ? (query) =>
          pollRefetchInterval(query.state.data?.current_release_version)
      : false,
  });

  const { data: releases, isLoading: releasesLoading } = useQuery(
    releasesListOptions({
      query: { channel: visibleReleaseChannel },
    }),
  );

  const latestRelease =
    releases?.find((r) => r.is_stable !== false) ?? releases?.[0];
  const effectiveSelectedVersion =
    selectedVersion ?? latestRelease?.version ?? null;

  const isRollback = useMemo(() => {
    if (!rollbackEnabled) {
      return false;
    }
    if (!effectiveSelectedVersion || !currentVersion) {
      return false;
    }
    const target = parseSemver(effectiveSelectedVersion);
    const current = parseSemver(currentVersion);
    if (!target || !current) {
      return false;
    }
    return compareParsed(target, current) < 0;
  }, [rollbackEnabled, effectiveSelectedVersion, currentVersion]);

  const upgradeAvailable = useMemo(() => {
    if (!effectiveSelectedVersion) {
      return false;
    }
    if (!currentVersion) {
      return true;
    }
    const target = parseSemver(effectiveSelectedVersion);
    const current = parseSemver(currentVersion);
    if (!target || !current) {
      return effectiveSelectedVersion !== currentVersion;
    }
    const cmp = compareParsed(target, current);
    if (!rollbackEnabled) {
      return cmp > 0;
    }
    return cmp !== 0;
  }, [rollbackEnabled, effectiveSelectedVersion, currentVersion]);

  const upgradeCreate = useMutation({
    mutationFn: async (body: { version?: string }) => {
      const { data } = await assistantsUpgradeDetailCreate({
        path: { id: assistantId },
        body,
        throwOnError: true,
      });
      return data;
    },
  });

  const rollbackCreate = useMutation({
    mutationFn: async (body: { version?: string }) => {
      const { data } = await assistantsRollbackDetailCreate({
        path: { id: assistantId },
        body,
        throwOnError: true,
      });
      return data;
    },
  });

  const handleUpgrade = async () => {
    setShowConfirmation(false);
    setSuccessMessage(null);
    // With the picker rendered, the trigger shows `effectiveSelectedVersion`
    // even when nothing was chosen, and a selection matching the displayed
    // value is not reported. Reading the raw selection would install
    // something other than the version on screen.
    //
    // With no picker there is nothing on screen to honour, so the server
    // resolves latest. That is deliberately not the same as this component's
    // `latestRelease`, which does not filter `local` pre-release builds the
    // way `getLatestRuntimeRelease` does.
    const targetVersion = rollbackEnabled
      ? (effectiveSelectedVersion ?? undefined)
      : undefined;
    try {
      if (isRollback) {
        const result = await rollbackCreate.mutateAsync({
          version: targetVersion,
        });
        targetVersionRef.current = result.version ?? targetVersion ?? null;
        toast.success(
          result.detail ||
            t("assistantUpgrades.toastRollbackInitiated", {
              version: targetVersion,
            }),
        );
      } else {
        const result = await upgradeCreate.mutateAsync({
          version: targetVersion,
        });
        const isNoOp = result.detail?.includes("Already on the latest");
        if (isNoOp) {
          // Not a success — nothing actually happened. Surface a warning so the
          // user understands why the modal closed without kicking off an update.
          toast.warning(result.detail);
          return;
        }
        targetVersionRef.current = result.version ?? targetVersion ?? null;
        toast.success(
          result.detail ||
            t("assistantUpgrades.toastUpdateInitiated", {
              version: result.version ?? targetVersion ?? t("assistantUpgrades.latest"),
            }),
        );
      }
      setIsPollingRollback(isRollback);
      setIsPollingUpgrade(true);
      queryClient.invalidateQueries({
        queryKey: assistantsRetrieveQueryKey({
          path: { id: assistantId },
        }),
      });
    } catch {
      toast.error(
        isRollback
          ? t("assistantUpgrades.toastRollbackFailed")
          : t("assistantUpgrades.toastUpdateFailed"),
      );
    }
  };

  const targetLabel =
    isPreviewReleaseChannel
      ? t("assistantUpgrades.previewRelease")
      : !upgradeAvailable
        ? t("assistantUpgrades.selected")
        : isRollback
          ? t("assistantUpgrades.rollbackTo")
          : t("assistantUpgrades.updateTo");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:grid md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-x-8 md:gap-y-4">
        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {t("assistantUpgrades.current")}
          </span>
          <CurrentVersionValue
            version={currentVersion}
            assistantId={assistantId}
          />
        </div>

        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {targetLabel}
          </span>
          {/* The action belongs to the version it acts on, so it shares the
              row on desktop. Narrow screens stack it to keep both the version
              string and the button at full width. */}
          <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:gap-4">
            <span className="block min-w-0 flex-1">
              {releasesLoading ? (
                <span className="flex items-center gap-1 text-body-medium-lighter text-[var(--content-tertiary)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("assistantUpgrades.loading")}
                </span>
              ) : releases && releases.length > 0 ? (
                rollbackEnabled ? (
                  <Select
                    value={effectiveSelectedVersion ?? ""}
                    onChange={(value) =>
                      setSelectedVersion(
                        value === latestRelease?.version ? null : value,
                      )
                    }
                    disabled={
                      isPollingUpgrade ||
                      upgradeCreate.isPending ||
                      rollbackCreate.isPending
                    }
                    options={releases.map((r) => ({
                      value: r.version,
                      label: releaseLabel(
                        r,
                        currentVersion,
                        latestRelease?.version,
                      ),
                    }))}
                  />
                ) : (
                  <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
                    {latestRelease
                      ? releaseLabel(
                          latestRelease,
                          currentVersion,
                          latestRelease.version,
                        )
                      : "—"}
                  </span>
                )
              ) : (
                t("assistantUpgrades.noReleases")
              )}
            </span>
            <Button
              variant={isRollback ? "outlined" : "primary"}
              className="min-w-[160px] shrink-0"
              leftIcon={
                upgradeCreate.isPending ||
                rollbackCreate.isPending ||
                isPollingUpgrade ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )
              }
              onClick={() => setShowConfirmation(true)}
              disabled={
                !upgradeAvailable ||
                upgradeCreate.isPending ||
                rollbackCreate.isPending ||
                isPollingUpgrade ||
                releasesLoading ||
                !releases?.length
              }
            >
              {isPollingUpgrade
                ? isPollingRollback
                  ? t("assistantUpgrades.rollingBack")
                  : t("assistantUpgrades.updating")
                : isRollback
                  ? t("assistantUpgrades.rollback")
                  : isPreviewReleaseChannel
                    ? t("assistantUpgrades.updatePreview")
                    : t("assistantUpgrades.update")}
            </Button>
          </div>
        </div>
      </div>

      {isPreviewReleaseChannel && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          <Trans
            ns="settings"
            i18nKey="assistantUpgrades.usingPreviewReleases"
            components={{
              stableLink: (
                <a
                  href="#preview-release-channel"
                  className="text-[var(--primary-base)] underline-offset-2 hover:underline"
                />
              ),
            }}
          />
        </p>
      )}
      {!upgradeAvailable &&
        currentVersion &&
        effectiveSelectedVersion &&
        !releasesLoading && (
          <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
            {successMessage ?? t("assistantUpgrades.alreadyOnVersion")}
          </p>
        )}

      <ConfirmDialog
        open={showConfirmation}
        title={
          isRollback
            ? t("assistantUpgrades.confirmRollbackTitle")
            : isPreviewReleaseChannel
              ? t("assistantUpgrades.confirmPreviewTitle")
              : t("assistantUpgrades.confirmUpdateTitle")
        }
        message={
          isRollback
            ? t("assistantUpgrades.confirmRollbackMessage", {
                version: effectiveSelectedVersion ?? t("assistantUpgrades.unknown"),
              })
            : isPreviewReleaseChannel
              ? t("assistantUpgrades.confirmPreviewMessage", {
                  version:
                    effectiveSelectedVersion ?? t("assistantUpgrades.latest"),
                })
              : t("assistantUpgrades.confirmUpdateMessage", {
                  version:
                    effectiveSelectedVersion ?? t("assistantUpgrades.latest"),
                })
        }
        confirmLabel={
          isRollback
            ? t("assistantUpgrades.rollback")
            : isPreviewReleaseChannel
              ? t("assistantUpgrades.updatePreview")
              : t("assistantUpgrades.update")
        }
        onConfirm={handleUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}

interface LocalAssistantUpgradesProps {
  assistantId: string;
  currentVersion?: string | null;
  onUpgradeComplete?: () => void;
}

export function LocalAssistantUpgrades({
  assistantId,
  currentVersion,
  onUpgradeComplete,
}: LocalAssistantUpgradesProps) {
  const { t } = useTranslation("settings");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const { data: releases, isLoading: releasesLoading } = useQuery(
    releasesListOptions({
      query: { stable: true, limit: LOCAL_RUNTIME_RELEASES_FETCH_LIMIT },
    }),
  );

  const latestRelease = useMemo(
    () => getLatestRuntimeRelease(releases),
    [releases],
  );
  const targetVersion = latestRelease?.version;
  const upgradeAvailable = !currentVersion
    ? !!targetVersion
    : isRuntimeUpgradeAvailable(currentVersion, targetVersion);
  const upgradeCreate = useLocalRuntimeUpgrade({ assistantId, targetVersion });

  const handleUpgrade = async () => {
    setShowConfirmation(false);
    setSuccessMessage(null);
    try {
      const result = await upgradeCreate.upgrade();
      setSuccessMessage(
        t("assistantUpgrades.successUpdated", {
          version: result.version ?? targetVersion ?? t("assistantUpgrades.latest"),
        }),
      );
      toast.success(t("assistantUpgrades.toastUpdateComplete"), {
        id: "runtime-upgrade-complete",
        tone: "strong",
      });
      onUpgradeComplete?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("assistantUpgrades.toastUpdateFailed"),
      );
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:grid md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-x-8 md:gap-y-4">
        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {t("assistantUpgrades.current")}
          </span>
          <CurrentVersionValue
            version={currentVersion}
            assistantId={assistantId}
          />
        </div>

        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {t("assistantUpgrades.updateTo")}
          </span>
          <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
            {releasesLoading
              ? t("assistantUpgrades.loading")
              : targetVersion && latestRelease
                ? releaseLabel(latestRelease, currentVersion, targetVersion)
                : t("assistantUpgrades.noReleases")}
          </span>
        </div>
      </div>

      <Button
        variant="primary"
        className="min-w-[160px]"
        leftIcon={
          upgradeCreate.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RefreshCw />
          )
        }
        onClick={() => setShowConfirmation(true)}
        disabled={
          upgradeCreate.isPending ||
          releasesLoading ||
          !targetVersion ||
          !upgradeAvailable
        }
      >
        {upgradeCreate.isPending
          ? t("assistantUpgrades.updating")
          : targetVersion
            ? t("assistantUpgrades.updateToVersion", { version: targetVersion })
            : t("assistantUpgrades.update")}
      </Button>

      {successMessage && (
        <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
          {successMessage}
        </p>
      )}
      {!successMessage &&
        !upgradeAvailable &&
        targetVersion &&
        !releasesLoading && (
          <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
            {t("assistantUpgrades.alreadyOnVersion")}
          </p>
        )}

      <ConfirmDialog
        open={showConfirmation}
        title={t("assistantUpgrades.confirmUpdateTitle")}
        message={t("assistantUpgrades.confirmUpdateMessage", {
          version: targetVersion ?? t("assistantUpgrades.latest"),
        })}
        confirmLabel={t("assistantUpgrades.update")}
        onConfirm={handleUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}
