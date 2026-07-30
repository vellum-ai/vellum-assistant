import { GettingStartedOverviewContent } from "@/app/docs/_components/getting-started-overview-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Getting Started - Vellum Docs",
  description:
    "Get started with Vellum: installation, key concepts, quick start guide, and your first skill tutorial.",
  path: "/docs/getting-started",
});

export default function GettingStartedPage() {
  return <GettingStartedOverviewContent />;
}
