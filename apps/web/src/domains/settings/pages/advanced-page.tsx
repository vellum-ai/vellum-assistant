import { DetailCard } from "@/components/detail-card.js";
import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy.js";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel.js";

export function AdvancedPage() {
  const { assistant } = useAssistantWithHealthz();
  const platformAssistant = assistant?.is_local ? null : assistant;

  return (
    <div className="max-w-[940px] space-y-4">
      {platformAssistant && (
        <DetailCard
          title="Update Window"
          subtitle="Configure when automatic updates are applied."
        >
          <UpdateWindowPolicy assistantId={platformAssistant.id} />
        </DetailCard>
      )}
    </div>
  );
}
