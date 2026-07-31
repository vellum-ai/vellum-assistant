import { SkillsReferenceGmailContent } from "@/app/docs/_components/skills-reference-gmail-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Gmail - Vellum Docs",
  description:
    "Gmail skill for Vellum: full inbox management including archive, label, draft, send, and filter capabilities.",
  path: "/docs/skills-reference/gmail",
});

export default function SkillsReferenceGmailPage() {
  return <SkillsReferenceGmailContent />;
}
