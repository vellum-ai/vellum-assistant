import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { LogsTab } from "@/domains/logs/components/logs-tab";

export function TracePage() {
  const assistantId = useActiveAssistantId();

  return <LogsTab assistantId={assistantId} />;
}
