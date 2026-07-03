import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  memoryWorkerStatusGetOptions,
  memoryWorkerStatusGetSetQueryData,
  useMemoryWorkerStartPostMutation,
  useMemoryWorkerStopPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
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
 * worker. Enabling it spawns a dedicated worker process to drain the memory job
 * queue; disabling it hands the queue back to the daemon's synchronous
 * in-process runner.
 *
 * The status query gates the row's visibility: assistants whose daemon predates
 * the worker control routes return no status, so the row stays hidden rather
 * than offering a toggle the daemon can't honor.
 */
export function MemoryWorkerToggle({ memoryEnabled }: MemoryWorkerToggleProps) {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    ...memoryWorkerStatusGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  // Optimistically reflect the new state in the status cache so the toggle
  // settles immediately; the next status fetch reconciles against the daemon.
  const setWorkerEnabled = (enabled: boolean) => {
    memoryWorkerStatusGetSetQueryData(
      queryClient,
      { path: { assistant_id: assistantId } },
      (old) => (old ? { ...old, workerEnabled: enabled } : old),
    );
  };

  const startMutation = useMemoryWorkerStartPostMutation({
    onSuccess: () => setWorkerEnabled(true),
  });
  const stopMutation = useMemoryWorkerStopPostMutation({
    onSuccess: () => setWorkerEnabled(false),
  });

  const handleWorkerToggle = async (enabled: boolean) => {
    try {
      if (enabled) {
        await startMutation.mutateAsync({
          path: { assistant_id: assistantId },
        });
        toast.success("Background worker enabled.");
      } else {
        await stopMutation.mutateAsync({
          path: { assistant_id: assistantId },
        });
        toast.success("Background worker disabled.");
      }
    } catch (error) {
      captureError(error, { context: "settings-memory-worker-toggle" });
      toast.error("Failed to update background worker setting.");
    }
  };

  if (!status) return null;

  const isPending = startMutation.isPending || stopMutation.isPending;

  return (
    <div className="flex flex-row items-start justify-between gap-4 border-t border-[var(--border-subtle)] pt-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
          Background worker
        </h3>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Run memory consolidation in a dedicated background process instead of
          inline. Recommended for heavier memory workloads.
        </p>
      </div>
      <Toggle
        checked={status.workerEnabled === true}
        onChange={(enabled) => void handleWorkerToggle(enabled)}
        aria-label="Enable background memory worker"
        disabled={!memoryEnabled || isPending}
      />
    </div>
  );
}
