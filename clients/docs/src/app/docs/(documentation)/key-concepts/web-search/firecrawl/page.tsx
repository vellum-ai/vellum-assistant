import { WebSearchFirecrawlContent } from "@/app/docs/_components/web-search-firecrawl-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Firecrawl - Web Search - Vellum Docs",
  description:
    "How to connect Firecrawl as your web search and web fetch provider in Vellum: API key setup, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/firecrawl",
});

export default function FirecrawlPage() {
  return <WebSearchFirecrawlContent />;
}
