import {
  CircleAlert,
  CircleCheck,
  CloudOff,
  Info,
  LoaderCircle,
  Moon,
  TriangleAlert,
  WifiOff,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { isCliWakeableAssistant } from "@/lib/local-mode";
import { captureError } from "@/lib/sentry/capture-error";
import { isElectron } from "@/runtime/is-electron";
import {
  isLocalModeHostAvailable,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useOrganizationStore } from "@/stores/organization-store";
import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";
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
  content: string;
  icon: string;
  action: string;
  DefaultIcon: LucideIcon | null;
}

const STATUS_TONE_CLASSES: Record<NoticeTone, StatusToneClasses> = {
  info: {
    container: "bg-[var(--system-info-weak)]",
    content: "text-[color:var(--system-info-strong)]",
    icon: "text-[color:var(--system-info-strong)]",
    action: "[--status-banner-action-color:var(--system-info-strong)]",
    DefaultIcon: Info,
  },
  success: {
    container: "bg-[var(--system-positive-weak)]",
    content: "text-[color:var(--system-positive-strong)]",
    icon: "text-[color:var(--system-positive-strong)]",
    action: "[--status-banner-action-color:var(--system-positive-strong)]",
    DefaultIcon: CircleCheck,
  },
  warning: {
    container: "bg-[var(--system-mid-weak)]",
    content: "text-[color:var(--system-mid-strong)]",
    icon: "text-[color:var(--system-mid-strong)]",
    action: "[--status-banner-action-color:var(--system-mid-strong)]",
    DefaultIcon: CircleAlert,
  },
  error: {
    container: "bg-[var(--system-negative-weak)]",
    content: "text-[color:var(--system-negative-strong)]",
    icon: "text-[color:var(--system-negative-strong)]",
    action: "[--status-banner-action-color:var(--system-negative-strong)]",
    DefaultIcon: TriangleAlert,
  },
  neutral: {
    container: "bg-[var(--surface-active)]",
    content: "text-[color:var(--content-secondary)]",
    icon: "text-[color:var(--content-secondary)]",
    action: "[--status-banner-action-color:var(--content-secondary)]",
    DefaultIcon: null,
  },
};

const STATUS_BANNER_PLACEMENT_CLASSES: Record<StatusBannerPlacement, string> = {
  web: "min-h-10 rounded-none px-4 py-[10px]",
  electron: "min-h-8 rounded-[6px] px-2 py-[7px]",
};

export interface StatusBannerNoticeProps extends Omit<
  ComponentProps<"div">,
  "title" | "children"
> {
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
    icon === undefined ? (
      toneClasses.DefaultIcon ? (
        <toneClasses.DefaultIcon aria-hidden="true" />
      ) : null
    ) : (
      icon
    );

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
          <div className={cn("truncate", toneClasses.content, titleClassName)}>
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
            "flex shrink-0 items-center border-l border-[color-mix(in_srgb,var(--status-banner-action-color)_22%,transparent)] text-label-medium-default",
            "text-[color:var(--status-banner-action-color)]",
            toneClasses.action,
            placement === "web"
              ? "gap-2 pl-4 leading-5"
              : "gap-1.5 pl-2 leading-[18px]",
            "[&_[data-slot=button]]:h-auto [&_[data-slot=button]]:border-0 [&_[data-slot=button]]:bg-transparent",
            "[&_[data-slot=button]]:-mx-1 [&_[data-slot=button]]:rounded-sm [&_[data-slot=button]]:px-1 [&_[data-slot=button]]:py-0",
            "[&_[data-slot=button]]:text-label-medium-default [&_[data-slot=button]]:uppercase",
            "[&_[data-slot=button]]:leading-[inherit] [&_[data-slot=button]]:shadow-none",
            "[&_[data-slot=button]]:[--vbtn-fg:var(--status-banner-action-color)]",
            "[&_[data-slot=button]]:hover:!bg-transparent [&_[data-slot=button]]:hover:!opacity-100",
            "[&_[data-slot=button]]:hover:[--vbtn-fg:var(--status-banner-action-color)]",
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
  migrating: "Assistant is migrating",
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

// Titles shown when a transient operation fails. The platform keeps the
// in-progress `state` (e.g. `upgrading_assistant_version`) but flips
// `detail_state` to `"failed"`, so we surface a terminal failure message
// rather than spinning on the operation forever.
const OPERATIONAL_STATUS_FAILED_TITLES: Partial<
  Record<AssistantOperationalState, string>
> = {
  initializing: "Assistant failed to initialize",
  migrating: "Assistant migration failed",
  provisioning: "Assistant failed to provision",
  waking: "Assistant failed to wake",
  restarting: "Assistant restart failed",
  restoring_backup: "Backup restore failed",
  upgrading_assistant_version: "Assistant upgrade failed",
  resizing_machine: "Machine resize failed",
  resizing_storage: "Storage resize failed",
  retiring: "Assistant failed to retire",
};

function maintenanceModeBannerConfig(): BannerConfig {
  return {
    tone: "warning",
    title: OPERATIONAL_STATUS_TITLES.maintenance_mode,
    icon: <Wrench className="h-4 w-4" aria-hidden="true" />,
  };
}

function spinnerIcon(): ReactNode {
  return <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />;
}

function wakingDotIcon(): ReactNode {
  return (
    <span
      className="busy-indicator inline-block size-2 rounded-full bg-current"
      aria-hidden="true"
    />
  );
}

function failedOperationActions(
  showDoctorAction: boolean,
  onDismiss?: () => void,
): ReactNode | undefined {
  if (!showDoctorAction && !onDismiss) return undefined;
  return (
    <>
      {showDoctorAction ? doctorAction() : null}
      {showDoctorAction && onDismiss ? (
        <span
          aria-hidden="true"
          className="h-3 w-px bg-[color-mix(in_srgb,var(--status-banner-action-color)_35%,transparent)]"
        />
      ) : null}
      {onDismiss ? (
        <Button variant="ghost" size="compact" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </>
  );
}

function operationalStatusBannerConfig(
  status: AssistantOperationalStatus | null | undefined,
  showDoctorAction: boolean,
  onDismissFailedOperation?: () => void,
): BannerConfig | null {
  if (!status || isHealthyOperationalStatus(status)) return null;

  // A transient operation (upgrade, resize, restart, …) can fail while the
  // reported `state` is still the in-progress operation. The platform signals
  // this via `detail_state: "failed"`. Surface it as an error so the banner
  // doesn't spin indefinitely on a dead operation.
  if (status.detail_state === "failed") {
    const failedTitle = OPERATIONAL_STATUS_FAILED_TITLES[status.state];
    if (failedTitle) {
      return {
        tone: "error",
        title: failedTitle,
        children: status.detail?.message ?? undefined,
        actions: failedOperationActions(
          showDoctorAction,
          onDismissFailedOperation,
        ),
      };
    }
  }

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
    case "upgrading_assistant_version":
    case "resizing_machine":
    case "resizing_storage":
    case "initializing":
    case "migrating":
    case "provisioning":
      return {
        tone: "info",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: spinnerIcon(),
      };
    case "waking":
      return {
        tone: "info",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: wakingDotIcon(),
      };
    case "restarting":
    case "restoring_backup":
    case "retiring":
      return {
        tone: "warning",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: spinnerIcon(),
      };
    default:
      return {
        tone: "warning",
        title: OPERATIONAL_STATUS_TITLES[status.state],
        icon: spinnerIcon(),
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
        tone: "info",
        title: "Your assistant is waking up",
        icon: wakingDotIcon(),
      };
    case "upgrading":
      return {
        tone: "warning",
        title: "Assistant is upgrading",
        icon: (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ),
      };
    case "migrating":
      return {
        tone: "info",
        title: "Assistant is migrating",
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
  reserveTopSafeArea,
}: {
  banner: BannerConfig;
  className?: string;
  placement: StatusBannerPlacement;
  reserveTopSafeArea?: boolean;
}) {
  return (
    <div
      className={cn(
        placement === "electron" ? "px-4 pt-2" : "px-0 pt-0",
        className,
      )}
      style={
        reserveTopSafeArea
          ? {
              paddingTop:
                "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
            }
          : undefined
      }
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
  const selectedAssistantId =
    useResolvedAssistantsStore.use.selectedAssistantId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const selectedOperationalStatusAssistantId = useMemo(() => {
    const platformAssistants = assistantsValidForOrg(
      assistants,
      currentOrganizationId,
    ).filter(
      (assistant) =>
        assistant.isPlatformHosted === true && assistant.isLocal === false,
    );
    // Prefer the selected assistant when it is a platform assistant, else
    // fall back to the org's first platform assistant. The unconditional
    // fallback is deliberate: during boot and claim/migration windows the
    // selection can legitimately be null, stale, or pointing at a local
    // assistant while the org's platform assistant is the one with status
    // worth showing (e.g. "Assistant is migrating"). Gating this on selection
    // semantics breaks hydration, cross-org, and store-population edge
    // cases; if the brief wrong-assistant poll while lifecycle is unresolved
    // ever matters, fix it with a selector in assistant/selection.ts.
    return (
      platformAssistants.find(
        (assistant) => assistant.id === selectedAssistantId,
      )?.id ??
      platformAssistants[0]?.id ??
      null
    );
  }, [assistants, currentOrganizationId, selectedAssistantId]);
  const assistantId =
    operationalStatusAssistantId ??
    activeAssistantId ??
    selectedOperationalStatusAssistantId;
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

  // Suppress the brief "unreachable" flash during the active → sleeping
  // transition. When the pod is shutting down, healthz fails before the
  // backend registers the sleep, causing a transient unreachable state.
  const [wasRecentlyActive, setWasRecentlyActive] = useState(false);
  useEffect(() => {
    if (operationalStatus?.state === "active") {
      setWasRecentlyActive(true);
    } else if (
      operationalStatus?.state === "sleeping" ||
      operationalStatus?.state === "crash_loop" ||
      operationalStatus?.state === "not_found"
    ) {
      setWasRecentlyActive(false);
    }
  }, [operationalStatus?.state]);

  // Auto-clear after 15s so a genuinely unreachable assistant surfaces.
  useEffect(() => {
    if (!wasRecentlyActive || operationalStatus?.state !== "unreachable") {
      return;
    }
    const timeout = setTimeout(() => {
      setWasRecentlyActive(false);
    }, 15_000);
    return () => clearTimeout(timeout);
  }, [wasRecentlyActive, operationalStatus?.state]);
  // Track dismissed failed-operation banners so the user can clear
  // terminal error messages (e.g. "Assistant upgrade failed"). The
  // dismissal is keyed on the operation state so it auto-resets when
  // the platform reports a new state.
  const [dismissedFailedState, setDismissedFailedState] = useState<
    string | null
  >(null);
  const prevOperationalStateRef = useRef(operationalStatus?.state);
  useEffect(() => {
    const prev = prevOperationalStateRef.current;
    prevOperationalStateRef.current = operationalStatus?.state;
    if (operationalStatus?.state !== prev) {
      setDismissedFailedState(null);
    }
  }, [operationalStatus?.state]);

  const handleDismissFailedOperation = useCallback(() => {
    if (operationalStatus?.state) {
      setDismissedFailedState(operationalStatus.state);
    }
  }, [operationalStatus?.state]);

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
          result.error ||
            "Wake failed. Try running vellum wake in your terminal.",
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
      tone: "error",
      title: "You're offline",
      icon: <WifiOff className="h-4 w-4" aria-hidden="true" />,
    };
  }

  if (!electron && isNative && !nativeConnected) {
    return {
      tone: "error",
      title: "You're offline",
      icon: <WifiOff className="h-4 w-4" aria-hidden="true" />,
    };
  }

  // A local / self-hosted assistant can surface where local-mode operations
  // aren't available (managed web, remote-web tunnel). There's no transport to
  // wake it from here, so the banner is informative and action-free.
  if (!isLocalModeHostAvailable() && canWakeLocalHealth(localHealth)) {
    return {
      tone: "neutral",
      title: "Your assistant runs locally",
      icon: <Moon className="h-4 w-4" aria-hidden="true" />,
      children:
        "Open the Vellum desktop app or run vellum wake in your terminal to start it.",
    };
  }

  const effectiveLocalHealth =
    (isWakingLocalAssistant || isLocalWakeSettling) &&
    canWakeLocalHealth(localHealth)
      ? "starting"
      : localHealth;
  // Only offer "Wake up" when the CLI can actually start this assistant —
  // `vellum wake` works on plain local entries, not Docker/apple-container.
  const localWakeAction =
    canWakeLocalHealth(effectiveLocalHealth) &&
    !!activeAssistantId &&
    isCliWakeableAssistant(activeAssistantId) ? (
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
      tone: "error",
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
  // Conversely, when the status transitions from active directly to
  // unreachable, the pod is shutting down for sleep. Show "sleeping" so
  // the user sees a smooth active → sleeping progression.
  const effectiveStatus =
    operationalStatus?.state === "unreachable" && wasRecentlySleeping
      ? { ...operationalStatus, state: "waking" as AssistantOperationalState }
      : operationalStatus?.state === "unreachable" && wasRecentlyActive
        ? {
            ...operationalStatus,
            state: "sleeping" as AssistantOperationalState,
          }
        : operationalStatus;

  const isFailedOperationDismissed =
    effectiveStatus?.detail_state === "failed" &&
    effectiveStatus.state === dismissedFailedState;

  const operationalBanner = shouldUseLifecycleMaintenanceMode
    ? maintenanceModeBannerConfig()
    : isFailedOperationDismissed
      ? null
      : operationalStatusBannerConfig(
          effectiveStatus,
          showDoctorAction,
          handleDismissFailedOperation,
        );
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
  reserveTopSafeArea = false,
}: {
  className?: string;
  placement?: StatusBannerPlacement;
  reserveTopSafeArea?: boolean;
}) {
  const banner = useAssistantBannerConfig();

  return banner ? (
    <BannerNotice
      banner={banner}
      className={className}
      placement={placement}
      reserveTopSafeArea={reserveTopSafeArea}
    />
  ) : null;
}
