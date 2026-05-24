import type { ProfileEntry } from "../config/schemas/llm.js";
import type { ToolDefinition } from "../providers/types.js";

export const SWITCH_INFERENCE_PROFILE_TOOL_NAME = "switch_inference_profile";

const PROFILE_DESCRIPTION_FALLBACKS: Record<string, string> = {
  "quality-optimized":
    "Most capable model for complex reasoning, multi-step analysis, math, and coding",
  balanced: "Good balance of quality, cost, and speed for most tasks",
  "cost-optimized":
    "Fast responses for simple factual questions, short lookups, and casual chat",
};

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
      const desc =
        entry.description || PROFILE_DESCRIPTION_FALLBACKS[key] || "";
      const descSuffix = desc ? `: ${desc}` : "";
      const current = key === currentProfile ? " (current)" : "";
      return `- ${key} — ${label}${descSuffix}${current}`;
    })
    .join("\n");

  const currentEntry = currentProfile ? profiles[currentProfile] : undefined;
  const currentLabel = currentEntry?.label ?? currentProfile ?? "current";

  return {
    name: SWITCH_INFERENCE_PROFILE_TOOL_NAME,
    description: `Switch to a different inference profile BEFORE answering. You MUST call this tool when the user's query requires capabilities beyond what your current profile ("${currentLabel}") provides. Examples of when to switch to a more capable profile: multi-step reasoning or analysis, math proofs or derivations, complex coding tasks, detailed creative writing, or any task requiring deep thought. Examples of when to switch to a faster profile: simple greetings, one-word answers, factual lookups. When in doubt about whether you can handle the query well, switch to a more capable profile.\n\nAvailable profiles:\n${profileDescriptions}`,
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
