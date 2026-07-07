import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

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
import {
  getLatestRuntimeRelease,
  getVisibleReleaseChannel,
  isRuntimeUpgradeAvailable,
  LOCAL_RUNTIME_RELEASES_FETCH_LIMIT,
} from "@/lib/local-runtime-upgrade";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { compareParsed, parseSemver } from "@/utils/semver";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { toast } from "@vellumai/design-library/components/toast";

function releaseLabel(
  release: ReleaseListItem,
  currentVersion: string | null | undefined,
  latestVersion: string | undefined,
): string {
  const parts = [release.version];
  if (release.version === latestVersion) parts.push("(latest)");
  if (currentVersion && release.version === currentVersion)
    parts.push("(current)");
  return parts.join(" ");
}

const POLL_INTERVAL_MS = 3000;

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
          ? `Successfully rolled back to version ${targetVersionRef.current}.`
          : `Successfully updated to version ${targetVersionRef.current}.`;
        setSuccessMessage(msg);
        setIsPollingUpgrade(false);
        targetVersionRef.current = null;
        setSelectedVersion(null);
        toast.success(
          isPollingRollback
            ? "Rollback complete — assistant is healthy."
            : "Update complete — assistant is healthy.",
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
    if (!rollbackEnabled) return false;
    if (!effectiveSelectedVersion || !currentVersion) return false;
    const target = parseSemver(effectiveSelectedVersion);
    const current = parseSemver(currentVersion);
    if (!target || !current) return false;
    return compareParsed(target, current) < 0;
  }, [rollbackEnabled, effectiveSelectedVersion, currentVersion]);

  const upgradeAvailable = useMemo(() => {
    if (!effectiveSelectedVersion) return false;
    if (!currentVersion) return true;
    const target = parseSemver(effectiveSelectedVersion);
    const current = parseSemver(currentVersion);
    if (!target || !current) return effectiveSelectedVersion !== currentVersion;
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
    const targetVersion = selectedVersion ?? undefined;
    try {
      if (isRollback) {
        const result = await rollbackCreate.mutateAsync({
          version: targetVersion,
        });
        targetVersionRef.current = result.version ?? targetVersion ?? null;
        toast.success(
          result.detail || `Rollback to ${targetVersion} initiated.`,
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
            `Update to ${result.version ?? targetVersion ?? "latest"} initiated.`,
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
          ? "Failed to trigger rollback. Please try again."
          : "Failed to trigger update. Please try again.",
      );
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:grid md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-x-8 md:gap-y-4">
        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            Current
          </span>
          <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
            {currentVersion ?? "—"}
          </span>
        </div>

        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {isPreviewReleaseChannel
              ? "Preview release"
              : !upgradeAvailable
                ? "Selected"
                : isRollback
                  ? "Rollback to"
                  : "Update to"}
          </span>
          <span className="block min-w-0">
            {releasesLoading ? (
              <span className="flex items-center gap-1 text-body-medium-lighter text-[var(--content-tertiary)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading...
              </span>
            ) : releases && releases.length > 0 ? (
              rollbackEnabled ? (
                <Dropdown
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
              "No releases available"
            )}
          </span>
        </div>
      </div>

      <Button
        variant={isRollback ? "outlined" : "primary"}
        className="min-w-[160px]"
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
            ? "Rolling back..."
            : "Updating..."
          : isRollback
            ? "Rollback"
            : isPreviewReleaseChannel
              ? "Update preview"
              : "Update"}
      </Button>
      {isPreviewReleaseChannel && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Using Preview releases.{" "}
          <a
            href="#preview-release-channel"
            className="text-[var(--primary-base)] underline-offset-2 hover:underline"
          >
            Switch back to Stable
          </a>
        </p>
      )}
      {!upgradeAvailable &&
        currentVersion &&
        effectiveSelectedVersion &&
        !releasesLoading && (
          <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
            {successMessage ?? "You are already on this version."}
          </p>
        )}

      <ConfirmDialog
        open={showConfirmation}
        title={
          isRollback
            ? "Rollback assistant"
            : isPreviewReleaseChannel
              ? "Update preview release"
              : "Update assistant"
        }
        message={
          isRollback
            ? `Rollback to version ${effectiveSelectedVersion ?? "unknown"}? The assistant will be briefly unavailable.`
            : isPreviewReleaseChannel
              ? `Update to preview version ${effectiveSelectedVersion ?? "latest"}? The assistant will be briefly unavailable during the update.`
              : `Update to version ${effectiveSelectedVersion ?? "latest"}? The assistant will be briefly unavailable during the update.`
        }
        confirmLabel={
          isRollback
            ? "Rollback"
            : isPreviewReleaseChannel
              ? "Update preview"
              : "Update"
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
        result.version
          ? `Successfully updated to version ${result.version}.`
          : `Successfully updated to version ${targetVersion ?? "latest"}.`,
      );
      toast.success("Update complete — assistant is healthy.", {
        id: "runtime-upgrade-complete",
        tone: "strong",
      });
      onUpgradeComplete?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to trigger update. Please try again.",
      );
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:grid md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-x-8 md:gap-y-4">
        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            Current
          </span>
          <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
            {currentVersion ?? "—"}
          </span>
        </div>

        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            Update to
          </span>
          <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
            {releasesLoading
              ? "Loading..."
              : targetVersion && latestRelease
                ? releaseLabel(latestRelease, currentVersion, targetVersion)
                : "No releases available"}
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
          ? "Updating..."
          : targetVersion
            ? `Update to ${targetVersion}`
            : "Update"}
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
            You are already on this version.
          </p>
        )}

      <ConfirmDialog
        open={showConfirmation}
        title="Update assistant"
        message={`Update to version ${targetVersion ?? "latest"}? The assistant will be briefly unavailable during the update.`}
        confirmLabel="Update"
        onConfirm={handleUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}
