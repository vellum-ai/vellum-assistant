import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { UsageTab } from "@/domains/logs/components/usage-tab";

export function UsagePage() {
  const assistantId = useActiveAssistantId();

  return <UsageTab assistantId={assistantId} />;
}
