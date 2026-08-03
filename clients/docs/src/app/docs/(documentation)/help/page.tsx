import { HelpContent } from "@/app/docs/_components/help-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Help - Vellum Docs",
  description:
    "Get help with Vellum — frequently asked questions, common issues, and support channels.",
  path: "/docs/help",
});

export default function HelpPage() {
  return <HelpContent />;
}
