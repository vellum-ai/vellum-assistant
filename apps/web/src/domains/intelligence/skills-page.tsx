import { useActiveAssistantContext } from "@/domains/chat/active-assistant-gate.js";
import { SkillsTab } from "@/domains/intelligence/components/skills/skills-tab.js";

export function SkillsPage() {
  const { assistantId } = useActiveAssistantContext();
  return <SkillsTab assistantId={assistantId} />;
}
