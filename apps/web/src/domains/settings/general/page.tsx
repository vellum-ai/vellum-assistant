
import { Heart, Loader2, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { SegmentControl } from "@vellum/design-library/components/segment-control";
import { AssistantPicker } from "@/components/app/settings/assistant-picker.js";
import { AssistantSleepPolicy } from "@/components/app/settings/AssistantSleepPolicy.js";
import { AssistantUpgrades } from "@/components/app/settings/assistant-upgrades.js";
import { ComputeUpgradeCard } from "@/components/app/settings/ComputeUpgradeCard.js";
import { DeleteAccountSection } from "@/components/app/settings/DeleteAccountSection/DeleteAccountSection.js";
import { IOSAppCard } from "@/components/app/settings/IOSAppCard.js";
import { MediaEmbedsCard } from "@/components/app/settings/MediaEmbedsCard.js";
import { RetireAssistant } from "@/components/app/settings/retire-assistant.js";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { TimezonePicker } from "@/components/app/settings/TimezonePicker.js";
import { ProfileCard } from "@/components/app/settings/profile-card.js";
import { AssistantOutOfStorageBanner } from "@/components/app/settings/panels/assistant-out-of-storage-banner.js";
import {
  AssistantStatusPanel,
  SystemResourcesPanel,
  useAssistantWithHealthz,
} from "@/components/app/settings/panels/assistant-status-panel.js";

import { useAuth } from "@/lib/auth.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import {
  applyThemePreference,
  normalizeThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/lib/theme-preferences.js";
import {
  getLocalSetting,
  setLocalSetting,
} from "@/domains/settings/_lib/local-settings.js";

function ThemeCard() {
  const { velvet } = useAppFeatureFlags();
  const [theme, setTheme] = useState<ThemePreference>(
    () => readStoredThemePreference({ velvetEnabled: velvet }),
  );

  // Sync theme state when changed externally (e.g. keyboard shortcut)
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

export default function GeneralSettingsPage() {
  const { assistant, assistantLoading, healthz, healthzLoading, refetch } =
    useAssistantWithHealthz();
  const { accountDeletion, multiPlatformAssistant, settingsSleepPolicy } =
    useAppFeatureFlags();
  const { isLoggedIn } = useAuth();

  // useAssistantWithHealthz uses getAssistant(), which falls back to a local
  // self-hosted registration when the user has no platform assistant. Cards
  // that act on a platform assistant (Retire, Storage & Resources, Software
  // Updates, Sleep Policy, status panel) must not render for that local
  // fallback — Retire's no-id endpoint filters out local assistants and
  // returns 404, which the client treats as success and clobbers state.
  const platformAssistant = assistant?.is_local ? null : assistant;

  // Always show for platform assistants — SystemResourcesPanel handles
  // missing metrics inline. Hiding on metric absence would also remove the
  // refresh affordance and break the #storage-resources deep link.
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

      {/* Profile/handle is a Vellum platform identity — no signed-in
          session means there's no /v1/user/me/ to read, so hide the card
          entirely rather than render a 401-driven error state. */}
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
          <SystemResourcesPanel healthz={healthz} healthzLoading={healthzLoading} />
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
            currentVersion={healthz?.version ?? platformAssistant.current_release_version ?? null}
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

      {multiPlatformAssistant && (
        <AssistantPicker />
      )}

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
