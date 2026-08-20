import { ExtensibilityChannelsContent } from "@/app/docs/_components/extensibility-channels-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels - Vellum Docs",
  description:
    "Incoming webhooks can be accepted by declaring public ingress in channels/ingress.json. The gateway signature-checks those routes and forwards them to matching plugin handlers.",
  path: "/docs/extensibility/channels",
});

export default function ExtensibilityChannelsPage() {
  return <ExtensibilityChannelsContent />;
}
