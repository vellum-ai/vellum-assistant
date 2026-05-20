import { useCurrentPlatformAssistant } from "@/domains/settings/hooks/use-current-platform-assistant.js";
import { LogsTab } from "@/domains/logs/components/logs-tab.js";

export function TracePage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <LogsTab assistantId={assistantId} />;
}
