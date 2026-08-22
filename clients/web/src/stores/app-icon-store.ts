/**
 * The shell's alternate-app-icon snapshot, shared by every `useAppIconSync`
 * consumer.
 *
 * This is one fact about one device, and more than one surface asks about it:
 * the root match prompt and the settings card are mounted at the same time
 * whenever the Privacy page is open. Held per hook instance, an apply from one
 * leaves the other reporting the icon that was applied before it, so the card
 * keeps offering "Match avatar" for an icon that is already on the home screen
 * and pressing it fires a second iOS swap alert. Held here, both re-render on
 * the same write.
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
