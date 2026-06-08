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
  defaultProfileKey?: string,
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
  let currentLabel: string;
  if (currentProfile === AUTO_PROFILE_KEY) {
    const fallbackEntry = defaultProfileKey
      ? profiles[defaultProfileKey]
      : undefined;
    const fallbackLabel = fallbackEntry?.label ?? defaultProfileKey ?? "Balanced";
    currentLabel = `Auto (starting on ${fallbackLabel})`;
  } else {
    currentLabel = currentEntry?.label ?? currentProfile ?? "current";
  }

  return {
    name: SWITCH_INFERENCE_PROFILE_TOOL_NAME,
    description: `Switch to a different inference profile BEFORE answering. Your current profile is "${currentLabel}".\n\nSwitch UP when the query clearly requires capabilities beyond your current profile: multi-step reasoning, math proofs, complex coding, or detailed creative writing.\n\nStay on the current profile by default — only switch DOWN if the query is trivially simple (one-word answer, brief acknowledgment) AND a faster profile would produce an equivalent response.\n\nWhen in doubt, stay on the current profile. Switching adds latency, so only switch when the quality difference justifies it.\n\nAvailable profiles:\n${profileDescriptions}`,
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
