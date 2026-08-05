import { HomepageContent } from "@/app/docs/_components/homepage-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Homepage - Vellum Docs",
  description:
    "Vellum documentation — guides, tutorials, and references for building your personal AI assistant.",
  path: "/docs",
});

export default function DocsPage() {
  return <HomepageContent />;
}
