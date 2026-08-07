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
    /* No listener call here. Writing the pin out notifies the subscription
       below, which is the one place a disappearing pin is announced, so a
       local unpin and one arriving from another tab travel the same path and
       neither fires twice. */
    unpinApp(appId);
    set(loadState());
  },

  setColor: (appId: string, color: string | null) => {
    if (!get().pinnedAppIds.has(appId)) {
      return;
    }
    setAppColor(appId, color);
    set(loadState());
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
 * Follow the stored pin list, so the store tracks its source rather than only
 * its own writes.
 *
 * The store mirrors `vellum:pinnedApps` and derives `pinnedAppIds` from it.
 * Without this the mirror only ever advanced when this tab was the one making
 * the change, so pinning in one tab left every other tab rendering the old
 * list indefinitely.
 *
 * Our own writes come back through here too: a save notifies synchronously,
 * before the action's own `set` runs. That is deliberate rather than a
 * redundancy to remove. It is what lets `unpin` announce nothing itself and
 * still have its listeners called exactly once, and re-entering costs nothing
 * because the reload is idempotent and the accessor caches its parse against
 * the raw string.
 *
 * Never unsubscribed. The store is a module-level singleton that lives as long
 * as the document, so there is no later moment at which following the pins is
 * the wrong thing to do.
 */
subscribePinnedApps(() => {
  const previousIds = usePinnedAppsStoreBase.getState().pinnedAppIds;
  const next = loadState();
  usePinnedAppsStoreBase.setState(next);

  /* Announce pins that went away, whoever removed them. An app open in this
     tab has to close when its pin is cleared in another one, which is what
     `use-active-app-pin-sync` listens for; without this the panel would sit
     there belonging to a pin that no longer exists. */
  for (const appId of previousIds) {
    if (!next.pinnedAppIds.has(appId)) {
      for (const listener of unpinListeners) {
        listener(appId);
      }
    }
  }
});

export const usePinnedAppsStore = createSelectors(usePinnedAppsStoreBase);
