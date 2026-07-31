import { HostingOptionsCloudHostingContent } from "@/app/docs/_components/hosting-options-cloud-hosting-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Cloud hosting - Vellum Docs",
  description:
    "Run your assistant on Vellum Cloud: always-on, sandboxed per account, reachable from web, desktop, voice, and chat channels.",
  path: "/docs/hosting-options/cloud-hosting",
});

export default function CloudHostingPage() {
  return <HostingOptionsCloudHostingContent />;
}
