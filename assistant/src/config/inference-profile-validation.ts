import { getConversationProfilesForProvider } from "./default-profile-catalog.js";
import { getConfigReadOnly } from "./loader.js";

/**
 * Validate an inference-profile key against the effective profile catalog
 * (code-defined defaults + workspace `llm.profiles`). Returns a user-facing
 * error message when the key is empty or unknown, or `null` when valid.
 *
 * Resolved through the `llm.defaultProvider`-aware conversation view, since
 * every caller (schedules, subagent spawns, per-conversation pins) runs chat
 * turns on the result. Managed backup routes remain available to automatic
 * fallback resolution, and the managed Jev profile to the verdict call
 * sites, but neither is reported as a selectable profile here.
 */
export function validateInferenceProfileKey(profile: string): string | null {
  if (!profile.trim()) {
    return "inferenceProfile must be a non-empty string";
  }
  const llm = getConfigReadOnly().llm;
  const profiles = getConversationProfilesForProvider(
    llm?.profiles,
    llm?.defaultProvider ?? null,
  );
  const entry = profiles[profile];
  if (entry === undefined) {
    const available = Object.keys(profiles).sort();
    const hint =
      available.length > 0
        ? ` Available profiles: ${available.join(", ")}.`
        : " No profiles defined in llm.profiles.";
    return `Inference profile "${profile}" is not defined in llm.profiles.${hint}`;
  }
  if (entry.status === "disabled") {
    return `Inference profile "${profile}" is disabled.`;
  }
  return null;
}
