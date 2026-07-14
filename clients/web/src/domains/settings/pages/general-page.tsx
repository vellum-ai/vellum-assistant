import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { DetailCard } from "@/components/detail-card";
import { DiskPressureBanner, type DiskPressureBannerMode } from "@/components/disk-pressure-banner";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { ProfileCard } from "@/components/profile-card";
import { AssistantPicker } from "@/domains/settings/components/assistant-picker";
import { AssistantSleepPolicy } from "@/domains/settings/components/assistant-sleep-policy";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import {
    AssistantUpgrades,
    LocalAssistantUpgrades,
} from "@/domains/settings/components/assistant-upgrades";
import { DeleteAccountSection } from "@/domains/settings/components/delete-account-section";
import { DevModeVersionUnlock } from "@/domains/settings/components/dev-mode-version-unlock";
import { IOSAppCard } from "@/domains/settings/components/ios-app-card";
import { PreferencesModal } from "@/domains/settings/components/preferences-modal";
import { PreviewReleaseChannel } from "@/domains/settings/components/preview-release-channel";
import { ResizeCard } from "@/domains/settings/components/resize-card";
import { RetireAssistant } from "@/domains/settings/components/retire-assistant";
import { TimezoneSection } from "@/domains/settings/components/timezone-section";
import { UpdateWindowModal } from "@/domains/settings/components/update-window-modal";
import { TwoFactorSection } from "@/domains/settings/security/two-factor-section";
import { TeleportCard } from "@/domains/settings/teleport/teleport-card";
import { Button } from "@vellumai/design-library/components/button";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import {
    applyThemePreference,
    readStoredThemePreference,
    type ThemePreference,
    writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { useActiveAssistantIsPlatformHosted, usePlatformGate } from "@/hooks/use-platform-gate";
import {
    getSelectedAssistant,
    isLocalAssistant,
    isLocalMode,
    isRemoteGatewayMode,
} from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useIsAuthenticated } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { watchDeviceSetting } from "@/utils/device-settings";
import { isPointerCoarse } from "@/utils/pointer";
import { routes } from "@/utils/routes";

function AppearanceCard() {
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
    <DetailCard title="Appearance">
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

export function GeneralPage() {
  const {
    assistant,
    healthz,
    healthzLoading,
    healthzPolling,
    refetch,
    refetchUntilResized,
  } = useAssistantWithHealthz();
  const multiPlatformAssistant = useClientFeatureFlagStore.use.multiPlatformAssistant();
  const teleportEnabled = useClientFeatureFlagStore.use.teleport();
  const accountMfaEnabled = useClientFeatureFlagStore.use.accountMfa();
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
  const [updateWindowOpen, setUpdateWindowOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);

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

  const versionValue =
    healthz?.version ?? assistant?.current_release_version ?? null;

  const showRetire =
    ((platformGate === "full" || canRetireLocally) && !!platformAssistant) ||
    (platformGate === "disabled" && !canRetireLocally);
  // Mirrors DeleteAccountSection's internal platformHostedOnly gate — it
  // returns null when gated, so the card must not render an empty shell.
  const showDeleteAccount = infraGate !== "gated";

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

      <ProfileCard
        // Handles are platform-only — withhold the prop for self-hosted assistants.
        assistant={isPlatformHosted ? platformAssistant : null}
        showHandles={isAuthenticated && platformGate === "full"}
      >
        <TimezoneSection />
      </ProfileCard>

      <DetailCard
        title="Version"
        subtitle="Manage your assistant's software version and updates."
        accessory={
          infraGate === "full" && platformAssistant ? (
            <Button
              variant="outlined"
              onClick={() => setUpdateWindowOpen(true)}
            >
              Update Window
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {assistant && (
            <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
              <span className="text-body-medium-default text-[var(--content-tertiary)]">
                Version
              </span>
              <DevModeVersionUnlock
                version={versionValue}
                loading={healthzLoading && !assistant.current_release_version}
                assistantId={assistant.id ?? null}
              />
            </div>
          )}
          {infraGate === "full" && platformAssistant && (
            <>
              <AssistantUpgrades
                assistantId={platformAssistant.id}
                currentVersion={versionValue}
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
            </>
          )}
          {canUpgradeLocally && assistant && (
            <LocalAssistantUpgrades
              assistantId={assistant.id}
              currentVersion={versionValue}
              onUpgradeComplete={() => {
                void refetch();
              }}
            />
          )}
          {infraGate === "disabled" && !canUpgradeLocally && (
            <PlatformLoginNotice>
              Log in to the Vellum platform to manage software updates.
            </PlatformLoginNotice>
          )}
        </div>
      </DetailCard>
      {infraGate === "full" && platformAssistant && (
        <UpdateWindowModal
          assistantId={platformAssistant.id}
          open={updateWindowOpen}
          onClose={() => setUpdateWindowOpen(false)}
        />
      )}

      <AppearanceCard />

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

      {/* Composer behavior is pointless on touch (Enter never sends) and
          shortcuts/launch-at-login are Electron-only, so hide the card when
          the modal would be empty. */}
      {(isElectron() || !isPointerCoarse()) && (
        <>
          <DetailCard
            title="Preferences"
            subtitle="Customize shortcuts and how Vellum behaves on this device."
            accessory={
              <Button
                variant="outlined"
                onClick={() => setPreferencesOpen(true)}
              >
                Customize
              </Button>
            }
          />
          <PreferencesModal
            open={preferencesOpen}
            onClose={() => setPreferencesOpen(false)}
          />
        </>
      )}

      {teleportEnabled && isElectron() && <TeleportCard />}

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

      {accountMfaEnabled && platformGate !== "gated" && (
        <DetailCard
          title="Two-Factor Authentication"
          subtitle="Require a code from an authenticator app when you sign in."
        >
          {platformGate === "disabled" ? (
            <PlatformLoginNotice>
              Log in to the Vellum platform to manage two-factor
              authentication.
            </PlatformLoginNotice>
          ) : (
            <TwoFactorSection />
          )}
        </DetailCard>
      )}

      {multiPlatformAssistant && <AssistantPicker />}

      {(showRetire || showDeleteAccount) && (
        <DetailCard variant="danger" title="Danger Zone">
          <div className="flex flex-col gap-6">
            {showRetire && (
              <section className="flex flex-col gap-2">
                <h3 className="text-title-small text-[var(--content-emphasised)]">
                  Retire Assistant
                </h3>
                <p className="text-body-medium-default text-[var(--content-tertiary)]">
                  Permanently retire this assistant and delete all associated
                  data.
                </p>
                <div className="mt-1">
                  {(platformGate === "full" || canRetireLocally) &&
                  platformAssistant ? (
                    <RetireAssistant assistantId={platformAssistant.id} />
                  ) : (
                    <PlatformLoginNotice>
                      Log in to the Vellum platform to retire this assistant.
                    </PlatformLoginNotice>
                  )}
                </div>
              </section>
            )}
            {showRetire && showDeleteAccount && (
              <div className="border-t border-[var(--border-subtle)]" />
            )}
            <DeleteAccountSection />
          </div>
        </DetailCard>
      )}
    </div>
  );
}
