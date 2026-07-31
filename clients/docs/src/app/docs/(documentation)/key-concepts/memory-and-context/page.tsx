import { MemoryAndContextContent } from "@/app/docs/_components/memory-and-context-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Memory & Context - Vellum Docs",
  description:
    "How Vellum remembers: workspace files, long-term memory, procedural memory as skills, the injection gate, context assembly, and privacy considerations.",
  path: "/docs/key-concepts/memory-and-context",
});

export default function MemoryAndContextPage() {
  return <MemoryAndContextContent />;
}
