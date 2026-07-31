import { SkillsReferenceContent } from "@/app/docs/_components/skills-reference-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Skills Reference - Vellum Docs",
  description:
    "Vellum skills reference: documentation for all available skills, capabilities, and configuration options.",
  path: "/docs/skills-reference",
});

export default function SkillsReferencePage() {
  return <SkillsReferenceContent />;
}
