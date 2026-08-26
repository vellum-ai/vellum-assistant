import type { StreamPlan, StreamPlanStep } from "@vellumai/gateway-client";

import { coerceSurfaceDataRecord } from "../api/surfaces.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a `task_progress` surface payload into typed steps, if it is one. */
export function getTaskProgressDataFromSurfaceData(
  data: unknown,
): StreamPlan | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (data.template !== "task_progress") {
    return undefined;
  }
  return parseTaskProgressData(data.templateData);
}

function parseTaskProgressData(value: unknown): StreamPlan | undefined {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return undefined;
  }

  const steps = value.steps.flatMap((step): StreamPlanStep[] => {
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
 * Task progress from a `ui_show` or `ui_update` tool call's input.
 *
 * The model reaches for `ui_show` to draw a plan, so the card's contents ride
 * the turn's own tool-call stream, which every channel consumer already reads.
 * The `ui_surface_show` event the daemon publishes alongside it goes to the
 * conversation sink instead, and no channel consumes that, so reading the tool
 * input is what lets a channel render a plan at all.
 *
 * The template may sit at the top level of the input or nested under `data`,
 * and `data` itself may arrive double-encoded as a JSON string, which is why
 * the coercion is shared with the surface tools rather than restated here.
 */
export function getTaskProgressDataFromToolInput(
  input: unknown,
): StreamPlan | undefined {
  const record = coerceSurfaceDataRecord(input);
  return (
    getTaskProgressDataFromSurfaceData(record) ??
    getTaskProgressDataFromSurfaceData(coerceSurfaceDataRecord(record.data))
  );
}

/**
 * Apply a `ui_surface_update` payload onto the steps already known for a
 * surface. A full `task_progress` payload replaces the steps; a partial
 * `templateData` update is merged over the existing steps.
 */
export function mergeTaskProgressData(
  existing: StreamPlan | undefined,
  data: unknown,
): StreamPlan | undefined {
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
