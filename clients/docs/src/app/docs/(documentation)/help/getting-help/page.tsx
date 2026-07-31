import { HelpGettingHelpContent } from "@/app/docs/_components/help-getting-help-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Getting Help - Vellum Docs",
  description:
    "How to get help with Vellum — community, GitHub issues, email support, and what information to include.",
  path: "/docs/help/getting-help",
});

export default function HelpGettingHelpPage() {
  return <HelpGettingHelpContent />;
}
