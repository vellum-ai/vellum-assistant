import { Loader2, Wrench } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Notice } from "@vellum/design-library/components/notice";
import {
  assistantsMaintenanceModeEnterCreate,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen.js";
import type { MaintenanceMode } from "@/generated/api/types.gen.js";
import { reportError } from "@/lib/errors/report.js";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isActive = maintenanceMode?.enabled === true;

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
        reportError(
          new Error("Enter maintenance mode returned non-ok response"),
          {
            context: "enter_maintenance_mode",
            userMessage: "Failed to enter maintenance mode",
          },
        );
        setError("Failed to enter Recovery Mode. Please try again.");
      }
    } catch (err) {
      reportError(err, {
        context: "enter_maintenance_mode",
        userMessage: "Failed to enter maintenance mode",
      });
      setError("Failed to enter Recovery Mode. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [assistantId, onMaintenanceModeChange]);

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
        reportError(
          new Error("Exit maintenance mode returned non-ok response"),
          {
            context: "exit_maintenance_mode",
            userMessage: "Failed to exit maintenance mode",
          },
        );
        setError("Failed to exit Recovery Mode. Please try again.");
      }
    } catch (err) {
      reportError(err, {
        context: "exit_maintenance_mode",
        userMessage: "Failed to exit maintenance mode",
      });
      setError("Failed to exit Recovery Mode. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [assistantId, onMaintenanceModeChange]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-lg border border-[var(--border-base)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Wrench
            className={`h-4 w-4 shrink-0 ${isActive ? "text-[var(--system-mid-strong)]" : "text-[var(--content-disabled)]"}`}
          />
          <div className="min-w-0">
            <p className="text-body-medium-default text-[var(--content-default)]">
              Recovery Mode
            </p>
            {isActive ? (
              <p className="text-body-small-default text-[var(--system-mid-strong)]">
                Active — connected to the debug terminal
              </p>
            ) : (
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Pause the assistant and connect directly to its workspace via
                the debug terminal
              </p>
            )}
          </div>
        </div>

        <div className="ml-4 flex shrink-0 items-center gap-2">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
          ) : isActive ? (
            <Button variant="outlined" onClick={handleExit}>
              Resume Assistant
            </Button>
          ) : (
            <Button variant="dangerOutline" onClick={handleEnter}>
              Enter Recovery Mode
            </Button>
          )}
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
