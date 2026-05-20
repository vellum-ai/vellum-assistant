/**
 * Helpers for profile picker UIs (Default Profile dropdown, call-site
 * override pickers, the composer profile menu).
 *
 * Disabled profiles are hidden from pickers in normal usage, but the
 * currently-selected one must remain visible so the picker can render
 * its trigger label and the user has a visible recovery path.
 */

export interface ProfilePickerEntry {
  readonly name: string;
  readonly label?: string | null;
  readonly status?: "active" | "disabled";
}

/**
 * Returns the subset of `profiles` to render in a picker.
 *
 * Drops `status === "disabled"` entries, EXCEPT for any entry whose
 * `name` appears in `selectedNames` — those stay visible so the picker
 * can show the current selection.
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
 * suffix when the profile is disabled.
 */
export function profilePickerLabel(p: ProfilePickerEntry): string {
  const base = p.label ?? p.name;
  return p.status === "disabled" ? `${base} (Disabled)` : base;
}
