import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Whether the mobile chat drawer currently occupies the screen, published so
 * surfaces outside `ChatLayout` can stand down while it does.
 *
 * The drawer is an overlay, not a route change: the chat page stays mounted
 * underneath it. Anything that decorates the chat page from a `document.body`
 * portal therefore keeps rendering, and keeps painting, over the navigation.
 * Z-index cannot arbitrate that, because a body portal and the app subtree sit
 * in different stacking contexts. `ComposerPeek` is the one such surface today.
 *
 * True from the moment a swipe starts dragging the drawer in, not only once it
 * commits open, so a peeked-then-abandoned drawer is covered too.
 */
interface MobileDrawerState {
  /** The drawer is open, or a swipe is currently dragging it in. */
  presented: boolean;
}

interface MobileDrawerActions {
  setPresented: (presented: boolean) => void;
}

const useMobileDrawerStoreBase = create<
  MobileDrawerState & MobileDrawerActions
>((set) => ({
  presented: false,
  setPresented: (presented) =>
    set((state) => (state.presented === presented ? state : { presented })),
}));

export const useMobileDrawerStore = createSelectors(useMobileDrawerStoreBase);
