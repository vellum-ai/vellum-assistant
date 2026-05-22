import type { ProfileEntry } from "../config/schemas/llm.js";
import type { ToolDefinition } from "../providers/types.js";

export const SWITCH_INFERENCE_PROFILE_TOOL_NAME = "switch_inference_profile";

export function buildSwitchInferenceProfileToolDef(
  profiles: Record<string, ProfileEntry>,
  currentProfile?: string,
): ToolDefinition | null {
  const entries = Object.entries(profiles).filter(
    ([, entry]) => entry.status !== "disabled",
  );
  if (entries.length < 2) return null;

  const profileDescriptions = entries
    .map(([key, entry]) => {
      const label = entry.label ?? key;
      const desc = entry.description ? `: ${entry.description}` : "";
      const current = key === currentProfile ? " (current)" : "";
      return `- ${key} — ${label}${desc}${current}`;
    })
    .join("\n");

  return {
    name: SWITCH_INFERENCE_PROFILE_TOOL_NAME,
    description: `Switch to a different inference profile for this response. Only call this if the current profile is poorly suited for the query — e.g., a simple factual question is hitting a heavy reasoning model, or a complex multi-step problem needs a more capable model. Do NOT call this if the current profile is adequate.\n\nAvailable profiles:\n${profileDescriptions}`,
    input_schema: {
      type: "object" as const,
      properties: {
        profile: {
          type: "string",
          enum: entries.map(([key]) => key),
          description: "The profile key to switch to.",
        },
      },
      required: ["profile"],
    },
  };
}
