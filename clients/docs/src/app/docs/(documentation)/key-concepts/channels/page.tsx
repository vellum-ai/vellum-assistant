import { KeyConceptsChannelsContent } from "@/app/docs/_components/key-concepts-channels-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels - Vellum Docs",
  description:
    "Vellum communication channels: desktop app, CLI, Telegram, Slack, email, and phone. Same assistant everywhere, adapted to each channel.",
  path: "/docs/key-concepts/channels",
});

export default function KeyConceptsChannelsPage() {
  return <KeyConceptsChannelsContent />;
}
