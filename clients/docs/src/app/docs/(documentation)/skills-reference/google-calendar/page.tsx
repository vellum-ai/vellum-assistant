import { SkillsReferenceGoogleCalendarContent } from "@/app/docs/_components/skills-reference-google-calendar-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Google Calendar - Vellum Docs",
  description:
    "Google Calendar skill for Vellum — view events, create meetings, and check availability.",
  path: "/docs/skills-reference/google-calendar",
});

export default function SkillsReferenceGoogleCalendarPage() {
  return <SkillsReferenceGoogleCalendarContent />;
}
