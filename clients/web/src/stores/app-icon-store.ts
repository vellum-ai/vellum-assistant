/**
 * The shell's alternate-app-icon snapshot, shared by every `useAppIconSync`
 * consumer.
 *
 * This is one fact about one device: which alternate the home screen shows and
 * which ones the installed build carries. Holding it at module level keeps the
 * snapshot alive across mounts: navigating back to Settings renders the last
 * known answer immediately instead of a blank while the bridge round-trip
 * completes, and any future surface that mounts the hook reads the same
 * snapshot instead of racing its own.
 *
 * The store is a cache of what the shell last answered, never a wish: only
 * `useAppIconSync`'s refresh writes it, always from `getAppIconState()`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { AppIconState } from "@/runtime/app-icon";

/**
 * What every degrade path resolves to: no icon UI may draw. Spelled out here
 * rather than imported from `runtime/app-icon.ts`, because a value import from
 * that module runs its `registerPlugin` call at load time.
 */
export const APP_ICON_UNSUPPORTED: AppIconState = {
  supported: false,
  current: null,
  available: [],
};

interface AppIconStoreState {
  snapshot: AppIconState;
}

interface AppIconStoreActions {
  setSnapshot: (next: AppIconState) => void;
}

type AppIconStore = AppIconStoreState & AppIconStoreActions;

function isSameSnapshot(a: AppIconState, b: AppIconState): boolean {
  return (
    a.supported === b.supported &&
    a.current === b.current &&
    a.available.length === b.available.length &&
    a.available.every((name, index) => name === b.available[index])
  );
}

const useAppIconStoreBase = create<AppIconStore>()((set, get) => ({
  snapshot: APP_ICON_UNSUPPORTED,

  // Every mounted consumer refreshes on its own mount and on every foreground,
  // so identical answers arrive constantly. Keeping the reference stable stops
  // those from re-rendering the tree.
  setSnapshot: (next) => {
    if (!isSameSnapshot(get().snapshot, next)) {
      set({ snapshot: next });
    }
  },
}));

export const useAppIconStore = createSelectors(useAppIconStoreBase);
