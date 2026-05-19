import {
  getPlanWithSteps,
  listActivePlansForConversation,
} from "./plan-store.js";

export function buildActivePlanContext(conversationId: string): string | null {
  const plans = listActivePlansForConversation(conversationId, 3);
  const sections: string[] = [];

  for (const plan of plans) {
    const found = getPlanWithSteps(plan.id);
    if (!found) continue;
    const completed = found.steps.filter((step) => step.status === "completed");
    const blocked = found.steps.find((step) => step.status === "blocked");
    const next =
      blocked ??
      found.steps.find((step) => step.status === "running") ??
      found.steps.find((step) => step.status === "pending");

    const lines = [
      `Goal: ${found.plan.goal}`,
      `Plan ID: ${found.plan.id}`,
      `Status: ${found.plan.status}`,
      `Progress: ${completed.length}/${found.steps.length} steps completed`,
    ];
    if (next) {
      lines.push(
        `Current step: ${next.stepOrder + 1}. ${next.name} (${next.status})`,
      );
      if (next.status === "blocked" && next.blockedReason) {
        lines.push(`Blocked reason: ${next.blockedReason}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return [
    "The assistant is helping the user complete these confirmed plans.",
    "Use this to stay oriented, ask before meaningful actions, and update step status when visible progress changes.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}
