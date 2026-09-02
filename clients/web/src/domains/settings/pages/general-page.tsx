import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { ThemePicker } from "@/domains/settings/components/theme-picker";
import { DetailCard } from "@/components/detail-card";
import {
  DiskPressureBanner,
  type DiskPressureBannerMode,
} from "@/components/disk-pressure-banner";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { ProfileCard } from "@/components/profile-card";
import { AppIconRow } from "@/domains/settings/components/app-icon-row";
import { AssistantPicker } from "@/domains/settings/components/assistant-picker";
import { AssistantSleepPolicy } from "@/domains/settings/components/assistant-sleep-policy";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import {
  AssistantUpgrades,
  LocalAssistantUpgrades,
} from "@/domains/settings/components/assistant-upgrades";
import { DeleteAccountSection } from "@/domains/settings/components/delete-account-section";
import { DevModeVersionUnlock } from "@/domains/settings/components/dev-mode-version-unlock";
import { NativeAppCard } from "@/domains/settings/components/native-app-card";
import { PairDeviceCard } from "@/domains/settings/pair-device/pair-device-card";
import { PreferencesModal } from "@/domains/settings/components/preferences-modal";
import { PreviewReleaseChannel } from "@/domains/settings/components/preview-release-channel";
import { ResizeCard } from "@/domains/settings/components/resize-card";
import { RetireAssistant } from "@/domains/settings/components/retire-assistant";
import { ShowTipsRow } from "@/domains/settings/components/show-tips-row";
import { TimezoneSection } from "@/domains/settings/components/timezone-section";
import { UpdateWindowModal } from "@/domains/settings/components/update-window-modal";
import { TwoFactorSection } from "@/domains/settings/security/two-factor-section";
import { TeleportCard } from "@/domains/settings/teleport/teleport-card";
import { Button } from "@vellumai/design-library/components/button";

import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import {
  getRemoteAssistantDisplayName,
  getRemoteGatewayHubUrl,
  getSelectedAssistant,
  isLocalAssistant,
  isLocalClient,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativeMobile } from "@/runtime/platform-detection";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useIsAuthenticated } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";

export function GeneralPage() {
  const { t } = useTranslation("settings");
  const {
    assistant,
    healthz,
    healthzLoading,
    healthzPolling,
    refetch,
    refetchUntilResized,
  } = useAssistantWithHealthz();
  const multiPlatformAssistant =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  const teleportEnabled = useClientFeatureFlagStore.use.teleport();
  const accountMfaEnabled = useClientFeatureFlagStore.use.accountMfa();
  const settingsSleepPolicy =
    useAssistantFeatureFlagStore.use.settingsSleepPolicy();
  const isAuthenticated = useIsAuthenticated();
  const isNativeMobile = useIsNativeMobile();
  // The card supersedes the in-page picker so the two never render together.
  //
  // Deliberately wider than `useGatedSelectedAssistantId` in
  // `assistant/selection.ts`: that gate closes under `isGatewayAuthMode()`,
  // which is exactly where this card hands off to the hub chooser.
  const showAssistantSwitcherCard =
    isLocalClient() ||
    isAuthenticated ||
    isRemoteGatewayMode() ||
    isNativeMobile;
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
  const [searchParams, setSearchParams] = useSearchParams();

  // The keyboard-shortcuts redirect stub and tab aliases land here with
  // `?preferences=open` to surface the Preferences modal directly. Consume
  // the param so refresh/back does not reopen the modal.
  useEffect(() => {
    if (searchParams.get("preferences") !== "open") {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete("preferences");
    setSearchParams(next, { replace: true });
    setPreferencesOpen(true);
  }, [searchParams, setSearchParams]);

  const platformAssistant =
    assistant?.is_local && !isLocalClient() ? null : assistant;
  const selected = getSelectedAssistant();
  const hasSelectedLocalAssistant =
    isLocalClient() && !!assistant && !!selected && isLocalAssistant(selected);
  const canRetireLocally = hasSelectedLocalAssistant;
  const canUpgradeLocally = hasSelectedLocalAssistant && !isRemoteGatewayMode();
  // Whether an upgrade panel (platform or local) is on screen. Both panels
  // render the "Current" version line that carries the 7-tap developer-mode
  // unlock, so when neither shows we must render a standalone version line to
  // avoid dropping both the version display and the only unlock affordance
  // (e.g. logged out of the platform, or a self-hosted/remote-gateway runtime
  // that can't upgrade locally).
  const showsUpgradePanel =
    (infraGate === "full" && !!platformAssistant) ||
    (canUpgradeLocally && !!assistant);

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

  const openAssistantChooser = () => {
    const hubUrl = getRemoteGatewayHubUrl();
    if (isRemoteGatewayMode() && !isNativeMobile && hubUrl) {
      // Self-registration handoff: landing on the hub chooser records this
      // origin in the hub's remembered list. `hubUrl` is the hub SPA's
      // assistant root (`<origin>/assistant`), so the absolute chooser route
      // hangs off its origin.
      const params = new URLSearchParams({
        register: remoteGatewayPublicBaseUrl(),
      });
      const assistantName = getRemoteAssistantDisplayName();
      if (assistantName) {
        params.set("name", assistantName);
      }
      const hubOrigin = new URL(hubUrl).origin;
      window.location.assign(
        `${hubOrigin}${routes.selectAssistant}?${params.toString()}`,
      );
      return;
    }
    void navigate(`${routes.selectAssistant}?noAutoSkip=1`);
  };

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
          onReviewWorkspaceData={() =>
            void navigate(`${routes.workspace}?sort=size`)
          }
          onUpgradeStorage={
            infraGate === "full" ? () => void navigate(routes.plans) : null
          }
        />
      )}

      <ProfileCard
        // Handles are platform-only — withhold the prop for self-hosted assistants.
        assistant={isPlatformHosted ? platformAssistant : null}
        showHandles={isAuthenticated && platformGate === "full"}
      >
        <TimezoneSection />
        {accountMfaEnabled && platformGate !== "gated" && (
          <>
            <div className="border-t border-[var(--border-subtle)]" />
            <section className="flex flex-col gap-2">
              <h3 className="text-title-small text-[var(--content-emphasised)]">
                {t("generalPage.twoFactorTitle")}
              </h3>
              <p className="text-body-medium-default text-[var(--content-tertiary)]">
                {t("generalPage.twoFactorDescription")}
              </p>
              <div className="mt-1">
                {platformGate === "disabled" ? (
                  <PlatformLoginNotice>
                    {t("generalPage.twoFactorLoginNotice")}
                  </PlatformLoginNotice>
                ) : (
                  <TwoFactorSection />
                )}
              </div>
            </section>
          </>
        )}
      </ProfileCard>

      <DetailCard
        title={t("generalPage.versionTitle")}
        subtitle={t("generalPage.versionSubtitle")}
        accessory={
          infraGate === "full" && platformAssistant ? (
            <Button
              variant="outlined"
              onClick={() => setUpdateWindowOpen(true)}
            >
              {t("generalPage.updateWindow")}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
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
          {!showsUpgradePanel && assistant && (
            <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
              <span className="text-body-medium-default text-[var(--content-tertiary)]">
                {t("generalPage.current")}
              </span>
              <DevModeVersionUnlock
                version={versionValue}
                loading={healthzLoading && !assistant.current_release_version}
                assistantId={assistant.id ?? null}
              />
            </div>
          )}
          {infraGate === "disabled" && !canUpgradeLocally && (
            <PlatformLoginNotice>
              {t("generalPage.updatesLoginNotice")}
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
          title={t("generalPage.computeResourcesTitle")}
          subtitle={t("generalPage.computeResourcesSubtitle")}
        >
          <PlatformLoginNotice>
            {t("generalPage.computeResourcesLoginNotice")}
          </PlatformLoginNotice>
        </DetailCard>
      )}

      <DetailCard
        title={t("generalPage.preferencesTitle")}
        subtitle={t("generalPage.preferencesSubtitle")}
        accessory={
          <Button variant="outlined" onClick={() => setPreferencesOpen(true)}>
            {t("generalPage.customize")}
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <ThemePicker />
          <ShowTipsRow />
          <AppIconRow />
        </div>
      </DetailCard>

      <PreferencesModal
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
      />

      {teleportEnabled && isElectron() && <TeleportCard />}

      <NativeAppCard />

      <PairDeviceCard />

      {infraGate === "full" && platformAssistant && settingsSleepPolicy && (
        <DetailCard
          title={t("generalPage.sleepPolicyTitle")}
          subtitle={t("generalPage.sleepPolicySubtitle")}
        >
          <AssistantSleepPolicy assistantId={platformAssistant.id} />
        </DetailCard>
      )}
      {infraGate === "disabled" && settingsSleepPolicy && (
        <DetailCard
          title={t("generalPage.sleepPolicyTitle")}
          subtitle={t("generalPage.sleepPolicySubtitle")}
        >
          <PlatformLoginNotice>
            {t("generalPage.sleepPolicyLoginNotice")}
          </PlatformLoginNotice>
        </DetailCard>
      )}

      {multiPlatformAssistant && !showAssistantSwitcherCard && (
        <AssistantPicker />
      )}

      {showAssistantSwitcherCard && (
        <DetailCard
          title={t("generalPage.switchAssistantTitle")}
          subtitle={t("generalPage.switchAssistantSubtitle")}
          accessory={
            <Button variant="outlined" onClick={openAssistantChooser}>
              {t("generalPage.chooseAssistant")}
            </Button>
          }
        />
      )}

      {(showRetire || showDeleteAccount) && (
        <DetailCard variant="danger" title={t("generalPage.dangerZoneTitle")}>
          <div className="flex flex-col gap-6">
            {showRetire && (
              <section className="flex flex-col gap-2">
                <h3 className="text-title-small text-[var(--content-emphasised)]">
                  {t("generalPage.retireAssistantTitle")}
                </h3>
                <p className="text-body-medium-default text-[var(--content-tertiary)]">
                  {t("generalPage.retireAssistantDescription")}
                </p>
                <div className="mt-1">
                  {(platformGate === "full" || canRetireLocally) &&
                  platformAssistant ? (
                    <RetireAssistant assistantId={platformAssistant.id} />
                  ) : (
                    <PlatformLoginNotice>
                      {t("generalPage.retireAssistantLoginNotice")}
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
