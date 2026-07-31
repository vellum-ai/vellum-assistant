import { HostingOptionsContent } from "@/app/docs/_components/hosting-options-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Hosting options - Vellum Docs",
  description:
    "Choose where your assistant runs: Vellum Cloud (recommended), local on your Mac, or self-hosted on your own infrastructure.",
  path: "/docs/hosting-options",
});

export default function HostingOptionsPage() {
  return <HostingOptionsContent />;
}
