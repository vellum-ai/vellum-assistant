import { DeveloperGuideApiContent } from "@/app/docs/_components/developer-guide-api-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "API & Communication - Developer Guide - Vellum Docs",
  description:
    "SSE event stream, event payloads, connection management, and remote access via SSH.",
  path: "/docs/developer-guide/api",
});

export default function DeveloperGuideApiPage() {
  return <DeveloperGuideApiContent />;
}
