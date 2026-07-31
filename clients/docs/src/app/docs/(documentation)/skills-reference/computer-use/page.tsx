import { SkillsReferenceComputerUseContent } from "@/app/docs/_components/skills-reference-computer-use-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Computer Use - Vellum Docs",
  description:
    "Computer Use skill for Vellum: control your Mac directly with screen observation, clicking, typing, and AppleScript.",
  path: "/docs/skills-reference/computer-use",
});

export default function SkillsReferenceComputerUsePage() {
  return <SkillsReferenceComputerUseContent />;
}
