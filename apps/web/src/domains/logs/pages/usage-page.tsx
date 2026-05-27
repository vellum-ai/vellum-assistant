import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import { UsageTab } from "@/domains/logs/components/usage-tab";

export function UsagePage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <UsageTab assistantId={assistantId} />;
}
