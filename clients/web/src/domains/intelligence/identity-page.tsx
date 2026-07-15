import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { IdentityOverview } from "@/domains/intelligence/components/identity-overview";

interface IdentityPageProps {
  onOpenThread?: (message: string) => void;
}

export function IdentityPage({ onOpenThread }: IdentityPageProps) {
  const assistantId = useActiveAssistantId();

  return (
    <IdentityOverview assistantId={assistantId} onOpenThread={onOpenThread} />
  );
}
