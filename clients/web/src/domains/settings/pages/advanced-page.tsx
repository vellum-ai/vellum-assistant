import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import { MemoryWorkerToggle } from "@/domains/settings/components/memory-worker-toggle";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function AdvancedPage() {
  const { healthz } = useAssistantWithHealthz();
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const showMemoryOptOut = healthz?.capabilities?.memoryOptOut === true;

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
    enabled: showMemoryOptOut,
  });

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });
  const memoryEnabled = config?.memory?.enabled !== false;

  const handleMemoryToggle = async (enabled: boolean) => {
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { memory: { enabled } },
      });
      toast.success(enabled ? "Memory enabled." : "Memory disabled.");
    } catch (error) {
      captureError(error, { context: "settings-memory-toggle" });
      toast.error("Failed to update memory setting.");
    }
  };

  return (
    <div className="space-y-4">
      {showMemoryOptOut ? (
        <DetailCard
          title="Memory"
          subtitle="Let your assistant remember information from past conversations. Turning this off also pauses memory consolidation."
          accessory={
            <Toggle
              checked={memoryEnabled}
              onChange={(enabled) => void handleMemoryToggle(enabled)}
              aria-label="Enable memory"
              disabled={configMutation.isPending}
            />
          }
          compactAccessory
        >
          <MemoryWorkerToggle memoryEnabled={memoryEnabled} />
        </DetailCard>
      ) : null}
    </div>
  );
}
