import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";

import { restartAssistant } from "@/assistant/api";
import { isCliWakeableAssistant } from "@/lib/local-mode";
import {
  isLocalModeHostAvailable,
  sleepLocalAssistantHost,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

async function restartLocalAssistant(
  assistantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const sleepResult = await sleepLocalAssistantHost(assistantId);
  if (!sleepResult.ok) {
    return { ok: false, error: sleepResult.error ?? "Failed to stop assistant." };
  }
  const wakeResult = await wakeLocalAssistantHost(assistantId);
  if (!wakeResult.ok) {
    return { ok: false, error: wakeResult.error ?? "Failed to start assistant." };
  }
  return { ok: true };
}

export function RestartAssistant({
  assistantId,
  isLocal,
}: {
  assistantId: string;
  isLocal: boolean;
}) {
  const [restarting, setRestarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRestart = async () => {
    setConfirmOpen(false);
    setRestarting(true);
    try {
      // A platform-hosted assistant (`is_local === false`) is always restarted
      // through the platform API — running the local CLI sleep/wake against it
      // would target a non-existent on-machine assistant. The CLI path is only
      // taken for a local-kind assistant when a host is present to run it and
      // wake operates on it. Mirrors the web-UI restart behavior.
      const isCli =
        isLocal &&
        isLocalModeHostAvailable() &&
        isCliWakeableAssistant(assistantId);

      if (isCli) {
        const result = await restartLocalAssistant(assistantId);
        if (result.ok) {
          toast.success("Assistant is restarting.");
        } else {
          toast.error(result.error ?? "Failed to restart assistant.");
        }
      } else {
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
