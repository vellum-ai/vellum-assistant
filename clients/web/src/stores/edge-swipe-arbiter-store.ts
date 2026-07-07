import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Arbitrates the single left-edge swipe gesture between its two meanings so a
 * touch resolves to exactly one action for the current route.
 *
 * Both `useEdgeSwipeBack` and `useEdgeSwipeDrawer` attach `document`-level
 * touch listeners, so on a route that mounts a back-swipe (a pushed/detail
 * page) *inside* a layout that also offers swipe-to-open-menu (the chat
 * shell), a single left-edge swipe would otherwise fire both. The back
 * gesture is the more specific intent and wins: each enabled back-swipe owner
 * registers here, and the drawer gesture suppresses itself while any are
 * active. The result is the iOS navigation-stack model — a pushed page pops,
 * the stack root reveals the menu.
 *
 * A count (not a boolean) tolerates brief mount overlaps during route
 * transitions, when an outgoing owner has not yet unmounted as the incoming
 * one registers.
 */
interface EdgeSwipeArbiterState {
  backOwnerCount: number;
}

interface EdgeSwipeArbiterActions {
  registerBackOwner: () => void;
  unregisterBackOwner: () => void;
}

const useEdgeSwipeArbiterStoreBase = create<
  EdgeSwipeArbiterState & EdgeSwipeArbiterActions
>((set) => ({
  backOwnerCount: 0,
  registerBackOwner: () =>
    set((state) => ({ backOwnerCount: state.backOwnerCount + 1 })),
  unregisterBackOwner: () =>
    set((state) => ({
      backOwnerCount: Math.max(0, state.backOwnerCount - 1),
    })),
}));

export const useEdgeSwipeArbiterStore = createSelectors(
  useEdgeSwipeArbiterStoreBase,
);
