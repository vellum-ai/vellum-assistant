import { DeveloperGuideFeaturesContent } from "@/app/docs/_components/developer-guide-features-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Features & Capabilities - Developer Guide - Vellum Docs",
  description:
    "Integrations, dynamic skill authoring, browser automation, attachments, and media embeds.",
  path: "/docs/developer-guide/features",
});

export default function DeveloperGuideFeaturesPage() {
  return <DeveloperGuideFeaturesContent />;
}
