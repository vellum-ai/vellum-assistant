/**
 * Zustand store for pinned-app state.
 *
 * Pin state is persisted to localStorage via {@link appPinStorage}.
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
  isPinned: (appId: string) => boolean;
  onUnpin: (listener: UnpinListener) => () => void;
}

export type PinnedAppsStore = PinnedAppsState & PinnedAppsActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadState(): PinnedAppsState {
  const pinnedApps = loadPinnedApps();
  return {
    pinnedApps,
    pinnedAppIds: new Set(pinnedApps.map((a) => a.appId)),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const usePinnedAppsStoreBase = create<PinnedAppsStore>()((set, get) => ({
  ...loadState(),

  togglePin: (app: PinnableApp) => {
    if (get().pinnedAppIds.has(app.id)) {
      get().unpin(app.id);
    } else {
      pinApp(app);
      set(loadState());
    }
  },

  unpin: (appId: string) => {
    if (!get().pinnedAppIds.has(appId)) {
      return;
    }
    unpinApp(appId);
    set(loadState());
    for (const listener of unpinListeners) {
      listener(appId);
    }
  },

  isPinned: (appId: string) => get().pinnedAppIds.has(appId),

  onUnpin: (listener: UnpinListener) => {
    unpinListeners.add(listener);
    return () => {
      unpinListeners.delete(listener);
    };
  },
}));

export const usePinnedAppsStore = createSelectors(usePinnedAppsStoreBase);
