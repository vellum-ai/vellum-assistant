import { SkillsReferenceContactsContent } from "@/app/docs/_components/skills-reference-contacts-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Contacts - Vellum Docs",
  description:
    "Contacts skill for Vellum — manage contacts, communication channels, access control, and invite links.",
  path: "/docs/skills-reference/contacts",
});

export default function SkillsReferenceContactsPage() {
  return <SkillsReferenceContactsContent />;
}
