import { useCurrentPlatformAssistant } from "@/domains/settings/hooks/use-current-platform-assistant.js";
import { UsageTab } from "@/domains/logs/components/usage-tab.js";

export function UsagePage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <UsageTab assistantId={assistantId} />;
}
