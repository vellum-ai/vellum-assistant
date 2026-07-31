import { DeveloperGuideWorkflowContent } from "@/app/docs/_components/developer-guide-workflow-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Development Workflow - Developer Guide - Vellum Docs",
  description:
    "Claude Code slash commands, parallel PR execution, automated review loops, and the release pipeline.",
  path: "/docs/developer-guide/development-workflow",
});

export default function DeveloperGuideWorkflowPage() {
  return <DeveloperGuideWorkflowContent />;
}
