/**
 * Header-slot state for {@link IntelligenceLayout}'s section chrome.
 *
 * A section page under the layout (Library, Schedules, ...) can hang a
 * control off the trailing edge of the layout's heading row, the row that
 * carries the back chevron and the section's <h1>. The page registers the
 * node from a `useEffect` and clears it on unmount, the same contract the
 * chat layout's top-bar slots follow.
 *
 * A store rather than outlet context for the reason `chat-layout-slots-store`
 * gives: the page sits under `ActiveAssistantGate`, whose `<Outlet />` is
 * the nearest one and publishes no context, so a setter the layout handed
 * down through its own outlet would never reach the page.
 *
 * @see https://reactrouter.com/start/framework/outlet
 */

import { create } from "zustand";
import type { ReactNode } from "react";

import { createSelectors } from "@/utils/create-selectors";

interface IntelligenceLayoutSlotsState {
  /** Rendered on the right of the section heading row; null leaves it empty. */
  headerTrailing: ReactNode;
}

interface IntelligenceLayoutSlotsActions {
  setHeaderTrailing: (node: ReactNode) => void;
}

type IntelligenceLayoutSlotsStore = IntelligenceLayoutSlotsState &
  IntelligenceLayoutSlotsActions;

const useIntelligenceLayoutSlotsStoreBase =
  create<IntelligenceLayoutSlotsStore>((set) => ({
    headerTrailing: null,
    setHeaderTrailing: (headerTrailing) => set({ headerTrailing }),
  }));

export const useIntelligenceLayoutSlotsStore = createSelectors(
  useIntelligenceLayoutSlotsStoreBase,
);
