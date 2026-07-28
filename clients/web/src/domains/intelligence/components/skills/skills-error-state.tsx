import { TriangleAlert } from "lucide-react";

import { SkillsStateCard } from "./skills-state-card";

/** Error card shown when the skills list query fails. */
export function SkillsErrorState() {
  return (
    <SkillsStateCard
      icon={TriangleAlert}
      iconColor="var(--system-danger)"
      title="Failed to load skills"
      subtitle="Something went wrong. Try refreshing the page."
    />
  );
}
