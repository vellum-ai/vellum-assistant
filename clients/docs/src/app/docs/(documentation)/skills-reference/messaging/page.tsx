import { SkillsReferenceMessagingContent } from "@/app/docs/_components/skills-reference-messaging-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Messaging - Vellum Docs",
  description:
    "Messaging skill for Vellum: send and receive messages across Slack, Gmail, and Telegram.",
  path: "/docs/skills-reference/messaging",
});

export default function SkillsReferenceMessagingPage() {
  return <SkillsReferenceMessagingContent />;
}
