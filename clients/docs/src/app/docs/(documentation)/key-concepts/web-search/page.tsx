import { WebSearchContent } from "@/app/docs/_components/web-search-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Web Search - Vellum Docs",
  description:
    "How web search works in Vellum: managed vs bring your own, the four built-in providers (Provider Native, Perplexity, Brave, Tavily), the fallback chain, and how it's billed.",
  path: "/docs/key-concepts/web-search",
});

export default function WebSearchPage() {
  return <WebSearchContent />;
}
