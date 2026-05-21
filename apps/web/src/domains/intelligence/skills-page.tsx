import { useSearchParams } from "react-router";

import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { SkillsTab } from "@/domains/intelligence/components/skills/skills-tab.js";

export function SkillsPage() {
  const { assistantId } = useAssistantContext();
  const [searchParams] = useSearchParams();
  const initialSkillId = searchParams.get("skill") ?? undefined;

  if (!assistantId) return null;

  return <SkillsTab assistantId={assistantId} initialSkillId={initialSkillId} />;
}
