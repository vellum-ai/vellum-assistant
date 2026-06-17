import { useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SkillsTab } from "@/domains/intelligence/components/skills/skills-tab";

export function SkillsPage() {
  const assistantId = useActiveAssistantId();
  const [searchParams] = useSearchParams();
  const initialSkillId = searchParams.get("skill") ?? undefined;

  return <SkillsTab assistantId={assistantId} initialSkillId={initialSkillId} />;
}
