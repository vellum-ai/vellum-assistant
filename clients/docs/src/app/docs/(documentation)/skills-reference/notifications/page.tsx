import { SkillsReferenceNotificationsContent } from "@/app/docs/_components/skills-reference-notifications-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Notifications - Vellum Docs",
  description:
    "Notifications skill for Vellum: sends notifications through a unified routing system across connected channels.",
  path: "/docs/skills-reference/notifications",
});

export default function SkillsReferenceNotificationsPage() {
  return <SkillsReferenceNotificationsContent />;
}
