/**
 * Header-slot state for {@link IntelligenceLayout}'s section chrome.
 *
 * A section page under the layout (Library, Schedules, ...) can hang a
 * control off the trailing edge of the layout's heading row, the row that
 * carries the back chevron and the section's <h1>, and can report that its
 * detail is a pushed screen so the layout aims its Back at the section's
 * list. The page registers each from an effect and clears it on unmount,
 * the same contract the chat layout's top-bar slots follow.
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
  /**
   * True while a section page's detail is a pushed full screen with the
   * section's list behind it. The page owns this because it measures the pane
   * the list would otherwise sit in, and the layout renders its one Back from
   * it: set, Back returns to the section's list, unless the path already is
   * that list; clear, Back returns to the assistant overview.
   */
  detailIsScreen: boolean;
}

interface IntelligenceLayoutSlotsActions {
  setHeaderTrailing: (node: ReactNode) => void;
  setDetailIsScreen: (value: boolean) => void;
}

type IntelligenceLayoutSlotsStore = IntelligenceLayoutSlotsState &
  IntelligenceLayoutSlotsActions;

const useIntelligenceLayoutSlotsStoreBase =
  create<IntelligenceLayoutSlotsStore>((set) => ({
    headerTrailing: null,
    detailIsScreen: false,
    setHeaderTrailing: (headerTrailing) => set({ headerTrailing }),
    setDetailIsScreen: (detailIsScreen) => set({ detailIsScreen }),
  }));

export const useIntelligenceLayoutSlotsStore = createSelectors(
  useIntelligenceLayoutSlotsStoreBase,
);
