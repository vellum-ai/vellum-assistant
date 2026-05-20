import { Heart, Loader2, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { SegmentControl } from "@vellum/design-library/components/segment-control";
import { AssistantPicker } from "@/domains/settings/components/assistant-picker.js";
import { AssistantSleepPolicy } from "@/domains/settings/components/assistant-sleep-policy.js";
import { AssistantUpgrades } from "@/domains/settings/components/assistant-upgrades.js";
import { ComputeUpgradeCard } from "@/domains/settings/components/compute-upgrade-card.js";
import { DeleteAccountSection } from "@/domains/settings/components/delete-account-section.js";
import { IOSAppCard } from "@/domains/settings/components/ios-app-card.js";
import { MediaEmbedsCard } from "@/domains/settings/components/media-embeds-card.js";
import { RetireAssistant } from "@/domains/settings/components/retire-assistant.js";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { TimezonePicker } from "@/domains/settings/components/timezone-picker.js";
import { ProfileCard } from "@/domains/settings/components/profile-card.js";
import { AssistantOutOfStorageBanner } from "@/domains/settings/components/assistant-out-of-storage-banner.js";
import {
  AssistantStatusPanel,
  SystemResourcesPanel,
  useAssistantWithHealthz,
} from "@/domains/settings/components/assistant-status-panel.js";

import { useAuthStore } from "@/stores/auth-store.js";
import { useFeatureFlagStore } from "@/lib/feature-flags/feature-flag-store.js";
import {
  applyThemePreference,
  normalizeThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences.js";
import {
  getLocalSetting,
  setLocalSetting,
} from "@/domains/settings/local-settings.js";

function ThemeCard() {
  const velvet = useFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    const handleExternalThemeChange = (event: CustomEvent<string>) => {
      setTheme(
        normalizeThemePreference(event.detail, { velvetEnabled: velvet }),
      );
    };
    window.addEventListener(
      "vellumThemeChange",
      handleExternalThemeChange as EventListener,
    );
    return () => {
      window.removeEventListener(
        "vellumThemeChange",
        handleExternalThemeChange as EventListener,
      );
    };
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
    <SettingsCard title="Theme">
      <div className="max-w-[360px]">
        <SegmentControl<ThemePreference>
          ariaLabel="Theme"
          value={theme}
          onChange={handleThemeChange}
          items={themeItems}
        />
      </div>
    </SettingsCard>
  );
}

function TimezoneCard() {
  const [timezone, setTimezone] = useState<string>(() =>
    getLocalSetting("vellum_timezone", ""),
  );

  const handleChange = (value: string) => {
    setTimezone(value);
    setLocalSetting("vellum_timezone", value);
  };

  return (
    <SettingsCard
      title="Timezone"
      subtitle="Used when displaying times and scheduling reminders."
    >
      <TimezonePicker value={timezone} onChange={handleChange} />
    </SettingsCard>
  );
}

export function GeneralPage() {
  const { assistant, assistantLoading, healthz, healthzLoading, refetch } =
    useAssistantWithHealthz();
  const accountDeletion = useFeatureFlagStore.use.accountDeletion();
  const multiPlatformAssistant = useFeatureFlagStore.use.multiPlatformAssistant();
  const settingsSleepPolicy = useFeatureFlagStore.use.settingsSleepPolicy();
  const isLoggedIn = useAuthStore.use.isLoggedIn();

  const platformAssistant = assistant?.is_local ? null : assistant;

  const showSystemResources = platformAssistant != null;

  useEffect(() => {
    if (!showSystemResources || window.location.hash !== "#storage-resources") {
      return;
    }

    requestAnimationFrame(() => {
      document
        .getElementById("storage-resources")
        ?.scrollIntoView({ block: "start" });
    });
  }, [showSystemResources]);

  return (
    <div className="max-w-[940px] space-y-4">
      {platformAssistant && (
        <AssistantOutOfStorageBanner assistantId={platformAssistant.id} />
      )}
      <SettingsCard title="General">
        <AssistantStatusPanel
          assistant={platformAssistant}
          assistantLoading={assistantLoading}
          healthz={healthz}
          healthzLoading={healthzLoading}
        />
      </SettingsCard>

      {isLoggedIn && <ProfileCard />}

      {showSystemResources && (
        <SettingsCard
          id="storage-resources"
          title="Storage & Resources"
          compactAccessory
          accessory={
            <Button
              variant="ghost"
              size="compact"
              iconOnly={
                healthzLoading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )
              }
              tooltip="Refresh resource metrics"
              aria-label="Refresh resource metrics"
              disabled={assistantLoading || healthzLoading}
              onClick={() => void refetch()}
            />
          }
        >
          <SystemResourcesPanel
            healthz={healthz}
            healthzLoading={healthzLoading}
          />
        </SettingsCard>
      )}

      {platformAssistant && (
        <ComputeUpgradeCard assistant={platformAssistant} refetch={refetch} />
      )}

      <ThemeCard />

      {platformAssistant && (
        <SettingsCard title="Software Updates">
          <AssistantUpgrades
            assistantId={platformAssistant.id}
            currentVersion={
              healthz?.version ??
              platformAssistant.current_release_version ??
              null
            }
            onUpgradeComplete={() => {
              void refetch();
            }}
          />
        </SettingsCard>
      )}

      <IOSAppCard />

      {platformAssistant && settingsSleepPolicy && (
        <SettingsCard
          title="Sleep Policy"
          subtitle="Control how long this assistant stays awake when idle."
        >
          <AssistantSleepPolicy assistantId={platformAssistant.id} />
        </SettingsCard>
      )}

      <TimezoneCard />

      <MediaEmbedsCard />

      {multiPlatformAssistant && <AssistantPicker />}

      {platformAssistant && (
        <SettingsCard
          variant="danger"
          title="Retire Assistant"
          subtitle="Permanently retire this assistant and delete all associated data."
        >
          <RetireAssistant assistantId={platformAssistant.id} />
        </SettingsCard>
      )}

      {accountDeletion && <DeleteAccountSection />}
    </div>
  );
}
