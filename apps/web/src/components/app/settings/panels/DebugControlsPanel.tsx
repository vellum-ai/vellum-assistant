
import { Loader2, RotateCw, Wrench } from "lucide-react";
import { useNavigate } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { toast } from "@vellum/design-library/components/toast";
import { AssistantBackups } from "@/components/app/settings/assistant-backups.js";
import { RestartAssistant } from "@/components/app/settings/RestartAssistant.js";
import { RecoveryModeControls } from "@/components/app/settings/panels/RecoveryModeControls.js";
import { type Assistant, getAssistant } from "@/lib/assistants/api.js";
import { useAuth } from "@/lib/auth.js";
import { reportError } from "@/lib/errors/report.js";
import { clearOnboardingFlags } from "@/lib/onboarding/prefs.js";
import { routes } from "@/lib/routes.js";

// Vellum-internal gate: matches the admin-page convention of
// `isVellumEmail(email) || is_staff`. Inlined here to avoid pulling
// from a sibling route group's `_lib`.
function isInternalUser(email: string | null, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !!email && email.toLowerCase().endsWith("@vellum.ai");
}

/**
 * DebugControlsPanel groups the assistant-level debug actions: restart and
 * Recovery Mode. It is rendered inside the "Controls" sub-tab of the Debug
 * settings tab.
 */
export function DebugControlsPanel() {
  const navigate = useNavigate();
  const { email, isAdmin } = useAuth();
  const showInternalControls = isInternalUser(email, isAdmin);

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const handleReplayOnboarding = useCallback(() => {
    clearOnboardingFlags();
    toast.success("Onboarding flags cleared.");
    // `?replay=1` is forwarded to the hatching screen, which skips the
    // `hatchAssistant()` call so we don't spawn a duplicate assistant for
    // Vellum users with the multi-platform-assistant flag enabled.
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
      reportError(error, {
        context: "fetch_assistant_for_debug_controls",
        userMessage: "Failed to load assistant info",
      });
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
            Manage backups, restart your assistant, or enter Recovery Mode to connect to the debug terminal.
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
          <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
            <h3 className="mb-3 text-body-medium-default text-[var(--content-default)]">
              Backups
            </h3>
            <AssistantBackups assistantId={assistant.id} />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
            <div className="min-w-0">
              <p className="text-body-medium-default text-[var(--content-default)]">
                Restart Assistant
              </p>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Restart the assistant machine. It will be briefly unavailable during the restart.
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
              Clear local onboarding flags and re-walk the privacy → hatch screens. Your existing assistant is preserved.
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
