import { validateInferenceProfileKey } from "../config/inference-profile-validation.js";

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
  return validateInferenceProfileKey(profile);
}
