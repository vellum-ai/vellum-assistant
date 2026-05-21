import { useActiveAssistantContext } from "@/domains/chat/active-assistant-gate.js";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser.js";

export function WorkspacePage() {
  const { assistantId } = useActiveAssistantContext();
  return <WorkspaceBrowser assistantId={assistantId} />;
}
