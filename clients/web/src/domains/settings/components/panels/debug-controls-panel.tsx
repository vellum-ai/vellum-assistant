import { HardDrive, Loader2, RotateCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { type Assistant, getAssistant } from "@/assistant/api";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { RecoveryModeControls } from "@/domains/settings/components/recovery-mode-controls";
import { RestartAssistant } from "@/domains/settings/components/restart-assistant";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { isVellumStaff } from "@/lib/auth/staff";
import {
  getRunningChannel,
  isPreviewRequested,
  setPreviewRequested,
} from "@/lib/preview-channel";
import { captureError } from "@/lib/sentry/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { clearConsentForUser } from "@/lib/consent/consent-persistence";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { toast } from "@vellumai/design-library/components/toast";

export function DebugControlsPanel() {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const platformGate = usePlatformGate();
  const showInternalControls = isVellumStaff(user);

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const previewRequested = isPreviewRequested();
  const running = getRunningChannel();
  const runningVersion =
    running.version ?? t("debugControlsPanel.previewVersionUnknown");

  const handlePreviewToggle = useCallback((next: boolean) => {
    setPreviewRequested(next);
    window.location.reload();
  }, []);

  const handleReplayOnboarding = useCallback(() => {
    clearConsentForUser(user?.id ?? null);
    toast.success(t("debugControlsPanel.onboardingClearedToast"));
    navigate(routes.onboarding.privacy);
  }, [navigate, t, user?.id]);

  const fetchAssistant = useCallback(
    async (force?: boolean) => {
      if (!force && fetchedRef.current) {
        return;
      }
      if (!force) {
        setLoading(true);
      }
      try {
        const result = await getAssistant();
        if (result.ok) {
          fetchedRef.current = true;
          setAssistant(result.data);
        } else {
          setAssistant(null);
        }
      } catch (error) {
        captureError(error, { context: "fetch_assistant_for_debug_controls" });
        toast.error(t("debugControlsPanel.loadFailedToast"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
          <Wrench className="h-5 w-5 text-[var(--content-secondary)]" />
        </div>
        <div>
          <h2 className="text-title-small text-[var(--content-default)]">
            {t("debugControlsPanel.title")}
          </h2>
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("debugControlsPanel.subtitle")}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("debugControlsPanel.loading")}
        </div>
      ) : assistant ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
            <div className="min-w-0">
              <p className="text-body-medium-default text-[var(--content-default)]">
                {t("debugControlsPanel.restartTitle")}
              </p>
              <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                {t("debugControlsPanel.restartDescription")}
              </p>
            </div>
            <div className="ml-4 shrink-0">
              <RestartAssistant
                assistantId={assistant.id}
                isLocal={assistant.is_local}
              />
            </div>
          </div>

          <RecoveryModeControls
            assistantId={assistant.id}
            maintenanceMode={assistant.maintenance_mode}
            onMaintenanceModeChange={() => fetchAssistant(true)}
          />

          {showInternalControls && (
            <>
              <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
                <div className="min-w-0">
                  <p className="text-body-medium-default text-[var(--content-default)]">
                    {t("debugControlsPanel.replayTitle")}
                  </p>
                  <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                    {t("debugControlsPanel.replayDescription")}
                  </p>
                </div>
                <div className="ml-4 shrink-0">
                  <Button
                    variant="outlined"
                    leftIcon={<RotateCw />}
                    onClick={handleReplayOnboarding}
                  >
                    {t("debugControlsPanel.replay")}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-body-medium-default text-[var(--content-default)]">
                      {t("debugControlsPanel.previewTitle")}
                    </p>
                    <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                      {t("debugControlsPanel.previewDescription")}
                    </p>
                  </div>
                  <div className="ml-4 shrink-0">
                    <Toggle
                      checked={previewRequested}
                      onChange={handlePreviewToggle}
                      aria-label={
                        previewRequested
                          ? t("debugControlsPanel.previewOnAriaLabel")
                          : t("debugControlsPanel.previewOffAriaLabel")
                      }
                    />
                  </div>
                </div>
                <div className="mt-3 space-y-0.5 text-body-small-lighter text-[var(--content-tertiary)]">
                  <p>
                    {previewRequested
                      ? t("debugControlsPanel.previewRequestedPreview")
                      : t("debugControlsPanel.previewRequestedStable")}
                  </p>
                  <p>
                    {t(
                      running.channel === "preview"
                        ? "debugControlsPanel.previewRunningPreview"
                        : "debugControlsPanel.previewRunningStable",
                      { version: runningVersion },
                    )}
                  </p>
                  {previewRequested && running.channel === "stable" && (
                    <p>{t("debugControlsPanel.previewUnavailableHint")}</p>
                  )}
                </div>
              </div>
            </>
          )}

          {platformGate === "disabled" && (
            <PlatformLoginNotice>
              {t("debugControlsPanel.loginNotice")}
            </PlatformLoginNotice>
          )}
          {platformGate !== "disabled" && (
            <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
              <div className="mb-3 flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-[var(--content-secondary)]" />
                <h3 className="text-body-medium-default text-[var(--content-default)]">
                  {t("debugControlsPanel.backups")}
                </h3>
              </div>
              <AssistantBackups assistantId={assistant.id} />
            </div>
          )}
        </div>
      ) : (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("debugControlsPanel.noAssistant")}
        </p>
      )}
    </div>
  );
}
