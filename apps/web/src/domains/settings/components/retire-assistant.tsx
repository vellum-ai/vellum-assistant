import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { retireAssistantById } from "@/assistant/api.js";
import { clearOnboardingFlags } from "@/domains/onboarding/prefs.js";
import { isNativePlatform } from "@/runtime/native-auth.js";
import { routes } from "@/utils/routes.js";

interface RetireAssistantProps {
  assistantId: string;
}

export function RetireAssistant({ assistantId }: RetireAssistantProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRetire = async () => {
    setConfirmOpen(false);
    try {
      const result = await retireAssistantById(assistantId);
      if (result.ok || result.status === 404) {
        clearOnboardingFlags();
        toast.success("Assistant retired.");
        // Native (iOS) re-onboarding skips the privacy/TOS step — those
        // are re-shown only when the user explicitly resets prefs.
        // Web users still see the privacy step to satisfy first-load
        // consent requirements on a fresh assistant.
        navigate(
          isNativePlatform()
            ? routes.onboarding.prechat
            : routes.onboarding.privacy,
        );
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to retire assistant.";
        toast.error(detail);
      }
    } catch {
      toast.error("Failed to retire assistant.");
    }
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
        onConfirm={handleRetire}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
