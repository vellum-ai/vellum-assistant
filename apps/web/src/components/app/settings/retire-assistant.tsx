
import { Loader2, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useState } from "react";

import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { Button } from "@vellum/design-library/components/button";
import { retireAssistantById } from "@/lib/assistants/api.js";
import { clearOnboardingFlags } from "@/lib/onboarding/prefs.js";
import { routes } from "@/lib/routes.js";

interface RetireAssistantProps {
  assistantId: string;
}

/**
 * Action row for the "Retire Assistant" card. The surrounding SettingsCard
 * (variant="danger") provides the title, subtitle, and chrome.
 */
export function RetireAssistant({ assistantId }: RetireAssistantProps) {
  const navigate = useNavigate();
  const [retiring, setRetiring] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRetire = async () => {
    setConfirmOpen(false);
    setRetiring(true);
    try {
      const result = await retireAssistantById(assistantId);
      if (result.ok || result.status === 404) {
        // Retire wipes onboarding consent state so the user re-accepts
        // TOS + re-picks share prefs before the next hatch (macOS parity).
        clearOnboardingFlags();
        toast.success("Assistant retired successfully.");
        navigate(routes.onboarding.privacy);
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to retire assistant.";
        toast.error(detail);
      }
    } catch {
      toast.error("Failed to retire assistant.");
    } finally {
      setRetiring(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
        This action cannot be undone.
      </p>
      <Button
        variant="dangerOutline"
        leftIcon={retiring ? <Loader2 className="animate-spin" /> : <Trash2 />}
        onClick={() => setConfirmOpen(true)}
        disabled={retiring}
        className="shrink-0"
      >
        Retire Assistant
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title="Retire Assistant"
        message="Are you sure you want to retire this assistant? This action cannot be undone."
        confirmLabel="Retire"
        destructive
        onConfirm={handleRetire}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
