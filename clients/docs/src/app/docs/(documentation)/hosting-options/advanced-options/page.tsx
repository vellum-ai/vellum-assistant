import { HostingOptionsAdvancedOptionsContent } from "@/app/docs/_components/hosting-options-advanced-options-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Advanced options - Vellum Docs",
  description:
    "Advanced hosting options for Vellum assistants: Local Apple Container, GCP, and AWS.",
  path: "/docs/hosting-options/advanced-options",
});

export default function AdvancedOptionsPage() {
  return <HostingOptionsAdvancedOptionsContent />;
}
