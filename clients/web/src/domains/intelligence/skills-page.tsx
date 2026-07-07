import { Navigate, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SkillsTab } from "@/domains/intelligence/components/skills/skills-tab";
import { routes } from "@/utils/routes";

export function SkillsPage() {
  const assistantId = useActiveAssistantId();
  const [searchParams] = useSearchParams();

  // Back-compat: `?skill=<id>` deep-links resolve to the dedicated detail
  // route so existing bookmarks keep working.
  const skillId = searchParams.get("skill");
  if (skillId) {
    return <Navigate to={routes.skills.detail(skillId)} replace />;
  }

  return <SkillsTab assistantId={assistantId} />;
}
