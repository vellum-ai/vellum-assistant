import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Which finished plans the user has actually looked at.
 *
 * The progress control is only on screen while it has something to say: a plan
 * is running, or a plan has finished and the user hasn't seen the outcome yet.
 * Without that second half the control would vanish the instant the work
 * completed, which is the one moment it is most worth reading — you would
 * watch it disappear and never learn how it went.
 *
 * So a finished plan holds the control open until it is acknowledged, and
 * acknowledgement means the user opened it while it was finished. Keyed by the
 * plan's own `surfaceId`, so the next plan on the same thread gets its own
 * turn rather than inheriting the last one's.
 *
 * Deliberately in-memory and not persisted: "did you see the thing that just
 * happened" is a fact about this session. On reload there is no live turn to
 * be mid-flight, and resurfacing a finished plan from yesterday would be
 * noise, so the set starting empty costs nothing — the surface only shows for
 * plans this session actually produced.
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
