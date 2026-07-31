import { QuickStartContent } from "@/app/docs/_components/quick-start-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Quick Start: Your First 2 Minutes - Vellum Docs",
  description:
    "Your first 2 minutes with Vellum: setup, meeting your assistant, and getting started.",
  path: "/docs/getting-started/quick-start",
});

export default function QuickStartPage() {
  return <QuickStartContent />;
}
