import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

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

import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { isLocalMode } from "@/lib/local-mode";
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
} from "@/lib/device-settings";

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

function TimezoneCard() {
  const [timezone, setTimezone] = useState<string>(() =>
    getDeviceSetting("timezone", ""),
  );

  const handleChange = (value: string) => {
    setTimezone(value);
    setDeviceSetting("timezone", value);
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

  const platformAssistant = assistant?.is_local && !isLocalMode() ? null : assistant;

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

      {isLoggedIn && <ProfileCard assistant={platformAssistant} />}

      {assistant && (
        <ResizeCard
          assistant={assistant}
          healthz={healthz}
          healthzLoading={healthzLoading}
          healthzPolling={healthzPolling}
          refetch={refetch}
          refetchUntilResized={refetchUntilResized}
        />
      )}

      <ThemeCard />

      {platformAssistant && (
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

      <IOSAppCard />

      {platformAssistant && settingsSleepPolicy && (
        <DetailCard
          title="Sleep Policy"
          subtitle="Control how long this assistant stays awake when idle."
        >
          <AssistantSleepPolicy assistantId={platformAssistant.id} />
        </DetailCard>
      )}

      <TimezoneCard />

      <MediaEmbedsCard />

      {multiPlatformAssistant && <AssistantPicker />}

      {platformAssistant && (
        <DetailCard
          variant="danger"
          title="Retire Assistant"
          subtitle="Permanently retire this assistant and delete all associated data."
        >
          <RetireAssistant assistantId={platformAssistant.id} />
        </DetailCard>
      )}

      {accountDeletion && <DeleteAccountSection />}
    </div>
  );
}
