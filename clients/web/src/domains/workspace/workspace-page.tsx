import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser";

export function WorkspacePage() {
  const assistantId = useActiveAssistantId();
  return <WorkspaceBrowser assistantId={assistantId} />;
}
