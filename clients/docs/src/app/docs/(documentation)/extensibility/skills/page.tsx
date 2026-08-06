import { ExtensibilitySkillsContent } from "@/app/docs/_components/extensibility-skills-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Skills - Vellum Docs",
  description:
    "Skills let a plugin bundle instructions, assets, and scripts the Assistant loads on demand when a conversation matches what the skill is for.",
  path: "/docs/extensibility/skills",
});

export default function ExtensibilitySkillsPage() {
  return <ExtensibilitySkillsContent />;
}
