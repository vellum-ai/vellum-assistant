
import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library";
import { assistantsMaintenanceModeExitCreate } from "@/generated/api/sdk.gen.js";

interface MaintenanceModeBannerProps {
  assistantId: string;
  onExited: () => void;
}

export function MaintenanceModeBanner({
  assistantId,
  onExited,
}: MaintenanceModeBannerProps) {
  const [isExiting, setIsExiting] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);

  const handleResumeAssistant = async () => {
    if (isExiting) return;
    setIsExiting(true);
    setExitError(null);
    try {
      const { response } = await assistantsMaintenanceModeExitCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      if (response?.ok) {
        onExited();
      } else {
        setExitError("Failed to exit Recovery Mode. Please try again.");
      }
    } catch {
      setExitError("Failed to exit Recovery Mode. Please try again.");
    } finally {
      setIsExiting(false);
    }
  };

  return (
    <div
      className="flex flex-col items-center gap-3 rounded-t-[10px] bg-[var(--surface-active)] px-4 py-4"
      data-testid="maintenance-mode-banner"
    >
      <AlertTriangle
        className="h-5 w-5 shrink-0 text-[var(--system-mid-strong)]"
        aria-hidden="true"
      />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-body-small-emphasised text-[var(--content-emphasised)]">
          Assistant in Recovery Mode
        </p>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Your assistant workspace is currently connected to a debug terminal.
          Chat is unavailable while in Recovery Mode.
        </p>
        {exitError ? (
          <p className="mt-1 text-body-medium-default text-[var(--system-negative-strong)]">
            {exitError}
          </p>
        ) : null}
      </div>
      <Button
        variant="primary"
        size="compact"
        leftIcon={isExiting ? <Loader2 className="animate-spin" /> : undefined}
        onClick={() => void handleResumeAssistant()}
        disabled={isExiting}
        data-testid="resume-assistant-button"
      >
        Resume Assistant
      </Button>
    </div>
  );
}
