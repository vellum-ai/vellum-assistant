import { DeveloperGuideGetStartedContent } from "@/app/docs/_components/developer-guide-get-started-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Get Started - Vellum Developer Guide",
  description:
    "Developer on-ramp for Vellum Assistant: repo layout, local dev setup, CLI, HTTP API, and SSE event stream.",
  path: "/docs/developer-guide/get-started",
});

export default function GetStartedPage() {
  return <DeveloperGuideGetStartedContent />;
}
