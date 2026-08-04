import { WebSearchPerplexityContent } from "@/app/docs/_components/web-search-perplexity-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Perplexity - Web Search - Vellum Docs",
  description:
    "How to connect Perplexity as your web search provider in Vellum: API key setup, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/perplexity",
});

export default function PerplexityPage() {
  return <WebSearchPerplexityContent />;
}
