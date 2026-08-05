import { SkillsReferenceBrowserContent } from "@/app/docs/_components/skills-reference-browser-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Browser - Vellum Docs",
  description:
    "Browser skill for Vellum — navigate web pages, interact with content, and extract information.",
  path: "/docs/skills-reference/browser",
});

export default function SkillsReferenceBrowserPage() {
  return <SkillsReferenceBrowserContent />;
}
