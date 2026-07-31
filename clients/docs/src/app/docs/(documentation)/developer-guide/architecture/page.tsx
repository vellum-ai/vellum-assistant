import { DeveloperGuideArchitectureContent } from "@/app/docs/_components/developer-guide-architecture-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Architecture - Developer Guide - Vellum Docs",
  description:
    "Platform domains, repository structure, and how the runtime, clients, and gateway fit together.",
  path: "/docs/developer-guide/architecture",
});

export default function DeveloperGuideArchitecturePage() {
  return <DeveloperGuideArchitectureContent />;
}
