import { WebSearchSpecstreamContent } from "@/app/docs/_components/web-search-specstream-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "SpecStream - Web Search - Vellum Docs",
  description:
    "How to connect SpecStream as your web search provider in Vellum: API key setup, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/specstream",
});

export default function SpecstreamPage() {
  return <WebSearchSpecstreamContent />;
}
