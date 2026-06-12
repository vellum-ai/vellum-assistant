/**
 * Helpers for profile picker UIs (Default Profile dropdown, call-site
 * override pickers, the composer profile menu).
 *
 * Disabled profiles are hidden from pickers in normal usage, but the
 * currently-selected one must remain visible so the picker can render
 * its trigger label and the user has a visible recovery path. Without
 * this carve-out, disabling the active profile leaves the trigger with
 * an empty label and the user wondering what's still in effect.
 *
 * (See Codex post-merge P2 on PR #6413.)
 */

export interface ProfilePickerEntry {
  readonly name: string;
  readonly label?: string | null;
  readonly status?: "active" | "disabled" | null;
}

/**
 * Name of the meta-"auto" profile seeded by the daemon. The entry exists
 * in `llm.profiles` unconditionally so a switched-on `query-complexity-
 * routing` flag has something to point at, but every UI surface that
 * lists profiles must hide it while the flag is off — otherwise it
 * leaks into the composer picker, the Default Profile dropdown, the
 * Manage Profiles modal, and the per-call-site override picker.
 *
 * Mirrors `AUTO_PROFILE_KEY` in
 * `assistant/src/config/seed-inference-profiles.ts`.
 */
export const AUTO_PROFILE_NAME = "auto";

/**
 * Hides the meta-"auto" profile when the `query-complexity-routing`
 * feature flag is off. The daemon seeds `"auto"` into `llm.profiles`
 * unconditionally, so every list-style profile UI must run its source
 * array through this gate before render, or `Auto` shows up in the
 * picker for users whose workspace has the flag disabled.
 */
export function gateAutoProfile<T extends ProfilePickerEntry>(
  profiles: ReadonlyArray<T>,
  queryComplexityRoutingEnabled: boolean,
): T[] {
  if (queryComplexityRoutingEnabled) return [...profiles];
  return profiles.filter((p) => p.name !== AUTO_PROFILE_NAME);
}

/**
 * Chooses the profile used when a call-site override is toggled on.
 * The optional preferred profile is used only when it is active and visible
 * under the current feature-flag gate; otherwise the first active visible
 * profile is used.
 */
export function selectSeedProfileForOverride<T extends ProfilePickerEntry>(
  profiles: ReadonlyArray<T>,
  preferredProfile: string | null | undefined,
  queryComplexityRoutingEnabled: boolean,
): string | undefined {
  const candidates = gateAutoProfile(
    profiles.filter((p) => p.status !== "disabled"),
    queryComplexityRoutingEnabled,
  );
  if (
    preferredProfile &&
    candidates.some((p) => p.name === preferredProfile)
  ) {
    return preferredProfile;
  }
  return candidates[0]?.name;
}

/**
 * Returns the subset of `profiles` to render in a picker.
 *
 * Drops `status === "disabled"` entries, EXCEPT for any entry whose
 * `name` appears in `selectedNames` — those stay visible so the picker
 * can show the current selection.
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
    if (n) selected.add(n);
  }
  return profiles.filter(
    (p) => p.status !== "disabled" || selected.has(p.name),
  );
}

/**
 * Label to render in a picker for a profile. Appends a " (Disabled)"
 * suffix when the profile is disabled — the only path a disabled entry
 * appears in a picker is via `visibleProfilesForPicker` keeping it
 * because it's the current selection, so the suffix makes that state
 * legible at a glance.
 */
export function profilePickerLabel(p: ProfilePickerEntry): string {
  const base = p.label ?? p.name;
  return p.status === "disabled" ? `${base} (Disabled)` : base;
}
