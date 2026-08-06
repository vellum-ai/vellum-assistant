import { SkillsReferenceTasksContent } from "@/app/docs/_components/skills-reference-tasks-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Tasks - Vellum Docs",
  description:
    "Tasks skill for Vellum — a two-layer task system with reusable templates and a prioritized work queue.",
  path: "/docs/skills-reference/tasks",
});

export default function SkillsReferenceTasksPage() {
  return <SkillsReferenceTasksContent />;
}
