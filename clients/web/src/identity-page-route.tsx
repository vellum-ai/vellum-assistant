import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { IdentityPage } from "@/domains/intelligence/identity-page";

export function IdentityPageRoute() {
  const assistantId = useActiveAssistantId();

  return <IdentityPage key={assistantId} />;
}
