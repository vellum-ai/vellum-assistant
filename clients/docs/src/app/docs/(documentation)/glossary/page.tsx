import { GlossaryContent } from "@/app/docs/_components/glossary-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Glossary - Vellum Docs",
  description:
    "Vellum glossary — shared definitions for assistant, guardian, personal intelligence, memory, skills, channels, gateway, and other key terms.",
  path: "/docs/glossary",
});

export default function GlossaryPage() {
  return <GlossaryContent />;
}
