import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser.js";

export function WorkspacePage() {
  const { assistantId } = useAssistantContext();
  if (!assistantId) return null;
  return <WorkspaceBrowser assistantId={assistantId} />;
}
