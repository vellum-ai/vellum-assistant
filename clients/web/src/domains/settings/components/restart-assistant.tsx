import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";

import { restartAssistant } from "@/assistant/api";
import { useTranslation } from "@/i18n";
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
  failStop: string,
  failStart: string,
): Promise<{ ok: boolean; error?: string }> {
  const sleepResult = await sleepLocalAssistantHost(assistantId);
  if (!sleepResult.ok) {
    return {
      ok: false,
      error: sleepResult.error ?? failStop,
    };
  }
  const wakeResult = await wakeLocalAssistantHost(assistantId);
  if (!wakeResult.ok) {
    return {
      ok: false,
      error: wakeResult.error ?? failStart,
    };
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
  const { t } = useTranslation("settings");
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
        const result = await restartLocalAssistant(
          assistantId,
          t("restartAssistant.failStop"),
          t("restartAssistant.failStart"),
        );
        if (result.ok) {
          toast.success(t("restartAssistant.toastRestarting"));
        } else {
          toast.error(result.error ?? t("restartAssistant.toastFailed"));
        }
      } else {
        const result = await restartAssistant(assistantId);
        if (result.ok) {
          toast.success(t("restartAssistant.toastRestarting"));
        } else {
          const detail =
            typeof result.error?.detail === "string"
              ? result.error.detail
              : t("restartAssistant.toastFailed");
          toast.error(detail);
        }
      }
    } catch {
      toast.error(t("restartAssistant.toastFailed"));
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
        {t("restartAssistant.button")}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title={t("restartAssistant.confirmTitle")}
        message={t("restartAssistant.confirmMessage")}
        confirmLabel={t("restartAssistant.confirmLabel")}
        onConfirm={handleRestart}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
