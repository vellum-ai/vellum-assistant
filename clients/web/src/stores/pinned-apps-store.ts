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
import type { AppSummary } from "@/types/app-types";
import {
  loadPinnedApps,
  pinApp,
  unpinApp,
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
  togglePin: (app: AppSummary) => void;
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

  togglePin: (app: AppSummary) => {
    const wasPinned = get().pinnedAppIds.has(app.id);
    if (wasPinned) {
      unpinApp(app.id);
    } else {
      pinApp(app);
    }
    set(loadState());
    if (wasPinned) {
      for (const listener of unpinListeners) listener(app.id);
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
