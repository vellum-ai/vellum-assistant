import { WebSearchYouContent } from "@/app/docs/_components/web-search-you-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "You.com - Web Search - Vellum Docs",
  description:
    "How to connect You.com as your web search provider in Vellum: keyless setup, optional API key, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/you",
});

export default function YouPage() {
  return <WebSearchYouContent />;
}
