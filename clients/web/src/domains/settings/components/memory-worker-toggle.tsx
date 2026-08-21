import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  memoryWorkerStatusGetOptions,
  memoryWorkerStatusGetSetQueryData,
  useMemoryWorkerStartPostMutation,
  useMemoryWorkerStopPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export interface MemoryWorkerToggleProps {
  /**
   * Whether long-term memory is enabled. The background worker only drains the
   * memory job queue while memory is on, so its toggle is disabled when memory
   * is off (turning memory off already pauses consolidation).
   */
  memoryEnabled: boolean;
}

/**
 * Sub-row of the Memory settings card that controls the out-of-process memory
 * worker. The worker is spun up by default; this row lets you stop it (SIGTERM)
 * or respawn it. The toggle reflects the worker process's live liveness — the
 * daemon respawns it on the next restart, so this is a transient process
 * control, not a persisted setting.
 *
 * The status query gates the row's visibility: assistants whose daemon predates
 * the worker control routes return no status, so the row stays hidden rather
 * than offering a toggle the daemon can't honor.
 */
export function MemoryWorkerToggle({ memoryEnabled }: MemoryWorkerToggleProps) {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    ...memoryWorkerStatusGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  // Optimistically reflect the new state in the status cache so the toggle
  // settles immediately; the next status fetch reconciles against the daemon.
  const setWorkerRunning = (running: boolean) => {
    memoryWorkerStatusGetSetQueryData(
      queryClient,
      { path: { assistant_id: assistantId } },
      (old) =>
        old ? { ...old, status: running ? "running" : "not_running" } : old,
    );
  };

  const startMutation = useMemoryWorkerStartPostMutation({
    onSuccess: () => setWorkerRunning(true),
  });
  const stopMutation = useMemoryWorkerStopPostMutation({
    onSuccess: () => setWorkerRunning(false),
  });

  const handleWorkerToggle = async (enabled: boolean) => {
    try {
      if (enabled) {
        await startMutation.mutateAsync({
          path: { assistant_id: assistantId },
        });
        toast.success(t("memoryWorkerToggle.toastStarted"));
      } else {
        await stopMutation.mutateAsync({
          path: { assistant_id: assistantId },
        });
        toast.success(t("memoryWorkerToggle.toastStopped"));
      }
    } catch (error) {
      captureError(error, { context: "settings-memory-worker-toggle" });
      toast.error(t("memoryWorkerToggle.toastFailed"));
    }
  };

  if (!status) {
    return null;
  }

  const isPending = startMutation.isPending || stopMutation.isPending;

  return (
    <div className="flex flex-row items-start justify-between gap-4 border-t border-[var(--border-subtle)] pt-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
          {t("memoryWorkerToggle.title")}
        </h3>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {t("memoryWorkerToggle.description")}
        </p>
      </div>
      <Toggle
        checked={status.status === "running"}
        onChange={(enabled) => void handleWorkerToggle(enabled)}
        aria-label={t("memoryWorkerToggle.ariaLabel")}
        disabled={!memoryEnabled || isPending}
      />
    </div>
  );
}
