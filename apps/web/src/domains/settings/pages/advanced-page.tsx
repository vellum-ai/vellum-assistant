import { DetailCard } from "@/components/detail-card";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { Notice } from "@vellumai/design-library/components/notice";

export function AdvancedPage() {
  const { assistant } = useAssistantWithHealthz();
  const infraGate = usePlatformGate({ platformHostedOnly: true });
  const platformAssistant = assistant?.is_local ? null : assistant;

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
    </div>
  );
}
