import type { ProfileEntry } from "../config/schemas/llm.js";
import { AUTO_PROFILE_KEY } from "../config/seed-inference-profiles.js";
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
    ([key, entry]) =>
      entry.status !== "disabled" &&
      key !== AUTO_PROFILE_KEY &&
      // Mix profiles are A/B-routing buckets, not concrete targets the model
      // should self-select into — exclude them so the picker only offers real
      // profiles.
      entry.mix == null,
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
  const currentLabel =
    currentProfile === AUTO_PROFILE_KEY
      ? "Auto (starting on Balanced)"
      : (currentEntry?.label ?? currentProfile ?? "current");

  return {
    name: SWITCH_INFERENCE_PROFILE_TOOL_NAME,
    description: `Switch to a different inference profile BEFORE answering. You MUST call this tool when the user's query requires capabilities beyond what your current profile ("${currentLabel}") provides — AND you MUST also call it when the query is trivially simple and a faster, cheaper profile would handle it equally well.\n\nSwitch UP (to a more capable profile) for: multi-step reasoning or analysis, math proofs or derivations, complex coding tasks, detailed creative writing, or any task requiring deep thought.\n\nSwitch DOWN (to a faster profile) for: simple greetings or chitchat, one-word or single-sentence answers, factual lookups, acknowledgments, or any query that does not benefit from advanced reasoning.\n\nWhen in doubt about whether you can handle the query well, switch UP. When in doubt about whether the query is too simple for your current profile, switch DOWN.\n\nAvailable profiles:\n${profileDescriptions}`,
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
