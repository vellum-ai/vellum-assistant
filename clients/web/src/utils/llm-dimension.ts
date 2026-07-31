export type LlmUsageDimension = "model" | "task" | "profile";

export const DEFAULT_LLM_USAGE_DIMENSION: LlmUsageDimension = "model";

export const LLM_USAGE_DIMENSION_LABELS: Record<LlmUsageDimension, string> = {
  model: "Model",
  task: "Action",
  profile: "Profile",
};

export const LLM_USAGE_DIMENSION_ITEMS: Array<{
  value: LlmUsageDimension;
  label: string;
}> = [
  { value: "model", label: LLM_USAGE_DIMENSION_LABELS.model },
  { value: "task", label: LLM_USAGE_DIMENSION_LABELS.task },
  { value: "profile", label: LLM_USAGE_DIMENSION_LABELS.profile },
];

export function isLlmUsageDimension(value: string): value is LlmUsageDimension {
  return value === "model" || value === "task" || value === "profile";
}

// Maps the frontend dimension to the assistant daemon's groupBy wire format.
// The daemon route is GET /v1/assistants/{id}/usage/breakdown.
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

// Maps the frontend dimension to the Django billing usage group_by wire format.
// The Django routes are /v1/organizations/billing/usage/{series,totals,breakdown}.
export function toBillingGroupBy(
  d: LlmUsageDimension,
): "model" | "llm_call_site" | "inference_profile" {
  switch (d) {
    case "model":
      return "model";
    case "task":
      return "llm_call_site";
    case "profile":
      return "inference_profile";
  }
}
