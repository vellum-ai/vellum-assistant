import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import { SystemEventsTab } from "@/domains/logs/components/system-events-tab";

export function SystemEventsPage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <SystemEventsTab assistantId={assistantId} />;
}
