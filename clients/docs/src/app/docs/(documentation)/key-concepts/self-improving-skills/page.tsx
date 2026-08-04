import { SelfImprovingSkillsContent } from "@/app/docs/_components/self-improving-skills-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Self-improving Skills - Vellum Docs",
  description:
    "See how your assistant turns procedures it has carried out into reusable skills that you can review, update, and remove.",
  path: "/docs/key-concepts/self-improving-skills",
});

export default function SelfImprovingSkillsPage() {
  return <SelfImprovingSkillsContent />;
}
