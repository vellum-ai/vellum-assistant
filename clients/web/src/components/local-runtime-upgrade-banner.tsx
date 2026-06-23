import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import {
  StatusBannerNotice,
  type StatusBannerPlacement,
} from "@/components/status-banner";
import { releasesListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useLocalRuntimeUpgrade } from "@/hooks/use-local-runtime-upgrade";
import { subscribe } from "@/lib/event-bus";
import {
  dismissLocalRuntimeUpgrade,
  getLatestRuntimeRelease,
  isLocalRuntimeUpgradeDismissed,
  isRuntimeUpgradeAvailable,
  LOCAL_RUNTIME_RELEASES_REFETCH_INTERVAL_MS,
} from "@/lib/local-runtime-upgrade";
import { isLocalModeHostAvailable } from "@/runtime/local-mode-host";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

interface LocalRuntimeUpgradeBannerProps {
  assistantId?: string | null;
  currentVersion?: string | null;
  placement?: StatusBannerPlacement;
  className?: string;
}

export function LocalRuntimeUpgradeBanner({
  assistantId: assistantIdProp,
  currentVersion: currentVersionProp,
  placement = "web",
  className,
}: LocalRuntimeUpgradeBannerProps) {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [dismissedScope, setDismissedScope] = useState<string | null>(null);
  const assistantState = useAssistantLifecycleStore((s) => s.assistantState);
  const fallbackAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const fallbackCurrentVersion = useAssistantIdentityStore.use.version();
  const assistantId = assistantIdProp ?? fallbackAssistantId;
  const currentVersion = currentVersionProp ?? fallbackCurrentVersion;
  const activeAssistant = useResolvedAssistantsStore((s) =>
    assistantId
      ? s.assistants.find((assistant) => assistant.id === assistantId)
      : null,
  );
  const effectiveCurrentVersion =
    activeAssistant?.runtimeVersion ?? currentVersion ?? null;
  const isBunLocalAssistant = activeAssistant?.cloud === "local";
  const canUpgradeActiveBunLocalAssistant =
    isBunLocalAssistant && activeAssistant?.isActiveLockfileAssistant === true;
  const isHealthyLocalRuntimeState =
    assistantState.kind === "self_hosted"
      ? !assistantState.health || assistantState.health === "healthy"
      : assistantState.kind === "active" && assistantState.isLocal
        ? assistantState.reachable !== false &&
          (!assistantState.health || assistantState.health === "healthy")
        : false;
  const shouldCheck =
    !!assistantId &&
    !!effectiveCurrentVersion &&
    !!activeAssistant?.isLocal &&
    canUpgradeActiveBunLocalAssistant &&
    isHealthyLocalRuntimeState &&
    isLocalModeHostAvailable();

  const { data: releases, refetch: refetchReleases } = useQuery({
    ...releasesListOptions({
      query: { channel: "stable" },
    }),
    enabled: shouldCheck,
    refetchInterval: LOCAL_RUNTIME_RELEASES_REFETCH_INTERVAL_MS,
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

  const latestRelease = useMemo(
    () => getLatestRuntimeRelease(releases),
    [releases],
  );
  const targetVersion = latestRelease?.version ?? null;
  const dismissalScope =
    assistantId && targetVersion ? `${assistantId}:${targetVersion}` : null;
  const upgradeAvailable = isRuntimeUpgradeAvailable(
    effectiveCurrentVersion,
    targetVersion,
  );
  const upgrade = useLocalRuntimeUpgrade({
    assistantId,
    targetVersion: targetVersion ?? undefined,
  });

  useEffect(() => {
    if (!assistantId || !targetVersion) {
      setDismissedScope(null);
      return;
    }
    setDismissedScope(
      isLocalRuntimeUpgradeDismissed(assistantId, targetVersion)
        ? `${assistantId}:${targetVersion}`
        : null,
    );
  }, [assistantId, targetVersion]);

  const dismissed = dismissalScope !== null && dismissalScope === dismissedScope;

  const handleConfirmUpgrade = async () => {
    if (!assistantId || !targetVersion) return;
    setShowConfirmation(false);
    try {
      await upgrade.upgrade();
      toast.success("Update complete — assistant is healthy.");
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
    dismissLocalRuntimeUpgrade(assistantId, targetVersion);
    setDismissedScope(`${assistantId}:${targetVersion}`);
  };

  if (
    !shouldCheck ||
    !targetVersion ||
    !upgradeAvailable ||
    dismissed
  ) {
    return null;
  }

  return (
    <>
      <StatusBannerNotice
        tone="info"
        title={`New assistant version available: ${targetVersion}`}
        placement={placement}
        className={className}
        icon={
          upgrade.isPending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => setShowConfirmation(true)}
              disabled={upgrade.isPending}
            >
              Update
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={handleDismiss}
              disabled={upgrade.isPending}
            >
              Later
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={showConfirmation}
        title="Update assistant runtime"
        message={`Update to version ${targetVersion}? The assistant will be briefly unavailable while the assistant, gateway, and CES restart.`}
        confirmLabel="Update"
        onConfirm={handleConfirmUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </>
  );
}
