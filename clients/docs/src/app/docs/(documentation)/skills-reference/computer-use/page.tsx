import { SkillsReferenceComputerUseContent } from "@/app/docs/_components/skills-reference-computer-use-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Computer Use - Vellum Docs",
  description:
    "Computer Use skill for Vellum: control supported apps on macOS and Windows with screen observation, clicking, and typing.",
  path: "/docs/skills-reference/computer-use",
});

export default function SkillsReferenceComputerUsePage() {
  return <SkillsReferenceComputerUseContent />;
}
