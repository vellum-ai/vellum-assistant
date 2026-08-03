import { MemoryAndContextContent } from "@/app/docs/_components/memory-and-context-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Memory & Context - Vellum Docs",
  description:
    "How Memory v3 captures, organizes, connects, and recalls useful knowledge across conversations, plus the controls for creating and refining memories.",
  path: "/docs/key-concepts/memory-and-context",
});

export default function MemoryAndContextPage() {
  return <MemoryAndContextContent />;
}
