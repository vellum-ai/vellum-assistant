import { validateInferenceProfileKey } from "../config/inference-profile-validation.js";
import { resolveDefaultProfileKey } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  type DurableProfileFields,
  resolveDurableProfile,
} from "../persistence/conversation-crud.js";

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
 * The profile a wake schedule pins when its creator names none.
 *
 * A wake resumes an existing conversation and forces the row's pin as the
 * woken turn's override, so the target's own choice, not the global default,
 * is what the user expects it to fire on. Only a *durable* pin seeds the row
 * ({@link resolveDurableProfile}): a TTL-limited profile session is a
 * deliberately temporary choice, and freezing one into a row that fires next
 * week would keep billing that model long after the session lapsed. A target
 * with no durable pin falls through to the same default every other schedule
 * snapshots.
 *
 * Both the create path and the backfill of rows that predate it resolve
 * through here, so a pending wake keeps firing on the profile it would have
 * resolved live.
 *
 * @param target The wake's target conversation, or null when it has none.
 */
export function resolveWakeScheduleInferenceProfile(
  target: DurableProfileFields | null,
): string | null {
  return (
    resolveDurableProfile(target) ?? resolveDefaultScheduleInferenceProfile()
  );
}

/**
 * Render a schedule's pinned profile for CLI and tool output. A `null` pin has
 * no named profile behind it, so it is reported as the call site's own
 * selection rather than as a profile key.
 */
export function formatScheduleInferenceProfile(profile: string | null): string {
  return profile ?? "none (mainAgent call-site default)";
}
