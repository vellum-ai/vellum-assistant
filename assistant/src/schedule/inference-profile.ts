import { getConfigReadOnly } from "../config/loader.js";

/**
 * Validate a schedule's inference-profile key against the configured
 * `llm.profiles` catalog. Returns a user-facing error message when the key is
 * empty or unknown, or `null` when valid.
 *
 * Only create/update paths validate — a profile deleted after a schedule was
 * created degrades gracefully at run time (the resolver silently drops a
 * missing `overrideProfile` reference and falls through to the defaults).
 */
export function validateScheduleInferenceProfile(
  profile: string,
): string | null {
  if (!profile.trim()) {
    return "inferenceProfile must be a non-empty string";
  }
  const profiles = getConfigReadOnly().llm?.profiles ?? {};
  if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
    const available = Object.keys(profiles).sort();
    const hint =
      available.length > 0
        ? ` Available profiles: ${available.join(", ")}.`
        : " No profiles defined in llm.profiles.";
    return `Inference profile "${profile}" is not defined in llm.profiles.${hint}`;
  }
  return null;
}
