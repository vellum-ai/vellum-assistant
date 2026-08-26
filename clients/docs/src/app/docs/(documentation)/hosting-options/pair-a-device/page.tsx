import { HostingOptionsPairADeviceContent } from "@/app/docs/_components/hosting-options-pair-a-device-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Pair a device - Vellum Docs",
  description:
    "Reach a self-hosted assistant from your phone, tablet, or another computer: open a tunnel, pair a device, and revoke access when you're done.",
  path: "/docs/hosting-options/pair-a-device",
});

export default function PairADevicePage() {
  return <HostingOptionsPairADeviceContent />;
}
