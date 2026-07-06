import type { SlackStreamTask } from "@vellumai/gateway-client";

/**
 * A single step of a `task_progress` UI surface: an ordered, status-bearing
 * unit of work the assistant reports while a turn runs.
 */
export type TaskProgressStep = {
  label: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  detail?: string;
};

export type TaskProgressData = {
  /** Plan title shown above the steps (e.g. "Q2 Launch Plan"). */
  title?: string;
  steps: TaskProgressStep[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a `task_progress` surface payload into typed steps, if it is one. */
export function getTaskProgressDataFromSurfaceData(
  data: unknown,
): TaskProgressData | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (data.template !== "task_progress") {
    return undefined;
  }
  return parseTaskProgressData(data.templateData);
}

function parseTaskProgressData(value: unknown): TaskProgressData | undefined {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return undefined;
  }

  const steps = value.steps.flatMap((step): TaskProgressStep[] => {
    if (!isRecord(step)) {
      return [];
    }
    if (typeof step.label !== "string") {
      return [];
    }
    if (
      step.status !== "pending" &&
      step.status !== "in_progress" &&
      step.status !== "completed" &&
      step.status !== "failed"
    ) {
      return [];
    }
    const detail =
      typeof step.detail === "string" && step.detail.trim().length > 0
        ? step.detail
        : undefined;
    return [
      { label: step.label, status: step.status, ...(detail ? { detail } : {}) },
    ];
  });
  if (steps.length === 0) {
    return undefined;
  }

  const title =
    typeof value.title === "string" && value.title.trim().length > 0
      ? value.title
      : undefined;
  return { ...(title ? { title } : {}), steps };
}

/**
 * Apply a `ui_surface_update` payload onto the steps already known for a
 * surface. A full `task_progress` payload replaces the steps; a partial
 * `templateData` update is merged over the existing steps.
 */
export function mergeTaskProgressData(
  existing: TaskProgressData | undefined,
  data: unknown,
): TaskProgressData | undefined {
  if (!isRecord(data)) {
    return existing;
  }
  const update = getTaskProgressDataFromSurfaceData(data);
  if (update) {
    return update;
  }
  if (!existing || !("templateData" in data)) {
    return existing;
  }

  return parseTaskProgressData({
    title: existing.title,
    steps: existing.steps,
    ...(isRecord(data.templateData) ? data.templateData : {}),
  });
}

const TASK_PROGRESS_STATUS_TO_SLACK: Record<
  TaskProgressStep["status"],
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
  progress: TaskProgressData,
): SlackStreamTask[] {
  return progress.steps.map((step, index) => ({
    id: `task-${index}`,
    title: step.label,
    status: TASK_PROGRESS_STATUS_TO_SLACK[step.status],
    ...(step.detail ? { details: step.detail } : {}),
  }));
}
