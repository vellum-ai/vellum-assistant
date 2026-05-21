import { useActiveAssistantContext } from "@/domains/chat/active-assistant-gate.js";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab.js";

export function IdentityPage() {
  const { assistantId } = useActiveAssistantContext();
  return <IdentityTab assistantId={assistantId} />;
}
