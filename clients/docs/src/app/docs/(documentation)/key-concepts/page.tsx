import { KeyConceptsContent } from "@/app/docs/_components/key-concepts-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Key Concepts - Vellum Docs",
  description:
    "Core Vellum concepts: workspace, skills and tools, memory and context, channels, assistant identity, and glossary.",
  path: "/docs/key-concepts",
});

export default function KeyConceptsPage() {
  return <KeyConceptsContent />;
}
