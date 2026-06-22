import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab";

interface IdentityPageProps {
  onOpenThread?: (message: string) => void;
}

export function IdentityPage({ onOpenThread }: IdentityPageProps) {
  const assistantId = useActiveAssistantId();

  return <IdentityTab assistantId={assistantId} onOpenThread={onOpenThread} />;
}
