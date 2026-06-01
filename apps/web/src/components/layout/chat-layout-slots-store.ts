/**
 * Header-slot state for `ChatLayout`'s shared `ChatLayoutHeader`.
 *
 * Routes under `ChatLayout` populate the header's center, right
 * section, and search-icon handler. The setters are actions on this
 * store; consumers register their content from a `useEffect` and
 * clear it on unmount.
 *
 * Why a store instead of outlet context: routes under
 * `ActiveAssistantGate` see the gate's `<Outlet />` as their nearest
 * outlet, which wraps the matched child in
 * `<OutletContext.Provider value={undefined}>` — gated routes
 * therefore can't read a setter that `ChatLayout` published through
 * its own outlet context. A module-level store sidesteps the whole
 * Provider-stacking problem and matches the convention that
 * cross-route state lives in Zustand.
 *
 * @see https://reactrouter.com/start/framework/outlet
 */

import { create } from "zustand";
import type { ReactNode } from "react";

import { createSelectors } from "@/utils/create-selectors";

interface ChatLayoutSlotsState {
  topBarCenter: ReactNode;
  topBarRightSlot: ReactNode;
  onSearchClick: (() => void) | null;
}

interface ChatLayoutSlotsActions {
  setTopBarCenter: (node: ReactNode) => void;
  setTopBarRightSlot: (node: ReactNode) => void;
  setOnSearchClick: (cb: (() => void) | null) => void;
}

type ChatLayoutSlotsStore = ChatLayoutSlotsState & ChatLayoutSlotsActions;

const useChatLayoutSlotsStoreBase = create<ChatLayoutSlotsStore>((set) => ({
  topBarCenter: null,
  topBarRightSlot: null,
  onSearchClick: null,
  setTopBarCenter: (topBarCenter) => set({ topBarCenter }),
  setTopBarRightSlot: (topBarRightSlot) => set({ topBarRightSlot }),
  setOnSearchClick: (onSearchClick) => set({ onSearchClick }),
}));

export const useChatLayoutSlotsStore = createSelectors(
  useChatLayoutSlotsStoreBase,
);
