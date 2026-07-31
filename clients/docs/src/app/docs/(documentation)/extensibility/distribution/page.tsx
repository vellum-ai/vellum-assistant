import { ExtensibilityDistributionContent } from "@/app/docs/_components/extensibility-distribution-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Distribution - Vellum Docs",
  description:
    "How plugins ship: a curated marketplace catalog, installing by name from the CLI, installing directly from a GitHub URL (untrusted), the marketplace.json manifest, and why entries pin an immutable commit.",
  path: "/docs/extensibility/distribution",
});

export default function ExtensibilityDistributionPage() {
  return <ExtensibilityDistributionContent />;
}
