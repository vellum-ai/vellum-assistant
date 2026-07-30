import { SkillsReferenceACPContent } from "@/app/docs/_components/skills-reference-acp-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "ACP - Vellum Docs",
  description:
    "ACP skill for Vellum: delegates development tasks through the Agent Client Protocol.",
  path: "/docs/skills-reference/acp",
});

export default function SkillsReferenceACPPage() {
  return <SkillsReferenceACPContent />;
}
