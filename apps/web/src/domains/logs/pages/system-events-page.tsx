import { useCurrentPlatformAssistant } from "@/domains/settings/hooks/use-current-platform-assistant.js";
import { SystemEventsTab } from "@/domains/logs/components/system-events-tab.js";

export function SystemEventsPage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <SystemEventsTab assistantId={assistantId} />;
}
