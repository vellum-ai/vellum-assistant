import { HostingOptionsLocalHostingContent } from "@/app/docs/_components/hosting-options-local-hosting-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Local hosting - Vellum Docs",
  description:
    "Run your assistant locally on your Mac with setup guidance, tradeoffs, and best practices.",
  path: "/docs/hosting-options/local-hosting",
});

export default function LocalHostingPage() {
  return <HostingOptionsLocalHostingContent />;
}
