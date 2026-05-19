/**
 * Zustand store for the turn state machine.
 *
 * Wraps the pure `turnReducer` in a Zustand store so consumers can
 * subscribe to specific slices via selectors, avoiding unnecessary
 * re-renders during high-frequency streaming updates (~50 ms cadence).
 *
 * Non-React code (stream handlers, reconciliation callbacks) can read
 * the latest state synchronously via `useTurnStore.getState()` —
 * replacing the manual `turnStateRef` pattern.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import {
  type DomainEvent,
  type TurnState,
  INITIAL_TURN_STATE,
  turnReducer,
} from "@/domains/chat/lib/turn-state-machine.js";

interface TurnStore extends TurnState {
  /** Dispatch a domain event through the turn reducer. */
  dispatch: (event: DomainEvent) => void;
}

export const useTurnStore = create<TurnStore>()((set) => ({
  ...INITIAL_TURN_STATE,
  dispatch: (event) =>
    set((state) => {
      const next = turnReducer(state, event);
      return next === state ? state : next;
    }),
}));
