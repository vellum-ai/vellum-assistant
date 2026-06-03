import { Notice } from "@vellum/design-library/components/notice";
import { DetailCard } from "@/components/detail-card";
import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import { usePlatformGate } from "@/hooks/use-platform-gate";

export function AdvancedPage() {
  const { assistant } = useAssistantWithHealthz();
  const infraGate = usePlatformGate({ platformHostedOnly: true });
  const platformAssistant = assistant?.is_local ? null : assistant;

  return (
    <div className="mx-auto max-w-[940px] space-y-4">
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
