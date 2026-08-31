import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * How many in-transcript agent controls are currently on screen.
 *
 * The same agents appear twice: inline, where the turn spawned them, and in the
 * floating status cluster. Both are useful, but not at the same time: two
 * copies of one control on one screen is just noise, and the floating one is
 * the redundant copy whenever you can already see the real thing in the thread.
 *
 * So the inline controls report their visibility here and the floating one
 * stands down while any of them is showing. A count rather than a boolean
 * because a single message can spawn several groups and a long thread can have
 * several on screen at once: the floating control comes back only when the last
 * of them has scrolled away.
 *
 * In-memory and unkeyed by conversation: it describes what is on screen right
 * now, and switching threads unmounts every inline control, which decrements
 * this back to zero on the way out.
 */
interface InlineAgentsVisibilityState {
  visibleCount: number;
}

interface InlineAgentsVisibilityActions {
  /** Balanced pair; call `release` from the same effect's cleanup. */
  acquire: () => void;
  release: () => void;
}

const useInlineAgentsVisibilityStoreBase = create<
  InlineAgentsVisibilityState & InlineAgentsVisibilityActions
>((set) => ({
  visibleCount: 0,
  acquire: () => set((s) => ({ visibleCount: s.visibleCount + 1 })),
  // Floored at zero: a double release (a remount racing its own cleanup) must
  // not push the count negative and strand the floating control hidden.
  release: () =>
    set((s) => ({ visibleCount: Math.max(0, s.visibleCount - 1) })),
}));

export const useInlineAgentsVisibilityStore = createSelectors(
  useInlineAgentsVisibilityStoreBase,
);

/** Whether any inline agent control is on screen right now. */
export function useAnyInlineAgentsVisible(): boolean {
  return useInlineAgentsVisibilityStore((s) => s.visibleCount > 0);
}
