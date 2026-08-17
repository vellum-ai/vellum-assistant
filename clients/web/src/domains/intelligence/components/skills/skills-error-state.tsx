import { TriangleAlert } from "lucide-react";

import { useTranslation } from "@/i18n";

import { SkillsStateCard } from "./skills-state-card";

/** Error card shown when the skills list query fails. */
export function SkillsErrorState() {
  const { t } = useTranslation("intelligence");
  return (
    <SkillsStateCard
      icon={TriangleAlert}
      iconColor="var(--system-danger)"
      title={t("skillsErrorState.title")}
      subtitle={t("skillsErrorState.subtitle")}
    />
  );
}
