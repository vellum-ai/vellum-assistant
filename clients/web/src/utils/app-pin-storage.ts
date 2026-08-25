/**
 * LEGACY. The pre-daemon home for pinned apps, kept only for daemons that do
 * not advertise the `appPins` capability. Nothing new should be built on it.
 *
 * One `vellum:pinnedApps` key serves the whole browser profile, with no
 * assistant in it, which is the defect this module exists to preserve rather
 * than fix: pins made under one assistant show up under another (LUM-3452).
 * That is a daemon-side problem and an old daemon cannot be fixed from here, so
 * this path deliberately behaves exactly as it always did.
 *
 * It is not a fallback for part of the feature. `usePinnedApps` chooses this
 * module or the daemon wholesale, and both handle workspace and plugin apps
 * alike; the split is which side stores the pin, never which kind of app.
 *
 * Delete this file, `lib/backwards-compat/daemon-app-pins.ts`, and
 * `hooks/use-legacy-pin-migration.ts` together once every supported daemon
 * advertises the capability. Nothing else may import it.
 */

import type { AppSummary } from "@/types/app-types";
import { createStorageAccessor } from "@/utils/typed-storage";

export interface PinnedAppEntry {
  appId: string;
  pinnedOrder: number;
  name: string;
  icon?: string;
  /**
   * A colour the user picked for this pin, as an id from the pinned-app colour
   * registry. Absent on a pin with no colour, which is every pin until one is
   * chosen.
   *
   * Unlike {@link PinnedAppEntry.name} and {@link PinnedAppEntry.icon}, this
   * has no counterpart on the app: those two are copied off {@link AppSummary}
   * at pin time and mirror it, while this belongs to the pin alone and is not
   * reflected anywhere else the app appears.
   */
  color?: string;
}

/**
 * The subset of {@link AppSummary} the pin store reads. Pinning persists only
 * the identity and display fields, so callers need not supply server-derived
 * metadata (`version`, `contentId`, timestamps, `origin`) just to pin.
 */
export type PinnableApp = Pick<AppSummary, "id" | "name" | "icon">;

/**
 * Per-entry validation is the whole compatibility story for this key: there is
 * no version stamp, and {@link parsePinnedApps} simply drops what fails. So
 * every optional field must be optional here in both directions. A pin written
 * before that field existed stays valid because `undefined` passes, and a pin
 * carrying a field a reader does not know about stays valid because unknown
 * keys are never rejected.
 */
function isValidEntry(value: unknown): value is PinnedAppEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    typeof record.pinnedOrder === "number" &&
    Number.isFinite(record.pinnedOrder) &&
    typeof record.name === "string" &&
    (record.icon === undefined || typeof record.icon === "string") &&
    (record.color === undefined || typeof record.color === "string")
  );
}

function parsePinnedApps(raw: string): PinnedAppEntry[] | null {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter(isValidEntry);
}

const storage = createStorageAccessor<PinnedAppEntry[]>({
  key: "vellum:pinnedApps",
  scope: "user",
  parse: parsePinnedApps,
  serialize: JSON.stringify,
  fallback: [],
});

export const loadPinnedApps = storage.load;
export const savePinnedApps = storage.save;
export const subscribePinnedApps = storage.subscribe;
/** Drop the key entirely. Used by the migration that drains it. */
export const removePinnedApps = storage.remove;

export function pinApp(app: PinnableApp): void {
  const entries = storage.load();
  if (entries.some((e) => e.appId === app.id)) {
    return;
  }
  const maxOrder = entries.reduce((max, e) => Math.max(max, e.pinnedOrder), 0);
  storage.save([
    ...entries,
    {
      appId: app.id,
      pinnedOrder: maxOrder + 1,
      name: app.name,
      icon: app.icon,
    },
  ]);
}

export function unpinApp(appId: string): void {
  let entries = storage.load().filter((e) => e.appId !== appId);
  entries = entries
    .sort((a, b) => a.pinnedOrder - b.pinnedOrder)
    .map((e, i) => ({ ...e, pinnedOrder: i + 1 }));
  storage.save(entries);
}

/**
 * Set or clear a pin's colour. `null` clears it. A no-op for an app that is
 * not pinned, so a colour can never conjure a pin that unpinning just removed.
 */
export function setAppColor(appId: string, color: string | null): void {
  const entries = storage.load();
  if (!entries.some((e) => e.appId === appId)) {
    return;
  }
  storage.save(
    entries.map((entry) => {
      if (entry.appId !== appId) {
        return entry;
      }
      /* Drop the key rather than storing `undefined`: `JSON.stringify` omits
         it either way, so keeping it would leave the in-memory entry and the
         entry read back from storage unequal. */
      const { color: _cleared, ...rest } = entry;
      return color === null ? rest : { ...rest, color };
    }),
  );
}

export function isAppPinned(appId: string): boolean {
  return storage.load().some((e) => e.appId === appId);
}
