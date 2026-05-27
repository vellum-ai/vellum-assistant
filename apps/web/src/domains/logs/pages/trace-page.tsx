import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import { LogsTab } from "@/domains/logs/components/logs-tab";

export function TracePage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <LogsTab assistantId={assistantId} />;
}
