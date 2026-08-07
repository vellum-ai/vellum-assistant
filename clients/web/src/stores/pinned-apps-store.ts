/**
 * Zustand store for pinned-app state.
 *
 * Pin state is persisted to localStorage via {@link appPinStorage}, which owns
 * it: actions write there first and the store follows, both for its own writes
 * and for changes arriving from another tab. It is a mirror rather than a
 * plain read-through because it also derives `pinnedAppIds` for the callers
 * that only ask whether one app is pinned, and hosts the unpin listeners.
 *
 * No provider required — the store is a module-level singleton
 * accessible anywhere via `usePinnedAppsStore.use.*()` (React) or
 * `usePinnedAppsStore.getState()` (non-React).
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  loadPinnedApps,
  pinApp,
  setAppColor,
  subscribePinnedApps,
  unpinApp,
  type PinnableApp,
  type PinnedAppEntry,
} from "@/utils/app-pin-storage";

// ---------------------------------------------------------------------------
// Unpin event listeners
// ---------------------------------------------------------------------------

type UnpinListener = (appId: string) => void;
const unpinListeners = new Set<UnpinListener>();

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

export interface PinnedAppsState {
  pinnedApps: PinnedAppEntry[];
  pinnedAppIds: Set<string>;
}

export interface PinnedAppsActions {
  togglePin: (app: PinnableApp) => void;
  /**
   * Remove a pin by id. Safe to call for an app that is no longer loadable
   * (e.g. deleted server-side), which is the sidebar's only way to clear a
   * stale entry — the app never renders in the Library, so its card-level
   * unpin is unreachable. A no-op when the id isn't pinned.
   */
  unpin: (appId: string) => void;
  /**
   * Set or clear the colour the sidebar tints this pin with, as an id from the
   * pinned-app colour registry. `null` clears it. A no-op when the id is not
   * pinned, matching {@link PinnedAppsActions.unpin}.
   */
  setColor: (appId: string, color: string | null) => void;
  isPinned: (appId: string) => boolean;
  onUnpin: (listener: UnpinListener) => () => void;
}

export type PinnedAppsStore = PinnedAppsState & PinnedAppsActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveState(pinnedApps: PinnedAppEntry[]): PinnedAppsState {
  return {
    pinnedApps,
    pinnedAppIds: new Set(pinnedApps.map((a) => a.appId)),
  };
}

/**
 * Bring the store up to what storage holds, announcing any pin that went away.
 *
 * The one way state advances, whether the write came from this tab or another,
 * so a removed pin is announced once by whoever notices it first. That is what
 * lets an action call it directly and the subscription call it as well,
 * without either depending on the other having run.
 */
function syncFromStorage(): void {
  const previous = usePinnedAppsStoreBase.getState();
  const pinnedApps = loadPinnedApps();

  /* An unchanged key reads back as the same array, because the accessor caches
     its parse against the raw string. Stopping here is what makes a redundant
     call free: publishing anyway would hand every consumer a fresh
     `pinnedAppIds` Set, and the six that only ask whether one app is pinned
     would re-render against a set holding exactly what it held before. */
  if (pinnedApps === previous.pinnedApps) {
    return;
  }

  const next = deriveState(pinnedApps);
  usePinnedAppsStoreBase.setState(next);

  /* An app open in this tab has to close when its pin is cleared, which is
     what `use-active-app-pin-sync` listens for. Driving that from the diff
     rather than from `unpin` means a pin cleared in another tab closes the
     panel too, instead of leaving it open against a pin that is gone. */
  for (const appId of previous.pinnedAppIds) {
    if (!next.pinnedAppIds.has(appId)) {
      for (const listener of unpinListeners) {
        listener(appId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/* `set` goes unused: `syncFromStorage` is the only writer, and it reaches the
   store directly because the subscription calls it from out here as well. */
const usePinnedAppsStoreBase = create<PinnedAppsStore>()((_set, get) => ({
  ...deriveState(loadPinnedApps()),

  togglePin: (app: PinnableApp) => {
    if (get().pinnedAppIds.has(app.id)) {
      get().unpin(app.id);
    } else {
      pinApp(app);
      syncFromStorage();
    }
  },

  unpin: (appId: string) => {
    if (!get().pinnedAppIds.has(appId)) {
      return;
    }
    unpinApp(appId);
    syncFromStorage();
  },

  setColor: (appId: string, color: string | null) => {
    if (!get().pinnedAppIds.has(appId)) {
      return;
    }
    setAppColor(appId, color);
    syncFromStorage();
  },

  isPinned: (appId: string) => get().pinnedAppIds.has(appId),

  onUnpin: (listener: UnpinListener) => {
    unpinListeners.add(listener);
    return () => {
      unpinListeners.delete(listener);
    };
  },
}));

/**
 * A pin list changed under us, by another tab or by anything else writing the
 * key, so catch up to it.
 *
 * Our own writes arrive here too, since a save announces itself on the same
 * channel. That costs nothing and is not relied upon: {@link syncFromStorage}
 * settles against live state, so whichever of the action and this subscription
 * reaches it first does the work and the other finds nothing to do.
 *
 * Never unsubscribed. The store is a module-level singleton that lives as long
 * as the document, so there is no later moment at which following the pins is
 * the wrong thing to do.
 */
subscribePinnedApps(syncFromStorage);

export const usePinnedAppsStore = createSelectors(usePinnedAppsStoreBase);
