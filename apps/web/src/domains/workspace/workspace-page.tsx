import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { WorkspaceBrowser } from "@/domains/workspace/components/workspace-browser.js";

export function WorkspacePage() {
  const { assistantId } = useAssistantContext();
  if (!assistantId) return null;
  return (
    <div className="h-full overflow-y-auto p-6">
      <WorkspaceBrowser assistantId={assistantId} />
    </div>
  );
}
