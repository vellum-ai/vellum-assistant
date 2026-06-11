import { DetailCard } from "@/components/detail-card";
import {
  useDaemonConfigMutation,
  useDaemonConfigQuery,
} from "@/domains/settings/ai/use-daemon-config";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function AdvancedPage() {
  const { assistant, healthz } = useAssistantWithHealthz();
  const infraGate = usePlatformGate({ platformHostedOnly: true });
  const platformAssistant = assistant?.is_local ? null : assistant;
  const showMemoryOptOut = healthz?.capabilities?.memoryOptOut === true;
  const { config } = useDaemonConfigQuery({ enabled: showMemoryOptOut });
  const configMutation = useDaemonConfigMutation();
  const memoryEnabled = config?.memory?.enabled !== false;

  const handleMemoryToggle = async (enabled: boolean) => {
    try {
      await configMutation.mutateAsync({ memory: { enabled } });
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
          <Notice tone="info">
            Log in to the Vellum platform to manage update window policy.
          </Notice>
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
        />
      ) : null}
    </div>
  );
}
