import { useSearchParams } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate";
import { SkillsTab } from "@/domains/intelligence/components/skills/skills-tab";

export function SkillsPage() {
  const { assistantId } = useActiveAssistantContext();
  const [searchParams] = useSearchParams();
  const initialSkillId = searchParams.get("skill") ?? undefined;

  return <SkillsTab assistantId={assistantId} initialSkillId={initialSkillId} />;
}
