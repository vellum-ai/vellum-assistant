import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { IdentityOverview } from "@/domains/intelligence/components/identity-overview";

export function IdentityPage() {
  const assistantId = useActiveAssistantId();

  return <IdentityOverview assistantId={assistantId} />;
}
