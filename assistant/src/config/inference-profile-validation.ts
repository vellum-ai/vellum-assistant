import { getUserSelectableProfilesForProvider } from "./default-profile-catalog.js";
import { getConfigReadOnly } from "./loader.js";

/**
 * Validate an inference-profile key against the effective profile catalog
 * (code-defined defaults + workspace `llm.profiles`). Returns a user-facing
 * error message when the key is empty or unknown, or `null` when valid.
 *
 * Resolved through the `llm.defaultProvider`-aware user-selectable view so
 * availability matches what a direct profile pin can choose. Managed backup
 * routes remain available to automatic fallback resolution but are not
 * reported as selectable profiles.
 */
export function validateInferenceProfileKey(profile: string): string | null {
  if (!profile.trim()) {
    return "inferenceProfile must be a non-empty string";
  }
  const llm = getConfigReadOnly().llm;
  const profiles = getUserSelectableProfilesForProvider(
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
