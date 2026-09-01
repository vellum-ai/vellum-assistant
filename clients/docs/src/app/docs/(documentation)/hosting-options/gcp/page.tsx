import { HostingOptionsGcpContent } from "@/app/docs/_components/hosting-options-gcp-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Google Cloud Platform (GCP) - Vellum Docs",
  description:
    "Run your assistant on a Compute Engine VM in your own Google Cloud project: provision the VM, hatch on it, and reach it through a tunnel.",
  path: "/docs/hosting-options/gcp",
});

export default function GcpPage() {
  return <HostingOptionsGcpContent />;
}
