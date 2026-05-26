import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab.js";

interface IdentityPageProps {
  onOpenThread?: (message: string) => void;
}

export function IdentityPage({ onOpenThread }: IdentityPageProps) {
  const { assistantId } = useActiveAssistantContext();

  return <IdentityTab assistantId={assistantId} onOpenThread={onOpenThread} />;
}
