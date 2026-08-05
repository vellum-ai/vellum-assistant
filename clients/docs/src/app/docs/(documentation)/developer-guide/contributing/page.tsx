import { DeveloperGuideContributingContent } from "@/app/docs/_components/developer-guide-contributing-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Contributing - Vellum Docs",
  description:
    "How to set up the Vellum Assistant repo locally, run tests, follow code conventions, and submit a pull request.",
  path: "/docs/developer-guide/contributing",
});

export default function DeveloperGuideContributingPage() {
  return <DeveloperGuideContributingContent />;
}
