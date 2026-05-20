import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsRetrieveOptions,
  assistantsRetrieveQueryKey,
  releasesListOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import {
  assistantsRollbackDetailCreate,
  assistantsUpgradeDetailCreate,
} from "@/generated/api/sdk.gen.js";
import type { ReleaseListItem } from "@/generated/api/types.gen.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";
import {
  compareParsed,
  parseSemver,
} from "@/lib/semver/semver.js";

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
  onUpgradeComplete?: () => void;
}

export function AssistantUpgrades({
  assistantId,
  currentVersion,
  onUpgradeComplete,
}: AssistantUpgradesProps) {
  const { rollbackEnabled } = useAppFeatureFlags();
  const queryClient = useQueryClient();
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const targetVersionRef = useRef<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isPollingRollback, setIsPollingRollback] = useState(false);

  const pollRefetchInterval = (version: string | null | undefined) => {
    if (
      version &&
      targetVersionRef.current &&
      version === targetVersionRef.current
    ) {
      queueMicrotask(() => {
        setIsPollingUpgrade(false);
        targetVersionRef.current = null;
        setSelectedVersion(null);
        toast.success(
          isPollingRollback
            ? "Rollback complete — assistant is healthy."
            : "Update complete — assistant is healthy.",
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
      query: { stable: true },
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
    if (!target || !current)
      return effectiveSelectedVersion !== currentVersion;
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
          toast.success(result.detail);
          return;
        }
        targetVersionRef.current =
          result.version ?? targetVersion ?? null;
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
            {!upgradeAvailable
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
            : "Update"}
      </Button>
      {!upgradeAvailable &&
        currentVersion &&
        effectiveSelectedVersion &&
        !releasesLoading && (
          <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
            You are already on this version.
          </p>
        )}

      <ConfirmDialog
        open={showConfirmation}
        title={isRollback ? "Rollback Assistant" : "Update Assistant"}
        message={
          isRollback
            ? `Rollback to version ${effectiveSelectedVersion ?? "unknown"}? The assistant will be briefly unavailable.`
            : `Update to version ${effectiveSelectedVersion ?? "latest"}? The assistant will be briefly unavailable during the update.`
        }
        confirmLabel={isRollback ? "Rollback" : "Update"}
        onConfirm={handleUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}
