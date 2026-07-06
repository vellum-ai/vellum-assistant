import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useLocalAssistantHealth } from "@/assistant/local-health";
import { useAssistantOperationalStatus } from "@/assistant/operational-status";
import {
  StatusBannerNotice,
  type StatusBannerPlacement,
} from "@/components/status-banner";
import {
  assistantsRetrieveOptions,
  assistantsRetrieveQueryKey,
  releasesListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsUpgradeDetailCreate } from "@/generated/api/sdk.gen";
import { useLocalRuntimeUpgrade } from "@/hooks/use-local-runtime-upgrade";
import { subscribe } from "@/lib/event-bus";
import {
  dismissRuntimeUpgrade,
  getLatestRuntimeRelease,
  getVisibleReleaseChannel,
  isRuntimeUpgradeAvailable,
  isRuntimeUpgradeDismissed,
  LOCAL_RUNTIME_RELEASES_FETCH_LIMIT,
  RUNTIME_RELEASES_REFETCH_INTERVAL_MS,
} from "@/lib/local-runtime-upgrade";
import { isLocalModeHostAvailable } from "@/runtime/local-mode-host";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { cn } from "@/utils/misc";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

const PLATFORM_UPGRADE_POLL_INTERVAL_MS = 3_000;

interface RuntimeUpgradeBannerProps {
  assistantId?: string | null;
  currentVersion?: string | null;
  placement?: StatusBannerPlacement;
  className?: string;
}

type UpgradeMode = "local" | "platform";

export function RuntimeUpgradeBanner({
  assistantId: assistantIdProp,
  currentVersion: currentVersionProp,
  placement = "web",
  className,
}: RuntimeUpgradeBannerProps) {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [dismissedScope, setDismissedScope] = useState<string | null>(null);
  const assistantState = useAssistantLifecycleStore((s) => s.assistantState);
  const localHealth = useLocalAssistantHealth();
  const fallbackAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const fallbackCurrentVersion = useAssistantIdentityStore.use.version();
  const previewChannelEnabled = useClientFeatureFlagStore.use.previewChannel();
  const assistantId = assistantIdProp ?? fallbackAssistantId;
  const currentVersion = currentVersionProp ?? fallbackCurrentVersion;
  const activeAssistant = useResolvedAssistantsStore((s) =>
    assistantId
      ? s.assistants.find((assistant) => assistant.id === assistantId)
      : null,
  );

  const isBunLocalAssistant = activeAssistant?.cloud === "local";
  const isPlatformAssistant =
    activeAssistant?.isPlatformHosted === true &&
    activeAssistant?.isLocal === false;
  const localCurrentVersion =
    activeAssistant?.runtimeVersion ?? currentVersion ?? null;
  const platformCurrentVersion =
    activeAssistant?.currentReleaseVersion ?? currentVersion ?? null;
  const mode: UpgradeMode | null = isBunLocalAssistant
    ? "local"
    : isPlatformAssistant
      ? "platform"
      : null;
  const { data: platformOperationalStatus } = useAssistantOperationalStatus(
    isPlatformAssistant ? (assistantId ?? null) : null,
  );
  const effectiveCurrentVersion =
    mode === "local"
      ? localCurrentVersion
      : mode === "platform"
        ? platformCurrentVersion
        : null;

  const canUpgradeActiveBunLocalAssistant =
    isBunLocalAssistant && activeAssistant?.isActiveLockfileAssistant === true;
  const isHealthyLocalRuntimeState =
    assistantState.kind === "self_hosted"
      ? !assistantState.health || assistantState.health === "healthy"
      : assistantState.kind === "active" && assistantState.isLocal
        ? assistantState.reachable !== false &&
          (!assistantState.health || assistantState.health === "healthy")
        : false;
  const isLocalHealthReadyForUpgrade =
    !localHealth || localHealth === "healthy";
  const isHealthyPlatformRuntimeState =
    assistantState.kind === "active" &&
    !assistantState.isLocal &&
    assistantState.reachable !== false &&
    !assistantState.maintenanceMode?.enabled &&
    (!assistantState.health || assistantState.health === "healthy") &&
    (!platformOperationalStatus ||
      platformOperationalStatus.state === "active");
  const shouldCheckLocal =
    !!assistantId &&
    !!effectiveCurrentVersion &&
    !!activeAssistant?.isLocal &&
    canUpgradeActiveBunLocalAssistant &&
    isHealthyLocalRuntimeState &&
    isLocalHealthReadyForUpgrade &&
    isLocalModeHostAvailable();
  const shouldCheckPlatform =
    !!assistantId &&
    !!effectiveCurrentVersion &&
    isPlatformAssistant &&
    isHealthyPlatformRuntimeState;
  const shouldCheck = shouldCheckLocal || shouldCheckPlatform;
  const visiblePlatformReleaseChannel = getVisibleReleaseChannel(
    activeAssistant?.releaseChannel,
    previewChannelEnabled,
  );

  const { data: releases, refetch: refetchReleases } = useQuery({
    ...releasesListOptions({
      query:
        mode === "platform"
          ? { channel: visiblePlatformReleaseChannel }
          : { stable: true, limit: LOCAL_RUNTIME_RELEASES_FETCH_LIMIT },
    }),
    enabled: shouldCheck,
    refetchInterval: RUNTIME_RELEASES_REFETCH_INTERVAL_MS,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!shouldCheck) return;
    const refetch = () => {
      void refetchReleases();
    };
    const unsubscribers = [
      subscribe("app.resume", refetch),
      subscribe("power.resume", refetch),
      subscribe("power.unlock", refetch),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [refetchReleases, shouldCheck]);

  const latestRelease = useMemo(() => {
    if (mode === "platform") {
      return (
        releases?.find((release) => release.is_stable !== false) ??
        releases?.[0]
      );
    }
    return getLatestRuntimeRelease(releases);
  }, [mode, releases]);
  const targetVersion = latestRelease?.version ?? null;
  const dismissalScope =
    assistantId && targetVersion ? `${assistantId}:${targetVersion}` : null;
  const upgradeAvailable = isRuntimeUpgradeAvailable(
    effectiveCurrentVersion,
    targetVersion,
  );
  const localUpgrade = useLocalRuntimeUpgrade({
    assistantId,
    targetVersion: targetVersion ?? undefined,
  });
  const platformUpgrade = usePlatformRuntimeUpgrade({
    assistantId,
    targetVersion: targetVersion ?? undefined,
  });
  const upgradePending =
    mode === "platform" ? platformUpgrade.isPending : localUpgrade.isPending;

  useEffect(() => {
    if (!assistantId || !targetVersion) {
      setDismissedScope(null);
      return;
    }
    setDismissedScope(
      isRuntimeUpgradeDismissed(assistantId, targetVersion)
        ? `${assistantId}:${targetVersion}`
        : null,
    );
  }, [assistantId, targetVersion]);

  const dismissed = dismissalScope !== null && dismissalScope === dismissedScope;

  const handleConfirmUpgrade = async () => {
    if (!assistantId || !targetVersion || !mode) return;
    setShowConfirmation(false);
    try {
      if (mode === "platform") {
        const result = await platformUpgrade.upgrade();
        const isNoOp = result.detail?.includes("Already on the latest");
        if (isNoOp) {
          toast.warning(result.detail);
          return;
        }
      } else {
        await localUpgrade.upgrade();
        toast.success("Update complete — assistant is healthy.");
      }
      setDismissedScope(`${assistantId}:${targetVersion}`);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to trigger update. Please try again.",
      );
    }
  };

  const handleDismiss = () => {
    if (!assistantId || !targetVersion) return;
    dismissRuntimeUpgrade(assistantId, targetVersion);
    setDismissedScope(`${assistantId}:${targetVersion}`);
  };

  if (
    !shouldCheck ||
    !targetVersion ||
    !upgradeAvailable ||
    dismissed ||
    upgradePending
  ) {
    return null;
  }

  return (
    <>
      <div
        className={cn(
          placement === "electron" ? "px-4 pt-2" : "px-0 pt-0",
          className,
        )}
      >
        <StatusBannerNotice
          tone="info"
          title={`New assistant version available: ${targetVersion}`}
          placement={placement}
          icon={<RefreshCw aria-hidden="true" />}
          actions={
            <>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => setShowConfirmation(true)}
              >
                Update
              </Button>
              <span
                aria-hidden="true"
                className="h-3 w-px bg-[color-mix(in_srgb,var(--status-banner-action-color)_35%,transparent)]"
              />
              <Button variant="ghost" size="compact" onClick={handleDismiss}>
                Later
              </Button>
            </>
          }
        />
      </div>
      <ConfirmDialog
        open={showConfirmation}
        title="Update assistant runtime"
        message={`Update to version ${targetVersion}? The assistant will be briefly unavailable during the update.`}
        confirmLabel="Update"
        onConfirm={handleConfirmUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </>
  );
}

function usePlatformRuntimeUpgrade({
  assistantId,
  targetVersion,
}: {
  assistantId: string | null | undefined;
  targetVersion?: string;
}) {
  const queryClient = useQueryClient();
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const [pollingAssistantId, setPollingAssistantId] = useState<string | null>(
    null,
  );
  const targetVersionRef = useRef<string | null>(null);
  const { data: pollingOperationalStatus } = useAssistantOperationalStatus(
    pollingAssistantId,
    { ignoreActiveAssistantGate: true },
  );
  const mutation = useMutation({
    mutationFn: async ({
      assistantId: upgradeAssistantId,
      targetVersion: requestedTargetVersion,
    }: {
      assistantId: string;
      targetVersion?: string;
    }) => {
      const { data } = await assistantsUpgradeDetailCreate({
        path: { id: upgradeAssistantId },
        body: requestedTargetVersion
          ? { version: requestedTargetVersion }
          : {},
        throwOnError: true,
      });
      return data;
    },
  });

  useEffect(() => {
    if (
      !isPollingUpgrade ||
      pollingOperationalStatus?.detail_state !== "failed"
    ) {
      return;
    }
    targetVersionRef.current = null;
    setPollingAssistantId(null);
    setIsPollingUpgrade(false);
  }, [isPollingUpgrade, pollingOperationalStatus?.detail_state]);

  useQuery({
    ...assistantsRetrieveOptions({
      path: { id: pollingAssistantId ?? "" },
    }),
    enabled: isPollingUpgrade && !!pollingAssistantId,
    refetchInterval: (query) => {
      const version = query.state.data?.current_release_version;
      if (
        version &&
        targetVersionRef.current &&
        version === targetVersionRef.current
      ) {
        queueMicrotask(() => {
          if (query.state.data) {
            useResolvedAssistantsStore
              .getState()
              .upsertFromApi(query.state.data);
          }
          targetVersionRef.current = null;
          setPollingAssistantId(null);
          setIsPollingUpgrade(false);
          toast.success("Update complete — assistant is healthy.");
        });
        return false as const;
      }
      return PLATFORM_UPGRADE_POLL_INTERVAL_MS;
    },
  });

  return {
    isPending: mutation.isPending || isPollingUpgrade,
    upgrade: async () => {
      if (!assistantId) {
        throw new Error("No assistant is active.");
      }
      const upgradeAssistantId = assistantId;
      const requestedTargetVersion = targetVersion;
      const result = await mutation.mutateAsync({
        assistantId: upgradeAssistantId,
        targetVersion: requestedTargetVersion,
      });
      const isNoOp = result.detail?.includes("Already on the latest");
      if (!isNoOp) {
        targetVersionRef.current =
          result.version ?? requestedTargetVersion ?? null;
        if (targetVersionRef.current) {
          setPollingAssistantId(upgradeAssistantId);
          setIsPollingUpgrade(true);
        }
        queryClient.invalidateQueries({
          queryKey: assistantsRetrieveQueryKey({
            path: { id: upgradeAssistantId },
          }),
        });
      }
      return result;
    },
  };
}
