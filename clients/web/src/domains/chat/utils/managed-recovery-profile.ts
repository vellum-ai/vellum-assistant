/**
 * Picks a Vellum-managed profile the invalid-key banner can switch to.
 *
 * A rejected personal (BYOK) key must stay on the selected custom profile so
 * the user can fix the credential. Recovery is an explicit switch to a
 * managed profile that can dispatch, not a silent provider fallback.
 */

import {
  isDispatchableProfile,
  type ProfileDispatchOptions,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";

const PREFERRED_MANAGED_PROFILE = "balanced";

export type RecoveryProfileEntry = ProfilePickerEntry & {
  readonly source?: "managed" | "user" | null;
};

export function orderedProfileEntries(
  profiles: Record<string, Omit<RecoveryProfileEntry, "name">>,
  profileOrder: readonly string[],
): RecoveryProfileEntry[] {
  const ordered = profileOrder
    .filter((name) => name in profiles)
    .map((name) => ({ name, ...profiles[name]! }));
  const extras = Object.keys(profiles)
    .filter((name) => !profileOrder.includes(name))
    .map((name) => ({ name, ...profiles[name]! }));
  return [...ordered, ...extras];
}

/**
 * First dispatchable managed profile, preferring the shipped `balanced`
 * default when that entry is usable. `excludeName` drops the profile the
 * failed turn already used so recovery cannot reselect the broken key.
 */
export function pickManagedRecoveryProfile(
  entries: ReadonlyArray<RecoveryProfileEntry>,
  options: ProfileDispatchOptions,
  excludeName?: string | null,
): string | null {
  const candidates = entries.filter(
    (entry) =>
      entry.source === "managed" &&
      entry.name !== excludeName &&
      isDispatchableProfile(entry, entries, options),
  );
  if (candidates.length === 0) {
    return null;
  }
  const preferred = candidates.find(
    (entry) => entry.name === PREFERRED_MANAGED_PROFILE,
  );
  return (preferred ?? candidates[0])?.name ?? null;
}
