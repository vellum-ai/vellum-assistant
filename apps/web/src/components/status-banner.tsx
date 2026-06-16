import {
  CircleAlert,
  CircleCheck,
  CloudOff,
  Info,
  LoaderCircle,
  Moon,
  OctagonX,
  WifiOff,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Link } from "react-router";
import { Button } from "@vellumai/design-library/components/button";
import { type NoticeTone } from "@vellumai/design-library/components/notice";

import {
  type LocalAssistantHealth,
  useLocalAssistantHealth,
} from "@/assistant/local-health";
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
import { isElectron } from "@/runtime/is-electron";
import { wakeLocalAssistantHost } from "@/runtime/local-mode-host";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";

interface BannerConfig {
  title: ReactNode;
  tone: NoticeTone;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}

const LOCAL_WAKE_SETTLING_MS = 60_000;

export type StatusBannerPlacement = "web" | "electron";

interface StatusToneClasses {
  container: string;
  icon: string;
  action: string;
  DefaultIcon: LucideIcon | null;
}

const STATUS_TONE_CLASSES: Record<NoticeTone, StatusToneClasses> = {
  info: {
    container: "bg-[var(--surface-overlay)]",
    icon: "text-[color:var(--content-secondary)]",
    action: "[--status-banner-action-color:var(--primary-base)]",
    DefaultIcon: Info,
  },
  success: {
    container: "bg-[var(--system-positive-weak)]",
    icon: "text-[color:var(--system-positive-strong)]",
    action: "[--status-banner-action-color:var(--system-positive-strong)]",
    DefaultIcon: CircleCheck,
  },
  warning: {
    container: "bg-[var(--system-mid-weak)]",
    icon: "text-[color:var(--system-mid-strong)]",
    action: "[--status-banner-action-color:var(--system-mid-strong)]",
    DefaultIcon: CircleAlert,
  },
  error: {
    container: "bg-[var(--system-negative-weak)]",
    icon: "text-[color:var(--system-negative-strong)]",
    action: "[--status-banner-action-color:var(--system-negative-strong)]",
    DefaultIcon: OctagonX,
  },
  neutral: {
    container: "bg-[var(--surface-overlay)]",
    icon: "text-[color:var(--content-secondary)]",
    action: "[--status-banner-action-color:var(--primary-base)]",
    DefaultIcon: null,
  },
};

const STATUS_BANNER_PLACEMENT_CLASSES: Record<StatusBannerPlacement, string> = {
  web: "min-h-10 rounded-none px-4 py-[10px]",
  electron: "min-h-8 rounded-lg px-2 py-[7px]",
};

export interface StatusBannerNoticeProps
  extends Omit<ComponentProps<"div">, "title" | "children"> {
  tone: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  placement?: StatusBannerPlacement;
}

export function StatusBannerNotice({
  tone,
  title,
  children,
  icon,
  actions,
  placement = "web",
  className,
  ref,
  ...rest
}: StatusBannerNoticeProps) {
  const toneClasses = STATUS_TONE_CLASSES[tone];
  const role = tone === "error" ? "alert" : "status";
  const titleClassName =
    placement === "web"
      ? "text-body-medium-default leading-5"
      : "text-body-small-default leading-[18px]";
  const resolvedIcon =
    icon === undefined
      ? toneClasses.DefaultIcon
        ? <toneClasses.DefaultIcon aria-hidden="true" />
        : null
      : icon;

  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      data-slot="status-banner-notice"
      data-placement={placement}
      data-tone={tone}
      className={cn(
        "flex w-full shrink-0 items-center justify-between gap-3 overflow-hidden",
        "text-[color:var(--content-default)]",
        STATUS_BANNER_PLACEMENT_CLASSES[placement],
        toneClasses.container,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {resolvedIcon ? (
          <span
            className={cn(
              "flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5",
              toneClasses.icon,
            )}
          >
            {resolvedIcon}
          </span>
        ) : null}
        <div className="min-w-0">
          <div
            className={cn(
              "truncate text-[color:var(--content-emphasised)]",
              titleClassName,
            )}
          >
            {title}
          </div>
          {children ? (
            <div className="text-body-small-default leading-4 text-[color:var(--content-secondary)]">
              {children}
            </div>
          ) : null}
        </div>
      </div>

      {actions ? (
        <div
          className={cn(
            "flex shrink-0 items-center border-l border-[color-mix(in_srgb,var(--content-default)_14%,transparent)] text-label-medium-default",
            "text-[color:var(--status-banner-action-color)]",
            toneClasses.action,
            placement === "web"
              ? "gap-2 pl-4 leading-5"
              : "gap-1.5 pl-2 leading-[18px]",
            "[&_[data-slot=button]]:h-auto [&_[data-slot=button]]:border-0 [&_[data-slot=button]]:bg-transparent",
            "[&_[data-slot=button]]:-mx-1 [&_[data-slot=button]]:rounded-sm [&_[data-slot=button]]:px-1 [&_[data-slot=button]]:py-0",
            "[&_[data-slot=button]]:text-label-medium-default [&_[data-slot=button]]:transition-[background-color,color,opacity]",
            "[&_[data-slot=button]]:leading-[inherit] [&_[data-slot=button]]:shadow-none",
            "[&_[data-slot=button]]:[--vbtn-fg:var(--status-banner-action-color)]",
            "[&_[data-slot=button]]:hover:[--vbtn-fg:var(--status-banner-action-color)]",
            "[&_[data-slot=button]]:hover:bg-[color-mix(in_srgb,var(--status-banner-action-color)_12%,transparent)] [&_[data-slot=button]]:hover:opacity-90",
            "[&_[data-slot=button]]:focus-visible:ring-2 [&_[data-slot=button]]:focus-visible:ring-[var(--ring)] [&_[data-slot=button]]:focus-visible:ring-offset-0",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
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

function localHealthBannerConfig(
  health: LocalAssistantHealth | null,
  wakeAction?: ReactNode,
  wakeError?: ReactNode,
): BannerConfig | null {
  switch (health) {
    case "sleeping":
      return {
        tone: wakeError ? "error" : "neutral",
        title: "Your assistant is asleep",
        children: wakeError,
        icon: <Moon className="h-4 w-4" aria-hidden="true" />,
        actions: wakeAction,
      };
    case "starting":
      return {
        tone: "neutral",
        title: "Your assistant is waking up",
        icon: (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ),
      };
    case "crashed":
      return {
        tone: "error",
        title: "Your assistant crashed",
        children: wakeError,
        actions: wakeAction,
      };
    case "unreachable":
      return {
        tone: wakeError ? "error" : "neutral",
        title: "Your assistant is asleep",
        icon: <Moon className="h-4 w-4" aria-hidden="true" />,
        children: wakeError,
        actions: wakeAction,
      };
    case "unhealthy":
      return {
        tone: "warning",
        title: "Assistant is unhealthy",
      };
    default:
      return null;
  }
}

function doctorAction(): ReactNode {
  return (
    <Button asChild variant="outlined" size="compact">
      <Link to={`${routes.settings.debug}?tab=doctor`}>Go to Doctor</Link>
    </Button>
  );
}

function canWakeLocalHealth(health: LocalAssistantHealth | null): boolean {
  return (
    health === "sleeping" || health === "crashed" || health === "unreachable"
  );
}

function BannerNotice({
  banner,
  className,
  placement,
}: {
  banner: BannerConfig;
  className?: string;
  placement: StatusBannerPlacement;
}) {
  return (
    <div
      className={cn(
        placement === "electron" ? "px-4 pt-2" : "px-0 pt-0",
        className,
      )}
    >
      <StatusBannerNotice
        tone={banner.tone}
        title={banner.title}
        icon={banner.icon}
        actions={banner.actions}
        placement={placement}
      >
        {banner.children}
      </StatusBannerNotice>
    </div>
  );
}

function useAssistantBannerConfig(): BannerConfig | null {
  const electron = isElectron();
  const isNative = useIsNativePlatform();
  const { connectivityState, retryConnectivity } = useConnectivityState();
  const nativeConnected = useNetworkStatus();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const assistantId = operationalStatusAssistantId ?? activeAssistantId;
  const showDoctorAction =
    assistantState.kind === "active" &&
    !assistantState.isLocal &&
    Boolean(activeAssistantId) &&
    assistantId === activeAssistantId;
  const statusQuery = useAssistantOperationalStatus(assistantId);
  // Non-null only for local / self-hosted assistants, where the
  // platform's operational status never polls and the lifecycle
  // service's healthz heartbeat is the only signal.
  const localHealth = useLocalAssistantHealth();
  const {
    data: operationalStatus,
    isError: operationalStatusIsError,
    refetch: refetchOperationalStatus,
  } = statusQuery;

  // Track whether the assistant was recently sleeping so we can suppress
  // the brief "unreachable" flash that occurs during the tail end of a
  // wake (pod ready per k8s but application healthz not yet ok).
  const [wasRecentlySleeping, setWasRecentlySleeping] = useState(false);
  useEffect(() => {
    if (operationalStatus?.state === "sleeping") {
      setWasRecentlySleeping(true);
    } else if (
      operationalStatus?.state === "active" ||
      operationalStatus?.state === "crash_loop" ||
      operationalStatus?.state === "not_found"
    ) {
      setWasRecentlySleeping(false);
    }
  }, [operationalStatus?.state]);

  // Auto-clear the override after 60s so a genuinely failed wake surfaces
  // the real "unreachable" error with the Doctor action.
  useEffect(() => {
    if (!wasRecentlySleeping || operationalStatus?.state !== "unreachable") {
      return;
    }
    const timeout = setTimeout(() => {
      setWasRecentlySleeping(false);
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [wasRecentlySleeping, operationalStatus?.state]);
  const [isExitingMaintenanceMode, setIsExitingMaintenanceMode] =
    useState(false);
  const [maintenanceModeExitError, setMaintenanceModeExitError] = useState<
    string | null
  >(null);
  const [isWakingLocalAssistant, setIsWakingLocalAssistant] = useState(false);
  const [isLocalWakeSettling, setIsLocalWakeSettling] = useState(false);
  const [wakeLocalAssistantError, setWakeLocalAssistantError] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!isLocalWakeSettling) return;
    const timeout = setTimeout(() => {
      setIsLocalWakeSettling(false);
    }, LOCAL_WAKE_SETTLING_MS);
    return () => clearTimeout(timeout);
  }, [isLocalWakeSettling]);

  useEffect(() => {
    if (
      localHealth === "healthy" ||
      localHealth === "unhealthy" ||
      localHealth === "sleeping"
    ) {
      setIsLocalWakeSettling(false);
    }
  }, [localHealth]);

  useEffect(() => {
    setIsLocalWakeSettling(false);
  }, [activeAssistantId]);

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

  const handleWakeLocalAssistant = useCallback(async () => {
    if (!activeAssistantId || isWakingLocalAssistant) return;

    setIsWakingLocalAssistant(true);
    setIsLocalWakeSettling(true);
    setWakeLocalAssistantError(null);

    try {
      const result = await wakeLocalAssistantHost(activeAssistantId);
      if (!result.ok) {
        setIsLocalWakeSettling(false);
        setWakeLocalAssistantError(
          result.error || "Wake failed. Try running vellum wake in your terminal.",
        );
        return;
      }

      await Promise.allSettled([
        refetchOperationalStatus(),
        retryConnectivity(),
        lifecycleService.checkAssistant(),
      ]);
      lifecycleService.triggerReachabilityProbe();
    } catch (err) {
      setIsLocalWakeSettling(false);
      captureError(err, { context: "wake_local_assistant_status_banner" });
      setWakeLocalAssistantError(
        "Wake failed. Try running vellum wake in your terminal.",
      );
    } finally {
      setIsWakingLocalAssistant(false);
    }
  }, [
    activeAssistantId,
    isWakingLocalAssistant,
    refetchOperationalStatus,
    retryConnectivity,
  ]);

  useEffect(() => {
    if (!canWakeLocalHealth(localHealth)) {
      setWakeLocalAssistantError(null);
    }
  }, [localHealth]);

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

  const effectiveLocalHealth =
    (isWakingLocalAssistant || isLocalWakeSettling) &&
    canWakeLocalHealth(localHealth)
      ? "starting"
      : localHealth;
  const localWakeAction =
    canWakeLocalHealth(effectiveLocalHealth) ? (
      <Button
        variant="outlined"
        size="compact"
        leftIcon={
          isWakingLocalAssistant ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : undefined
        }
        disabled={!activeAssistantId || isWakingLocalAssistant}
        onClick={() => {
          void handleWakeLocalAssistant();
        }}
      >
        Wake up
      </Button>
    ) : undefined;
  const localHealthBanner = localHealthBannerConfig(
    effectiveLocalHealth,
    localWakeAction,
    wakeLocalAssistantError,
  );
  if (localHealthBanner) {
    return localHealthBanner;
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
      actions: showDoctorAction ? doctorAction() : undefined,
    };
  }

  // When the status transitions from sleeping directly to unreachable, the
  // assistant is in the final phase of waking (pod ready per k8s but the
  // application healthz hasn't responded ok yet). Show "waking" so the user
  // sees a smooth sleeping → waking → active progression.
  const effectiveStatus =
    operationalStatus?.state === "unreachable" && wasRecentlySleeping
      ? { ...operationalStatus, state: "waking" as AssistantOperationalState }
      : operationalStatus;

  const operationalBanner = shouldUseLifecycleMaintenanceMode
    ? maintenanceModeBannerConfig()
    : operationalStatusBannerConfig(effectiveStatus, showDoctorAction);
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

export function StatusBanner({
  className,
  placement = isElectron() ? "electron" : "web",
}: {
  className?: string;
  placement?: StatusBannerPlacement;
}) {
  const banner = useAssistantBannerConfig();

  return banner ? (
    <BannerNotice banner={banner} className={className} placement={placement} />
  ) : null;
}
