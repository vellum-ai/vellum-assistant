import { ExtensibilityOverviewContent } from "@/app/docs/_components/extensibility-overview-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Extensibility - Vellum Docs",
  description:
    "All of the ways your Assistant can build on themselves. Overview of the surfaces a plugin can bundle and how they compose.",
  path: "/docs/extensibility",
});

export default function ExtensibilityPage() {
  return <ExtensibilityOverviewContent />;
}
