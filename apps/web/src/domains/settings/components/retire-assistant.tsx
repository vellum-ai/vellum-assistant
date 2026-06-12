import { useState } from "react";
import { useNavigate } from "react-router";

import { retireAssistant } from "@/assistant/retire-service";
import { Button } from "@vellumai/design-library/components/button";
import { RetireConfirmDialog } from "@/components/retire-confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

interface RetireAssistantProps {
  assistantId: string;
}

export function RetireAssistant({ assistantId }: RetireAssistantProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const handleRetire = async () => {
    setIsPending(true);
    const outcome = await retireAssistant(assistantId);
    if (outcome.ok) {
      setConfirmOpen(false);
      navigate(outcome.nextRoute, { replace: true });
      return;
    }
    toast.error(outcome.error);
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
      <RetireConfirmDialog
        open={confirmOpen}
        isPending={isPending}
        onConfirm={handleRetire}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
