import { CloudOff, LoaderCircle, Moon, WifiOff, Wrench } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";
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
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useConnectivityState } from "@/hooks/use-connectivity-state";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { useActiveAssistantIsPlatformHosted } from "@/hooks/use-platform-gate";
import { retryConnectivity } from "@/runtime/connectivity";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";

interface BannerConfig {
  title: ReactNode;
  tone: NoticeTone;
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

function operationalStatusBannerConfig(
  status: AssistantOperationalStatus | null | undefined,
  showDoctorAction: boolean,
): BannerConfig | null {
  if (!status || isHealthyOperationalStatus(status)) return null;

  switch (status.state) {
    case "crash_loop":
    case "unreachable":
    case "not_found":
      return {
        tone: "error",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        actions: showDoctorAction ? doctorAction() : undefined,
      };
    case "sleeping":
      return {
        tone: "neutral",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: <Moon className="h-4 w-4" aria-hidden="true" />,
      };
    case "maintenance_mode":
      return {
        tone: "info",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: <Wrench className="h-4 w-4" aria-hidden="true" />,
      };
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

function doctorAction(): ReactNode {
  return (
    <Button asChild variant="outlined" size="compact">
      <Link to={`${routes.settings.debug}?tab=doctor`}>Go to Doctor</Link>
    </Button>
  );
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
      />
    </div>
  );
}

function useAssistantBannerConfig(): BannerConfig | null {
  const electron = isElectron();
  const isNative = useIsNativePlatform();
  const connectivityState = useConnectivityState();
  const nativeConnected = useNetworkStatus();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const assistantId = operationalStatusAssistantId ?? activeAssistantId;
  const activeAssistantIsPlatformHosted = useActiveAssistantIsPlatformHosted();
  const targetIsLifecycleOperationAssistant =
    Boolean(assistantId) && assistantId === operationalStatusAssistantId;
  const showDoctorAction =
    activeAssistantIsPlatformHosted || targetIsLifecycleOperationAssistant;
  const statusQuery = useAssistantOperationalStatus(assistantId);

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

  if (statusQuery.isError) {
    return {
      tone: "error",
      title: "Assistant status is unavailable",
      actions: showDoctorAction ? doctorAction() : undefined,
    };
  }

  return operationalStatusBannerConfig(statusQuery.data, showDoctorAction);
}

export function StatusBanner({ className }: { className?: string }) {
  const banner = useAssistantBannerConfig();

  return banner ? <BannerNotice banner={banner} className={className} /> : null;
}
