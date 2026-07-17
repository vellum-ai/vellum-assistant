import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Arbitrates the left-edge drawer swipe against the other horizontal gestures
 * that share the same `document`-level touch stream, so a single touch
 * resolves to exactly one action for the current route.
 *
 * Two kinds of owner suppress the drawer while active:
 *
 * - **Back-swipe owners.** `useEdgeSwipeBack` attaches a `document`-level
 *   listener, so on a route that mounts a back-swipe (a pushed/detail page)
 *   *inside* a layout that also offers swipe-to-open-menu (the chat shell), a
 *   single left-edge swipe would otherwise fire both. The back gesture is the
 *   more specific intent and wins: each enabled back-swipe owner registers
 *   here, and the drawer suppresses itself while any are active. The result is
 *   the iOS navigation-stack model — a pushed page pops, the stack root
 *   reveals the menu.
 *
 * - **Open swipe-action rows.** A `SwipeActionReveal` row that is currently
 *   revealed owns the next horizontal swipe: the standard iOS table-row
 *   behaviour is that swiping an open row closes it, and the enclosing
 *   scroll/navigation container yields. Because the drawer arms across a wide
 *   activation band (`ACTIVATION_ZONE_VW_RATIO`), a rightward swipe to close a
 *   revealed row starts inside that band and would otherwise open the drawer
 *   instead. A revealed row registers here so the drawer stands down until it
 *   closes.
 *
 * Counts (not booleans) tolerate brief overlaps: route transitions where an
 * outgoing back-swipe owner has not yet unmounted as the incoming one
 * registers, and multiple rows momentarily mid-animation as one closes while
 * another opens.
 */
interface EdgeSwipeArbiterState {
  backOwnerCount: number;
  openRowCount: number;
}

interface EdgeSwipeArbiterActions {
  registerBackOwner: () => void;
  unregisterBackOwner: () => void;
  registerOpenRow: () => void;
  unregisterOpenRow: () => void;
}

const useEdgeSwipeArbiterStoreBase = create<
  EdgeSwipeArbiterState & EdgeSwipeArbiterActions
>((set) => ({
  backOwnerCount: 0,
  openRowCount: 0,
  registerBackOwner: () =>
    set((state) => ({ backOwnerCount: state.backOwnerCount + 1 })),
  unregisterBackOwner: () =>
    set((state) => ({
      backOwnerCount: Math.max(0, state.backOwnerCount - 1),
    })),
  registerOpenRow: () =>
    set((state) => ({ openRowCount: state.openRowCount + 1 })),
  unregisterOpenRow: () =>
    set((state) => ({
      openRowCount: Math.max(0, state.openRowCount - 1),
    })),
}));

export const useEdgeSwipeArbiterStore = createSelectors(
  useEdgeSwipeArbiterStoreBase,
);
