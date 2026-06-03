import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Notice } from "@vellum/design-library/components/notice";
import { SegmentControl } from "@vellum/design-library/components/segment-control";
import { AssistantPicker } from "@/domains/settings/components/assistant-picker";
import { AssistantSleepPolicy } from "@/domains/settings/components/assistant-sleep-policy";
import { AssistantUpgrades } from "@/domains/settings/components/assistant-upgrades";
import { ResizeCard } from "@/domains/settings/components/resize-card";
import { DeleteAccountSection } from "@/domains/settings/components/delete-account-section";
import { IOSAppCard } from "@/domains/settings/components/ios-app-card";
import { MediaEmbedsCard } from "@/domains/settings/components/media-embeds-card";
import { PreviewReleaseChannel } from "@/domains/settings/components/preview-release-channel";
import { RetireAssistant } from "@/domains/settings/components/retire-assistant";
import { DetailCard } from "@/components/detail-card";
import { TimezonePicker } from "@/domains/settings/components/timezone-picker";
import { ProfileCard } from "@/components/profile-card";
import { AssistantOutOfStorageBanner } from "@/domains/settings/components/assistant-out-of-storage-banner";
import {
  AssistantStatusPanel,
  useAssistantWithHealthz,
} from "@/domains/settings/components/assistant-status-panel";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { client } from "@/generated/api/client.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import {
  isLocalMode,
  isLocalAssistant,
  getSelectedAssistant,
} from "@/lib/local-mode";
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import {
  getDeviceSetting,
  setDeviceSetting,
  watchDeviceSetting,
} from "@/utils/device-settings";

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
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
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
  const accountDeletion = useAssistantFeatureFlagStore.use.accountDeletion();
  const multiPlatformAssistant = useAssistantFeatureFlagStore.use.multiPlatformAssistant();
  const settingsSleepPolicy = useAssistantFeatureFlagStore.use.settingsSleepPolicy();
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const platformGate = usePlatformGate();
  const infraGate = usePlatformGate({ platformHostedOnly: true });

  const platformAssistant = assistant?.is_local && !isLocalMode() ? null : assistant;
  const selected = getSelectedAssistant();
  const canRetireLocally =
    isLocalMode() && !!assistant && !!selected && isLocalAssistant(selected);

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
    <div className="max-w-[940px] space-y-4">
      {platformAssistant && (
        <AssistantOutOfStorageBanner assistantId={platformAssistant.id} />
      )}
      <DetailCard title="General">
        <AssistantStatusPanel
          assistant={platformAssistant}
          assistantLoading={assistantLoading}
          healthz={healthz}
          healthzLoading={healthzLoading}
        />
      </DetailCard>

      {isLoggedIn && platformGate === "full" && <ProfileCard assistant={platformAssistant} />}

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
          <Notice tone="info">
            Log in to the Vellum platform to manage compute resources.
          </Notice>
        </DetailCard>
      )}

      <ThemeCard />

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
      {infraGate === "disabled" && (
        <DetailCard title="Software Updates">
          <Notice tone="info">
            Log in to the Vellum platform to manage software updates.
          </Notice>
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
          <Notice tone="info">
            Log in to the Vellum platform to manage sleep policy.
          </Notice>
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
          <Notice tone="info">
            Log in to the Vellum platform to retire this assistant.
          </Notice>
        </DetailCard>
      )}

      {accountDeletion && <DeleteAccountSection />}
    </div>
  );
}
