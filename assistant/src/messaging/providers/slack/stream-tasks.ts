/**
 * Slack's task-card vocabulary for a plan carried on a growing reply.
 *
 * Lives channel-side because both halves are Slack's: the `task_update` chunk
 * shape, and a status vocabulary that spells two of the assistant's four
 * statuses differently. The core sends the plan; what it becomes is here.
 */

import type { SlackStreamTask, StreamPlanStep } from "@vellumai/gateway-client";

const TASK_PROGRESS_STATUS_TO_SLACK: Record<
  StreamPlanStep["status"],
  SlackStreamTask["status"]
> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "complete",
  failed: "error",
};

/**
 * Map ordered `task_progress` steps onto Slack streaming task cards. Step
 * position supplies the stable card `id` (a step keeps its index across
 * updates), the label becomes the card title, the step detail becomes the
 * card details, and the surface status maps onto Slack's task-card status
 * vocabulary.
 *
 * @see https://docs.slack.dev/ai/developing-agents
 */
export function toSlackStreamTasks(
  steps: readonly StreamPlanStep[],
): SlackStreamTask[] {
  return steps.map((step, index) => ({
    id: `task-${index}`,
    title: step.label,
    status: TASK_PROGRESS_STATUS_TO_SLACK[step.status],
    ...(step.detail ? { details: step.detail } : {}),
  }));
}
