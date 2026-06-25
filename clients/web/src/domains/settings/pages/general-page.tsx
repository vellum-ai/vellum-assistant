import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { DetailCard } from "@/components/detail-card";
import { DiskPressureBanner, type DiskPressureBannerMode } from "@/components/disk-pressure-banner";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { ProfileCard } from "@/components/profile-card";
import { AssistantPicker } from "@/domains/settings/components/assistant-picker";
import { AssistantSleepPolicy } from "@/domains/settings/components/assistant-sleep-policy";
import {
    AssistantStatusPanel,
    useAssistantWithHealthz,
} from "@/domains/settings/components/assistant-status-panel";
import {
    AssistantUpgrades,
    LocalAssistantUpgrades,
} from "@/domains/settings/components/assistant-upgrades";
import { ComposerSendCard } from "@/domains/settings/components/composer-send-card";
import { DeleteAccountSection } from "@/domains/settings/components/delete-account-section";
import { IOSAppCard } from "@/domains/settings/components/ios-app-card";
import { LaunchAtLoginCard } from "@/domains/settings/components/launch-at-login-card";
import { MediaEmbedsCard } from "@/domains/settings/components/media-embeds-card";
import { PreviewReleaseChannel } from "@/domains/settings/components/preview-release-channel";
import { ResizeCard } from "@/domains/settings/components/resize-card";
import { RetireAssistant } from "@/domains/settings/components/retire-assistant";
import { TimezonePicker } from "@/domains/settings/components/timezone-picker";
import { TeleportCard } from "@/domains/settings/teleport/teleport-card";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
    applyThemePreference,
    readStoredThemePreference,
    type ThemePreference,
    writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { client } from "@/generated/api/client.gen";
import { useActiveAssistantIsPlatformHosted, usePlatformGate } from "@/hooks/use-platform-gate";
import {
    getSelectedAssistant,
    isLocalAssistant,
    isLocalMode,
    isRemoteGatewayMode,
} from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useIsAuthenticated } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import {
    getDeviceSetting,
    setDeviceSetting,
    watchDeviceSetting,
} from "@/utils/device-settings";
import { routes } from "@/utils/routes";

function ThemeCard() {
  const velvet = useClientFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
  }, [velvet]);

  useEffect(() => {
    return watchDeviceSetting("theme", () => {
      setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
    });
  }, [velvet]);

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    writeStoredThemePreference(newTheme);
    applyThemePreference(newTheme);
  };

  const themeItems = [
    {
      value: "system" as const,
      label: "System",
      icon: <Monitor className="h-4 w-4" />,
    },
    {
      value: "light" as const,
      label: "Light",
      icon: <Sun className="h-4 w-4" />,
    },
    {
      value: "dark" as const,
      label: "Dark",
      icon: <Moon className="h-4 w-4" />,
    },
    ...(velvet
      ? [
          {
            value: "velvet" as const,
            label: "Velvet",
            icon: <Heart className="h-4 w-4" />,
          },
        ]
      : []),
  ];

  return (
    <DetailCard title="Theme">
      <div className="max-w-[360px]">
        <SegmentControl<ThemePreference>
          ariaLabel="Theme"
          value={theme}
          onChange={handleThemeChange}
          items={themeItems}
        />
      </div>
    </DetailCard>
  );
}

export function TimezoneCard() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [timezone, setTimezone] = useState<string>(() =>
    getDeviceSetting("timezone", ""),
  );

  // Hold the live assistant id so a PATCH that fires (or drains) after the
  // user switches assistants always targets the *current* one. Assigned in an
  // effect (never during render) to avoid mutating a ref while rendering.
  const assistantIdRef = useRef(assistantId);
  useEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  // Serialize the `ui.userTimezone` override PATCH (last-writer-wins): at most
  // one in flight. A change while one is in flight only records the latest
  // desired value; the in-flight PATCH drains to it on settle, so overlapping
  // rapid changes can never land out of order and leave a stale override.
  const inFlightRef = useRef(false);
  const pendingValueRef = useRef<string | null>(null);

  // Stable indirection so the `.finally` drain can call the latest
  // `syncOverride` without referencing `const syncOverride` inside its own
  // initializer (which would be a temporal-dead-zone access).
  const syncOverrideRef = useRef<(value: string) => void>(() => {});

  const syncOverride = (value: string) => {
    if (inFlightRef.current) {
      pendingValueRef.current = value;
      return;
    }
    // Re-read the current active assistant at fire time so a queued write after
    // an assistant switch targets whatever assistant is selected now, not the
    // one active when the change was first requested.
    const currentAssistantId = assistantIdRef.current;
    if (!currentAssistantId) {
      // No assistant to target: drop this write and clear queued state so the
      // serializer can't deadlock.
      pendingValueRef.current = null;
      return;
    }
    inFlightRef.current = true;
    pendingValueRef.current = null;
    // `value` is the chosen IANA zone, or "" when auto is selected (the schema
    // documents "" clears the setting). Silent on error.
    client
      .patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: currentAssistantId },
        body: { ui: { userTimezone: value } },
        throwOnError: true,
      })
      .catch((error) => {
        captureError(error, { context: "settings-timezone-override" });
      })
      .finally(() => {
        inFlightRef.current = false;
        const pending = pendingValueRef.current;
        pendingValueRef.current = null;
        if (pending !== null) syncOverrideRef.current(pending);
      });
  };

  // Keep the drain indirection pointed at the latest `syncOverride`. Assigned
  // in an effect (never during render) for the same "no refs during render"
  // reason as `assistantIdRef`.
  useEffect(() => {
    syncOverrideRef.current = syncOverride;
  });

  const handleChange = (value: string) => {
    // Local source of truth for the reactive `useEffectiveTimezone` hook.
    setTimezone(value);
    setDeviceSetting("timezone", value);

    // Explicit user action: write the manual override to the authoritative
    // `ui.userTimezone` cascade tier. Fire-and-forget; never block the local
    // setting on the network write, and never throw out of handleChange.
    // `syncOverride` self-guards on a missing assistant id.
    syncOverride(value);
  };

  return (
    <DetailCard
      title="Timezone"
      subtitle="Used when displaying times and scheduling reminders."
    >
      <TimezonePicker value={timezone} onChange={handleChange} />
    </DetailCard>
  );
}

export function GeneralPage() {
  const {
    assistant,
    assistantLoading,
    healthz,
    healthzLoading,
    healthzPolling,
    refetch,
    refetchUntilResized,
  } = useAssistantWithHealthz();
  const multiPlatformAssistant = useClientFeatureFlagStore.use.multiPlatformAssistant();
  const teleportEnabled = useClientFeatureFlagStore.use.teleport();
  const settingsSleepPolicy = useAssistantFeatureFlagStore.use.settingsSleepPolicy();
  const isAuthenticated = useIsAuthenticated();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();
  const infraGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const diskPressure = useDiskPressureMonitor({
    assistantId: assistant?.id ?? null,
    enabled: infraGate === "full" && isPlatformHosted,
  });

  const platformAssistant = assistant?.is_local && !isLocalMode() ? null : assistant;
  const selected = getSelectedAssistant();
  const hasSelectedLocalAssistant =
    isLocalMode() && !!assistant && !!selected && isLocalAssistant(selected);
  const canRetireLocally = hasSelectedLocalAssistant;
  const canUpgradeLocally =
    hasSelectedLocalAssistant && !isRemoteGatewayMode();

  useEffect(() => {
    if (!assistant || window.location.hash !== "#storage-resources") {
      return;
    }

    requestAnimationFrame(() => {
      document
        .getElementById("storage-resources")
        ?.scrollIntoView({ block: "start" });
    });
  }, [assistant]);

  return (
    <div className="space-y-4">
      {diskPressure.status && diskPressure.mode !== "inactive" && (
        <DiskPressureBanner
          status={diskPressure.status}
          mode={diskPressure.mode as DiskPressureBannerMode}
          isAcknowledging={diskPressure.isAcknowledging}
          acknowledgeError={diskPressure.acknowledgeError?.message ?? null}
          onAcknowledge={() => void diskPressure.acknowledge()}
          onReviewWorkspaceData={() => void navigate(`${routes.workspace}?sort=size`)}
          onUpgradeStorage={
            infraGate === "full"
              ? () => void navigate(`${routes.settings.billing}?adjust_plan=1`)
              : null
          }
        />
      )}
      <DetailCard title="General">
        <AssistantStatusPanel
          assistant={platformAssistant}
          assistantLoading={assistantLoading}
          healthz={healthz}
          healthzLoading={healthzLoading}
        />
      </DetailCard>

      {isAuthenticated && platformGate === "full" && (
        // Handles are platform-only — withhold the prop for self-hosted assistants.
        <ProfileCard assistant={isPlatformHosted ? platformAssistant : null} />
      )}

      {infraGate === "full" && assistant && (
        <ResizeCard
          assistant={assistant}
          healthz={healthz}
          healthzLoading={healthzLoading}
          healthzPolling={healthzPolling}
          refetch={refetch}
          refetchUntilResized={refetchUntilResized}
        />
      )}
      {infraGate === "disabled" && (
        <DetailCard
          id="storage-resources"
          title="Compute & Resources"
          subtitle="Monitor resource usage and manage your assistant's compute profile."
        >
          <PlatformLoginNotice>
            Log in to the Vellum platform to manage compute resources.
          </PlatformLoginNotice>
        </DetailCard>
      )}

      <ThemeCard />

      <ComposerSendCard />

      {isElectron() && <LaunchAtLoginCard />}

      {teleportEnabled && isElectron() && <TeleportCard />}

      {infraGate === "full" && platformAssistant && (
        <DetailCard title="Software Updates">
          <AssistantUpgrades
            assistantId={platformAssistant.id}
            currentVersion={
              healthz?.version ??
              platformAssistant.current_release_version ??
              null
            }
            releaseChannel={platformAssistant.release_channel}
            onUpgradeComplete={() => {
              void refetch();
            }}
          />
          <PreviewReleaseChannel
            assistantId={platformAssistant.id}
            onComplete={() => {
              void refetch();
            }}
          />
        </DetailCard>
      )}
      {canUpgradeLocally && assistant && (
        <DetailCard title="Software Updates">
          <LocalAssistantUpgrades
            assistantId={assistant.id}
            currentVersion={
              healthz?.version ??
              assistant.current_release_version ??
              null
            }
            onUpgradeComplete={() => {
              void refetch();
            }}
          />
        </DetailCard>
      )}
      {infraGate === "disabled" && !canUpgradeLocally && (
        <DetailCard title="Software Updates">
          <PlatformLoginNotice>
            Log in to the Vellum platform to manage software updates.
          </PlatformLoginNotice>
        </DetailCard>
      )}

      <IOSAppCard />

      {infraGate === "full" && platformAssistant && settingsSleepPolicy && (
        <DetailCard
          title="Sleep Policy"
          subtitle="Control how long this assistant stays awake when idle."
        >
          <AssistantSleepPolicy assistantId={platformAssistant.id} />
        </DetailCard>
      )}
      {infraGate === "disabled" && settingsSleepPolicy && (
        <DetailCard
          title="Sleep Policy"
          subtitle="Control how long this assistant stays awake when idle."
        >
          <PlatformLoginNotice>
            Log in to the Vellum platform to manage sleep policy.
          </PlatformLoginNotice>
        </DetailCard>
      )}

      <TimezoneCard />

      <MediaEmbedsCard />

      {multiPlatformAssistant && <AssistantPicker />}

      {(platformGate === "full" || canRetireLocally) && platformAssistant && (
        <DetailCard
          variant="danger"
          title="Retire Assistant"
          subtitle="Permanently retire this assistant and delete all associated data."
        >
          <RetireAssistant assistantId={platformAssistant.id} />
        </DetailCard>
      )}
      {platformGate === "disabled" && !canRetireLocally && (
        <DetailCard
          variant="danger"
          title="Retire Assistant"
          subtitle="Permanently retire this assistant and delete all associated data."
        >
          <PlatformLoginNotice>
            Log in to the Vellum platform to retire this assistant.
          </PlatformLoginNotice>
        </DetailCard>
      )}

      <DeleteAccountSection />
    </div>
  );
}
