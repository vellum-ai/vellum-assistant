import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser";

export function WorkspacePage() {
  const { assistantId } = useActiveAssistantContext();
  return <WorkspaceBrowser assistantId={assistantId} />;
}
