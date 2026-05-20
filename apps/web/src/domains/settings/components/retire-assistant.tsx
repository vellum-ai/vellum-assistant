import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { retireAssistantById } from "@/domains/assistant/api.js";
import { clearOnboardingFlags } from "@/domains/onboarding/prefs.js";

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
        navigate("/assistant/onboarding/privacy");
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
