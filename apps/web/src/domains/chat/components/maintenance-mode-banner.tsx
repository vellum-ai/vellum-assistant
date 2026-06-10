
import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";

import { assistantsMaintenanceModeExitCreate } from "@/generated/api/sdk.gen";
import { useRegisterMaintenanceSurface } from "@/components/maintenance-surface-store";
import {
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { Button } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";

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
  // Self-hosted assistants don't run platform-managed Recovery Mode, so the
  // banner has nothing to act on — `platformHostedOnly: true` flips "gated"
  // for the platform-mode-app-pointed-at-self-hosted case too (the standard
  // gate would still resolve to "full" there and leak the platform-routed
  // exit mutation onto a self-hosted target).
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // `ChatPage` is NOT mounted under `<ActiveAssistantGate>` (see routes.tsx
  // — chat owns its own lifecycle UI), so the banner can render while
  // lifecycle is still `{ kind: "loading" }`. The gate intentionally
  // returns "full" during that window; pair with the lifecycle-loading
  // signal so the exit-mutation button stays disabled until lifecycle has
  // landed a resolution. Already-resolved non-hosted lifecycle kinds
  // (`retired`, `error`, etc.) don't reach this banner — the parent only
  // mounts it when `maintenanceMode != null` — so the narrow predicate
  // catches exactly the deep-link race we care about.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  // Tell StatusBanner this card is actually on screen so it drops its
  // own operational maintenance notice instead of stacking a second one.
  useRegisterMaintenanceSurface(platformGate !== "gated");

  if (platformGate === "gated") return null;

  const isResolving = platformGate === "full" && isLifecycleLoading;

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
      {platformGate === "disabled" ? (
        <Notice tone="info">
          Log in to the Vellum platform to exit Recovery Mode.
        </Notice>
      ) : (
        <Button
          variant="primary"
          size="compact"
          leftIcon={
            isExiting || isResolving ? (
              <Loader2 className="animate-spin" />
            ) : undefined
          }
          onClick={() => void handleResumeAssistant()}
          disabled={isExiting || isResolving}
          data-testid="resume-assistant-button"
        >
          Resume Assistant
        </Button>
      )}
    </div>
  );
}
