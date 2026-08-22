import { getEffectiveProfilesForProvider } from "./default-profile-catalog.js";
import { getConfigReadOnly } from "./loader.js";

/**
 * Validate an inference-profile key against the effective profile catalog
 * (code-defined defaults + workspace `llm.profiles`). Returns a user-facing
 * error message when the key is empty or unknown, or `null` when valid.
 *
 * Resolved through the `llm.defaultProvider`-aware view so availability
 * matches what actually dispatches: the managed backup profiles exist on the
 * managed column only, so on a BYOK or ChatGPT install they are not
 * selectable and must not be reported as available.
 */
export function validateInferenceProfileKey(profile: string): string | null {
  if (!profile.trim()) {
    return "inferenceProfile must be a non-empty string";
  }
  const llm = getConfigReadOnly().llm;
  const profiles = getEffectiveProfilesForProvider(
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
