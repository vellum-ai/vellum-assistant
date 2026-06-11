import { CloudOff, LoaderCircle, Moon, WifiOff, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@vellumai/design-library/components/button";
import {
  Notice,
  type NoticeTone,
} from "@vellumai/design-library/components/notice";

import {
  isHealthyOperationalStatus,
  type AssistantOperationalState,
  type AssistantOperationalStatus,
  useAssistantOperationalStatus,
} from "@/assistant/operational-status";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { assistantsMaintenanceModeExitCreate } from "@/generated/api/sdk.gen";
import { useConnectivityState } from "@/hooks/use-connectivity-state";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { captureError } from "@/lib/sentry/capture-error";
import { retryConnectivity } from "@/runtime/connectivity";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { cn } from "@/utils/misc";

interface BannerConfig {
  title: ReactNode;
  tone: NoticeTone;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}

const OPERATIONAL_STATUS_TITLES: Record<AssistantOperationalState, string> = {
  initializing: "Assistant is initializing",
  provisioning: "Assistant is provisioning",
  active: "Assistant is healthy",
  sleeping: "Assistant is sleeping",
  waking: "Assistant is waking",
  restarting: "Assistant is restarting",
  restoring_backup: "Assistant is restoring a backup",
  upgrading_assistant_version: "Assistant is upgrading",
  resizing_machine: "Assistant machine is resizing",
  resizing_storage: "Assistant storage is resizing",
  maintenance_mode: "Assistant is in maintenance mode",
  crash_loop: "Assistant is crash looping",
  unreachable: "Assistant is unreachable",
  not_found: "Assistant was not found",
  retiring: "Assistant is retiring",
};

function maintenanceModeBannerConfig(): BannerConfig {
  return {
    tone: "info",
    title: OPERATIONAL_STATUS_TITLES.maintenance_mode,
    icon: <Wrench className="h-4 w-4" aria-hidden="true" />,
  };
}

function operationalStatusBannerConfig(
  status: AssistantOperationalStatus | null | undefined,
): BannerConfig | null {
  if (!status || isHealthyOperationalStatus(status)) return null;

  switch (status.state) {
    case "crash_loop":
    case "unreachable":
    case "not_found":
      return {
        tone: "error",
        title: OPERATIONAL_STATUS_TITLES[status.state],
      };
    case "sleeping":
      return {
        tone: "neutral",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: <Moon className="h-4 w-4" aria-hidden="true" />,
      };
    case "maintenance_mode":
      return maintenanceModeBannerConfig();
    default:
      return {
        tone: "warning",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ),
      };
  }
}

function BannerNotice({
  banner,
  className,
}: {
  banner: BannerConfig;
  className?: string;
}) {
  return (
    <div className={cn("px-4 pt-2", className)}>
      <Notice
        tone={banner.tone}
        title={banner.title}
        icon={banner.icon}
        actions={banner.actions}
      >
        {banner.children}
      </Notice>
    </div>
  );
}

function useAssistantBannerConfig(): BannerConfig | null {
  const electron = isElectron();
  const isNative = useIsNativePlatform();
  const connectivityState = useConnectivityState();
  const nativeConnected = useNetworkStatus();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const assistantId = operationalStatusAssistantId ?? activeAssistantId;
  const statusQuery = useAssistantOperationalStatus(assistantId);
  const {
    data: operationalStatus,
    isError: operationalStatusIsError,
    refetch: refetchOperationalStatus,
  } = statusQuery;
  const [isExitingMaintenanceMode, setIsExitingMaintenanceMode] =
    useState(false);
  const [maintenanceModeExitError, setMaintenanceModeExitError] = useState<
    string | null
  >(null);

  const handleExitMaintenanceMode = useCallback(async () => {
    if (!assistantId || isExitingMaintenanceMode) return;

    setIsExitingMaintenanceMode(true);
    setMaintenanceModeExitError(null);

    try {
      const { response } = await assistantsMaintenanceModeExitCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });

      if (!response?.ok) {
        throw new Error("Exit maintenance mode returned non-ok response");
      }

      await Promise.allSettled([
        refetchOperationalStatus(),
        lifecycleService.checkAssistant(),
      ]);
    } catch (err) {
      captureError(err, { context: "exit_maintenance_mode_status_banner" });
      setMaintenanceModeExitError(
        "Failed to exit maintenance mode. Please try again.",
      );
    } finally {
      setIsExitingMaintenanceMode(false);
    }
  }, [assistantId, isExitingMaintenanceMode, refetchOperationalStatus]);

  if (electron && connectivityState === "device-offline") {
    return {
      tone: "warning",
      title: "You're offline",
      icon: <WifiOff className="h-4 w-4" aria-hidden="true" />,
    };
  }

  if (!electron && isNative && !nativeConnected) {
    return {
      tone: "warning",
      title: "You're offline",
      icon: <WifiOff className="h-4 w-4" aria-hidden="true" />,
    };
  }

  if (electron && connectivityState === "backend-unreachable") {
    return {
      tone: "warning",
      title: "Trying to reach Vellum…",
      icon: <CloudOff className="h-4 w-4" aria-hidden="true" />,
      actions: (
        <Button variant="outlined" size="compact" onClick={retryConnectivity}>
          Retry now
        </Button>
      ),
    };
  }

  const lifecycleMaintenanceModeActive =
    assistantState.kind === "active" &&
    assistantState.maintenanceMode?.enabled === true;
  const shouldUseLifecycleMaintenanceMode =
    lifecycleMaintenanceModeActive &&
    (!operationalStatus || isHealthyOperationalStatus(operationalStatus));

  if (operationalStatusIsError && !shouldUseLifecycleMaintenanceMode) {
    return {
      tone: "error",
      title: "Assistant status is unavailable",
    };
  }

  const operationalBanner = shouldUseLifecycleMaintenanceMode
    ? maintenanceModeBannerConfig()
    : operationalStatusBannerConfig(operationalStatus);
  const isMaintenanceModeBanner =
    operationalStatus?.state === "maintenance_mode" ||
    shouldUseLifecycleMaintenanceMode;
  if (!isMaintenanceModeBanner || !operationalBanner) {
    return operationalBanner;
  }

  return {
    ...operationalBanner,
    tone: maintenanceModeExitError ? "error" : operationalBanner.tone,
    children: maintenanceModeExitError,
    actions: assistantId ? (
      <Button
        variant="outlined"
        size="compact"
        leftIcon={
          isExitingMaintenanceMode ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : undefined
        }
        disabled={isExitingMaintenanceMode}
        onClick={() => {
          void handleExitMaintenanceMode();
        }}
      >
        Resume Assistant
      </Button>
    ) : undefined,
  };
}

export function StatusBanner({ className }: { className?: string }) {
  const banner = useAssistantBannerConfig();

  return banner ? <BannerNotice banner={banner} className={className} /> : null;
}
