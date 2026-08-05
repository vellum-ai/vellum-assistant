import { SkillsReferenceAppBuilderContent } from "@/app/docs/_components/skills-reference-app-builder-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "App Builder - Vellum Docs",
  description:
    "App Builder skill for Vellum — create interactive web apps with HTML, CSS, and JavaScript through conversation.",
  path: "/docs/skills-reference/app-builder",
});

export default function SkillsReferenceAppBuilderPage() {
  return <SkillsReferenceAppBuilderContent />;
}
