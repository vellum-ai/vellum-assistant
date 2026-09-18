import type { ConversationSurfaceSnapshot } from "../../../../daemon/conversation-surface-snapshots.js";
import { getTaskProgressDataFromSurfaceData } from "../../../../runtime/task-progress.js";

export const ACTIVE_TASK_PROGRESS_OPEN = "<active_task_progress>";
export const ACTIVE_TASK_PROGRESS_CLOSE = "</active_task_progress>";

export const ACTIVE_TASK_PROGRESS_BLOCK =
  /<active_task_progress\b[\s\S]*?<\/active_task_progress>/gi;

const STEP_INSTRUCTION =
  "Update this card with ui_update as the steps change.";

function normalizeField(value: string): string {
  return value
    .replace(/[<>]/g, "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isActiveTaskProgressSurface(
  snapshot: ConversationSurfaceSnapshot,
): boolean {
  if (snapshot.surfaceType !== "card" || snapshot.completed) {
    return false;
  }
  const plan = getTaskProgressDataFromSurfaceData(snapshot.data);
  if (!plan) {
    return false;
  }
  return plan.steps.some(
    (step) => step.status === "pending" || step.status === "in_progress",
  );
}

export function formatActiveTaskProgressSnapshot(
  snapshots: ConversationSurfaceSnapshot[],
): string {
  const cards = snapshots.filter(isActiveTaskProgressSurface);
  if (cards.length === 0) {
    return "";
  }
  return cards
    .map((snapshot) => {
      const plan = getTaskProgressDataFromSurfaceData(snapshot.data);
      if (!plan) {
        return "";
      }
      const lines = [
        ACTIVE_TASK_PROGRESS_OPEN,
        `surface_id: ${normalizeField(snapshot.surfaceId)}`,
      ];
      const title = plan.title ? normalizeField(plan.title) : "";
      if (title.length > 0) {
        lines.push(`title: ${title}`);
      }
      lines.push("steps:");
      for (const step of plan.steps) {
        lines.push(`- [${step.status}] ${normalizeField(step.label)}`);
      }
      lines.push(STEP_INSTRUCTION);
      lines.push(ACTIVE_TASK_PROGRESS_CLOSE);
      return lines.join("\n");
    })
    .filter((block) => block.length > 0)
    .join("\n");
}
