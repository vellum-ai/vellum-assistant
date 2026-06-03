import { Loader2, RotateCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { RestartAssistant } from "@/domains/settings/components/restart-assistant";
import { RecoveryModeControls } from "@/domains/settings/components/recovery-mode-controls";
import { type Assistant, getAssistant } from "@/assistant/api";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useAuthStore } from "@/stores/auth-store";
import { captureError } from "@/lib/sentry/capture-error";
import { clearOnboardingFlags } from "@/utils/onboarding-cleanup";
import { routes } from "@/utils/routes";

function isInternalUser(email: string | null, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !!email && email.toLowerCase().endsWith("@vellum.ai");
}

export function DebugControlsPanel() {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const platformGate = usePlatformGate();
  const showInternalControls = isInternalUser(user?.email ?? null, user?.isStaff ?? false);

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const handleReplayOnboarding = useCallback(() => {
    clearOnboardingFlags();
    toast.success("Onboarding flags cleared.");
    navigate(`${routes.onboarding.privacy}?replay=1`);
  }, [navigate]);

  const fetchAssistant = useCallback(async (force?: boolean) => {
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
      toast.error("Failed to load assistant info");
    } finally {
      setLoading(false);
    }
  }, []);

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
            General
          </h2>
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Manage backups, restart your assistant, or enter Recovery Mode to
            connect to the debug terminal.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading assistant info...
        </div>
      ) : assistant ? (
        <div className="space-y-4">
          {platformGate === "disabled" && (
            <Notice tone="info">
              Log in to the Vellum platform to manage backups.
            </Notice>
          )}
          {platformGate !== "disabled" && (
            <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
              <h3 className="mb-3 text-body-medium-default text-[var(--content-default)]">
                Backups
              </h3>
              <AssistantBackups assistantId={assistant.id} />
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
            <div className="min-w-0">
              <p className="text-body-medium-default text-[var(--content-default)]">
                Restart Assistant
              </p>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Restart the assistant machine. It will be briefly unavailable
                during the restart.
              </p>
            </div>
            <div className="ml-4 shrink-0">
              <RestartAssistant assistantId={assistant.id} />
            </div>
          </div>

          <RecoveryModeControls
            assistantId={assistant.id}
            maintenanceMode={assistant.maintenance_mode}
            onMaintenanceModeChange={() => fetchAssistant(true)}
          />
        </div>
      ) : (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          No assistant found. Hatch an assistant to access debug controls.
        </p>
      )}

      {showInternalControls && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
          <div className="min-w-0">
            <p className="text-body-medium-default text-[var(--content-default)]">
              Replay onboarding (Vellum-only)
            </p>
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              Clear local onboarding flags and re-walk the privacy → hatch
              screens. Your existing assistant is preserved.
            </p>
          </div>
          <div className="ml-4 shrink-0">
            <Button
              variant="outlined"
              leftIcon={<RotateCw />}
              onClick={handleReplayOnboarding}
            >
              Replay
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
