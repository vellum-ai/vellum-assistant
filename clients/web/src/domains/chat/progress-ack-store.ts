import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Which finished plans the user has actually looked at.
 *
 * The progress control is on screen while a plan is running, and stays after
 * one finishes until the user has seen the outcome. Leaving on completion would
 * take the result away at the moment it is worth reading.
 *
 * A finished plan therefore holds the control open until it is acknowledged,
 * and acknowledgement means the user opened it while it was finished. Keyed by
 * the plan's own `surfaceId`, so the next plan on the same thread gets its own
 * turn rather than inheriting the last one's.
 *
 * In-memory and unpersisted: "did you see the thing that just happened" is a
 * fact about this session. `ProgressCard` seeds this for plans it never watched
 * run, so history arrives already acknowledged.
 */
interface ProgressAckState {
  acknowledged: ReadonlySet<string>;
}

interface ProgressAckActions {
  /** Records that the user has seen this plan's finished state. */
  acknowledge: (surfaceId: string) => void;
}

const useProgressAckStoreBase = create<ProgressAckState & ProgressAckActions>(
  (set) => ({
    acknowledged: new Set<string>(),
    acknowledge: (surfaceId) =>
      set((state) => {
        if (state.acknowledged.has(surfaceId)) {
          return state;
        }
        const next = new Set(state.acknowledged);
        next.add(surfaceId);
        return { acknowledged: next };
      }),
  }),
);

export const useProgressAckStore = createSelectors(useProgressAckStoreBase);
