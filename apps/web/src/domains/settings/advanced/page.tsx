
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { UpdateWindowPolicy } from "@/components/app/settings/update-window-policy.js";
import { useAssistantWithHealthz } from "@/components/app/settings/panels/assistant-status-panel.js";

export default function AdvancedSettingsPage() {
  const { assistant } = useAssistantWithHealthz();
  const platformAssistant = assistant?.is_local ? null : assistant;

  return (
    <div className="max-w-[940px] space-y-4">
      {platformAssistant && (
        <SettingsCard
          title="Update Window"
          subtitle="Configure when automatic updates are applied."
        >
          <UpdateWindowPolicy assistantId={platformAssistant.id} />
        </SettingsCard>
      )}
    </div>
  );
}
