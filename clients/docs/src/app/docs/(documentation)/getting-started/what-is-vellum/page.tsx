import { WhatIsVellumContent } from "@/app/docs/_components/what-is-vellum-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "What is Vellum? - Vellum Docs",
  description:
    "What is Vellum? A personal AI assistant with tools, memory, identity, and a private cloud workspace, different from ChatGPT or Claude.",
  path: "/docs/getting-started/what-is-vellum",
});

export default function WhatIsVellumPage() {
  return <WhatIsVellumContent />;
}
