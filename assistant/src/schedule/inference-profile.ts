import { validateInferenceProfileKey } from "../config/inference-profile-validation.js";
import { resolveDefaultProfileKey } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";

/**
 * Validate a schedule's inference-profile key against the configured
 * `llm.profiles` catalog. Returns a user-facing error message when the key is
 * empty or unknown, or `null` when valid.
 *
 * Only create/update paths validate. A profile deleted after a schedule was
 * pinned to it degrades gracefully at run time: the resolver silently drops a
 * missing `overrideProfile` reference and falls through to the defaults, so
 * the schedule keeps firing on the call site's own model selection.
 */
export function validateScheduleInferenceProfile(
  profile: string,
): string | null {
  return validateInferenceProfileKey(profile);
}

/**
 * The inference-profile key a schedule is pinned to when its creator names
 * none, and the key a `null` update re-snapshots to.
 *
 * Every schedule carries a concrete profile so its cost is stable: an unpinned
 * schedule would follow `llm.activeProfile`, silently moving to a different
 * model (and a different price) whenever the user changes their global
 * default. Snapshotting the resolved default at write time keeps the schedule
 * on the model it was created under until someone re-pins it.
 *
 * `mainAgent` is the call site scheduled turns run under (see `scheduler.ts`).
 * Returns `null` when the resolved winner is the code-owned anchor rather than
 * a named profile: there is no key to record, and the run resolves through the
 * `mainAgent` call-site configuration exactly as an unpinned schedule did.
 */
export function resolveDefaultScheduleInferenceProfile(): string | null {
  return resolveDefaultProfileKey("mainAgent", getConfig().llm) ?? null;
}

/**
 * Render a schedule's pinned profile for CLI and tool output. A `null` pin has
 * no named profile behind it, so it is reported as the call site's own
 * selection rather than as a profile key.
 */
export function formatScheduleInferenceProfile(profile: string | null): string {
  return profile ?? "none (mainAgent call-site default)";
}
