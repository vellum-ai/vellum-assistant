export type LlmUsageDimension = "model" | "task" | "profile";

export const LLM_USAGE_DIMENSION_LABELS: Record<LlmUsageDimension, string> = {
  model: "Model",
  task: "Action",
  profile: "Profile",
};

export function isLlmUsageDimension(
  value: string,
): value is LlmUsageDimension {
  return value === "model" || value === "task" || value === "profile";
}

/**
 * Maps the frontend dimension to the assistant daemon's groupBy wire format.
 * The daemon route is GET /v1/assistants/{id}/usage/breakdown.
 */
export function toDaemonGroupBy(
  d: LlmUsageDimension,
): "model" | "call_site" | "inference_profile" {
  switch (d) {
    case "model":
      return "model";
    case "task":
      return "call_site";
    case "profile":
      return "inference_profile";
  }
}
