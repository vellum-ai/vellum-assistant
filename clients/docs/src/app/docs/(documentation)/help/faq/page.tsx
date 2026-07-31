import { HelpFaqContent } from "@/app/docs/_components/help-faq-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "FAQ - Vellum Docs",
  description:
    "Frequently asked questions about Vellum: product capabilities, privacy, data handling, and your assistant.",
  path: "/docs/help/faq",
});

export default function HelpFaqPage() {
  return <HelpFaqContent />;
}
