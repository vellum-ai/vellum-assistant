import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { listAssistants, retireAssistantById } from "@/assistant/api";
import { clearOnboardingFlags } from "@/utils/onboarding-cleanup";
import {
  isLocalMode,
  getSelectedAssistant,
  isLocalAssistant,
  retireLocalAssistant,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import { isNativePlatform } from "@/runtime/native-auth";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { routes } from "@/utils/routes";

async function getPostRetireRoute(): Promise<string> {
  if (isNativePlatform()) return routes.onboarding.prechat;
  const decision = resolveNavigation(
    buildNavigationState(),
    { kind: "route-guard", pathname: routes.assistant },
  );
  return decision.action === "redirect" ? decision.to : routes.onboarding.privacy;
}

interface RetireAssistantProps {
  assistantId: string;
}

export function RetireAssistant({ assistantId }: RetireAssistantProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const handleRetire = async () => {
    setIsPending(true);
    try {
      const selected = getSelectedAssistant();
      const useLocal =
        isLocalMode() && selected && isLocalAssistant(selected);

      if (useLocal) {
        const result = await retireLocalAssistant(assistantId);
        if (result.ok) {
          clearOnboardingFlags();
          setConfirmOpen(false);
          toast.success("Assistant retired.");
          navigate(await getPostRetireRoute(), { replace: true });
          return;
        } else {
          toast.error(result.error || "Failed to retire assistant.");
        }
      } else {
        const result = await retireAssistantById(assistantId);
        if (result.ok || result.status === 404) {
          if (isLocalMode()) {
            try {
              const remaining = await listAssistants();
              if (remaining.ok) {
                await syncPlatformAssistantsToLockfile(remaining.data);
              }
            } catch {
              // Best-effort sync
            }
          }
          clearOnboardingFlags();
          setConfirmOpen(false);
          toast.success("Assistant retired.");
          navigate(await getPostRetireRoute(), { replace: true });
          return;
        } else {
          const detail =
            typeof result.error?.detail === "string"
              ? result.error.detail
              : "Failed to retire assistant.";
          toast.error(detail);
        }
      }
    } catch {
      toast.error("Failed to retire assistant.");
    }
    setIsPending(false);
    setConfirmOpen(false);
  };

  return (
    <>
      <Button
        variant="dangerOutline"
        onClick={() => setConfirmOpen(true)}
        className="shrink-0"
      >
        Retire Assistant
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title="Retire Assistant"
        message="This will permanently retire this assistant and all of its data. You will need to go through the onboarding flow again to create a new one. This action cannot be undone."
        confirmLabel="Retire"
        destructive
        isPending={isPending}
        onConfirm={handleRetire}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
