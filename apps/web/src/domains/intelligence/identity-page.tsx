import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab.js";

export function IdentityPage() {
  const { assistantId } = useAssistantContext();
  if (!assistantId) return null;
  return <IdentityTab assistantId={assistantId} />;
}
