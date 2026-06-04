import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";

import { restartAssistant } from "@/assistant/api";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

export function RestartAssistant({ assistantId }: { assistantId: string }) {
  const [restarting, setRestarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRestart = async () => {
    setConfirmOpen(false);
    setRestarting(true);
    try {
      const result = await restartAssistant(assistantId);
      if (result.ok) {
        toast.success("Assistant is restarting.");
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to restart assistant.";
        toast.error(detail);
      }
    } catch {
      toast.error("Failed to restart assistant.");
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <Button
        variant="outlined"
        leftIcon={
          restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />
        }
        onClick={() => setConfirmOpen(true)}
        disabled={restarting}
        className="shrink-0"
      >
        Restart
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title="Restart Assistant"
        message="Are you sure you want to restart this assistant? It will be briefly unavailable during the restart."
        confirmLabel="Restart"
        onConfirm={handleRestart}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
