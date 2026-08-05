/**
 * Helpers for profile picker UIs (Default Profile dropdown, call-site
 * override pickers, the composer profile menu).
 *
 * A picker shows the profiles the resolver would actually accept. It hides
 * the ones it would skip, EXCEPT the current selection, which stays visible
 * so the picker can render its trigger label and the user has a visible
 * recovery path. Without that carve-out, a profile becoming unusable leaves
 * the trigger with an empty label and the user wondering what's in effect.
 */

import type { ProfileEntry } from "@/generated/daemon/types.gen";

/**
 * The subset of a profile a picker needs. Fields are typed from the generated
 * `ProfileEntry` so they cannot drift from the wire, and stay optional so
 * callers can pass a summary shape that omits some of them.
 */
export interface ProfilePickerEntry {
  readonly name: string;
  readonly label?: ProfileEntry["label"];
  readonly status?: ProfileEntry["status"];
  readonly provider?: ProfileEntry["provider"] | null;
  readonly model?: ProfileEntry["model"] | null;
  readonly mix?: ProfileEntry["mix"];
}

/**
 * Whether the resolver would accept this profile when a rung names it.
 *
 * Mirrors `usableEntry` in `assistant/src/config/llm-resolver.ts`: a rung
 * only wins if its profile is enabled and carries its own provider AND
 * model. A profile missing either is reported as `"incomplete"` and skipped,
 * so offering it in a picker produces a pin that silently falls through to
 * the next rung while the UI still shows it as the selection.
 *
 * A mix carries no provider or model of its own: the daemon expands it to a
 * seeded arm and judges that arm. Treat mixes as dispatchable rather than
 * re-deriving arm selection here, so a working mix is never hidden. A mix
 * whose arms are all broken still falls through at resolution time, which is
 * the same outcome as today.
 */
export function isDispatchableProfile(p: ProfilePickerEntry): boolean {
  if (p.status === "disabled") {
    return false;
  }
  if (p.mix != null) {
    return true;
  }
  return !!p.provider && !!p.model;
}

/**
 * Chooses the profile used when a call-site override is toggled on.
 * The optional preferred profile is used only when it is dispatchable;
 * otherwise the first dispatchable profile is used.
 */
export function selectSeedProfileForOverride<T extends ProfilePickerEntry>(
  profiles: ReadonlyArray<T>,
  preferredProfile: string | null | undefined,
): string | undefined {
  const candidates = profiles.filter(isDispatchableProfile);
  if (preferredProfile && candidates.some((p) => p.name === preferredProfile)) {
    return preferredProfile;
  }
  return candidates[0]?.name;
}

/**
 * Returns the subset of `profiles` to render in a picker.
 *
 * Drops entries the resolver would skip (see `isDispatchableProfile`),
 * EXCEPT for any entry whose `name` appears in `selectedNames`, which stay
 * visible so the picker can show the current selection.
 *
 * `selectedNames` accepts loose values (string | null | undefined) so
 * callers can splat the raw active-profile state without pre-filtering.
 */
export function visibleProfilesForPicker<T extends ProfilePickerEntry>(
  profiles: ReadonlyArray<T>,
  selectedNames: ReadonlyArray<string | null | undefined>,
): T[] {
  const selected = new Set<string>();
  for (const n of selectedNames) {
    if (n) {
      selected.add(n);
    }
  }
  return profiles.filter(
    (p) => isDispatchableProfile(p) || selected.has(p.name),
  );
}

/**
 * Label to render in a picker for a profile. Flags the states the resolver
 * would skip, since the only path such an entry appears in a picker is
 * `visibleProfilesForPicker` keeping it as the current selection: without
 * the suffix the user sees a normal-looking selection that is not the
 * profile the action actually runs on.
 */
export function profilePickerLabel(p: ProfilePickerEntry): string {
  const base = p.label ?? p.name;
  if (p.status === "disabled") {
    return `${base} (Disabled)`;
  }
  if (!isDispatchableProfile(p)) {
    return `${base} (Unavailable)`;
  }
  return base;
}
