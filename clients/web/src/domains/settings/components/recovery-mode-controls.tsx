import { Loader2, Wrench } from "lucide-react";
import { useCallback, useState } from "react";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import {
  assistantsMaintenanceModeEnterCreate,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen";
import type { MaintenanceMode } from "@/generated/api/types.gen";
import {
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

interface RecoveryModeControlsProps {
  assistantId: string;
  maintenanceMode: MaintenanceMode | null;
  onMaintenanceModeChange: () => void | Promise<void>;
}

export function RecoveryModeControls({
  assistantId,
  maintenanceMode,
  onMaintenanceModeChange,
}: RecoveryModeControlsProps) {
  const { t } = useTranslation("settings");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Recovery Mode is platform-managed — self-hosted assistants have no
  // equivalent, so `platformHostedOnly: true` flips "gated" when the active
  // assistant is self-hosted regardless of platform-session state.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so this
  // panel can render while lifecycle is `{ kind: "loading" }`. Pair the
  // permissive gate value with the lifecycle-loading signal so the
  // enter/exit-mutation buttons stay disabled during the deep-link
  // resolution race — but NOT in already-resolved non-hosted states
  // (`retired`, `error`) where the parent
  // wouldn't render this panel anyway (`maintenanceMode` would be null).
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();

  const handleEnter = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { response } = await assistantsMaintenanceModeEnterCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      if (response?.ok) {
        await onMaintenanceModeChange();
      } else {
        captureError(
          new Error("Enter maintenance mode returned non-ok response"),
          { context: "enter_maintenance_mode" },
        );
        setError(t("recoveryModeControls.enterError"));
      }
    } catch (err) {
      captureError(err, { context: "enter_maintenance_mode" });
      setError(t("recoveryModeControls.enterError"));
    } finally {
      setLoading(false);
    }
  }, [assistantId, onMaintenanceModeChange, t]);

  const handleExit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { response } = await assistantsMaintenanceModeExitCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      if (response?.ok) {
        await onMaintenanceModeChange();
      } else {
        captureError(
          new Error("Exit maintenance mode returned non-ok response"),
          { context: "exit_maintenance_mode" },
        );
        setError(t("recoveryModeControls.exitError"));
      }
    } catch (err) {
      captureError(err, { context: "exit_maintenance_mode" });
      setError(t("recoveryModeControls.exitError"));
    } finally {
      setLoading(false);
    }
  }, [assistantId, onMaintenanceModeChange, t]);

  // Self-hosted assistants don't run platform-managed Recovery Mode.
  // Early return must follow every hook above so that gate transitions
  // (e.g. lifecycle flipping to `self_hosted` after the API resolves)
  // never skip a hook and trigger a hook-order violation.
  if (platformGate === "gated") {
    return null;
  }

  const isActive = maintenanceMode?.enabled === true;
  // Treat the lifecycle-loading window as effective loading: the existing
  // spinner branch already replaces the action button while a mutation is
  // in flight, so reusing it here keeps UX consistent and prevents the
  // race-window click on a fresh deep-link.
  const isResolving = platformGate === "full" && isLifecycleLoading;
  const effectiveLoading = loading || isResolving;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Wrench
            className={`h-4 w-4 shrink-0 ${isActive ? "text-[var(--system-mid-strong)]" : "text-[var(--content-disabled)]"}`}
          />
          <div className="min-w-0">
            <p className="text-body-medium-default text-[var(--content-default)]">
              {t("recoveryModeControls.title")}
            </p>
            {isActive ? (
              <p className="text-body-small-default text-[var(--system-mid-strong)]">
                {t("recoveryModeControls.activeDescription")}
              </p>
            ) : (
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                {t("recoveryModeControls.inactiveDescription")}
              </p>
            )}
          </div>
        </div>

        <div className="ml-4 flex shrink-0 items-center gap-2">
          {platformGate === "disabled" ? null : effectiveLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
          ) : isActive ? (
            <Button variant="outlined" onClick={handleExit}>
              {t("recoveryModeControls.resumeAssistant")}
            </Button>
          ) : (
            <Button variant="dangerOutline" onClick={handleEnter}>
              {t("recoveryModeControls.enter")}
            </Button>
          )}
        </div>
      </div>

      {platformGate === "disabled" && (
        <PlatformLoginNotice>
          {isActive
            ? t("recoveryModeControls.loginNoticeExit")
            : t("recoveryModeControls.loginNoticeEnter")}
        </PlatformLoginNotice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
