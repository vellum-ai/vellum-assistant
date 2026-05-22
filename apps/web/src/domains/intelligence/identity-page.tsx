import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab.js";

export function IdentityPage() {
  const { assistantId } = useActiveAssistantContext();
  return <IdentityTab assistantId={assistantId} />;
}
