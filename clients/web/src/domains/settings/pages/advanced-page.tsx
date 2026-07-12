import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import { MemoryWorkerToggle } from "@/domains/settings/components/memory-worker-toggle";
import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function AdvancedPage() {
  const { assistant, healthz } = useAssistantWithHealthz();
  const infraGate = usePlatformGate({ platformHostedOnly: true });
  const platformAssistant = assistant?.is_local ? null : assistant;
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
      {infraGate === "full" && platformAssistant && (
        <DetailCard
          title="Update Window"
          subtitle="Configure when automatic updates are applied."
        >
          <UpdateWindowPolicy assistantId={platformAssistant.id} />
        </DetailCard>
      )}
      {infraGate === "disabled" && (
        <DetailCard
          title="Update Window"
          subtitle="Configure when automatic updates are applied."
        >
          <PlatformLoginNotice>
            Log in to the Vellum platform to manage update window policy.
          </PlatformLoginNotice>
        </DetailCard>
      )}
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
