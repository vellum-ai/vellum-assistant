import { SkillsReferenceSkillManagementContent } from "@/app/docs/_components/skills-reference-skill-management-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Skill Management - Vellum Docs",
  description:
    "Skill Management skill for Vellum — creates and deletes custom managed skills to extend your assistant.",
  path: "/docs/skills-reference/skill-management",
});

export default function SkillsReferenceSkillManagementPage() {
  return <SkillsReferenceSkillManagementContent />;
}
