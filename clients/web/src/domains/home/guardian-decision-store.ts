import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/** The decisions a guardian can submit on a pending approval. */
export type GuardianDecisionAction = "approve_once" | "reject";

/**
 * How a decision settled: what was decided on which request, whether the
 * daemon applied it, and if not, the reason it gave.
 */
export interface GuardianDecisionOutcome {
  requestId: string;
  action: GuardianDecisionAction;
  applied: boolean;
  reason?: string;
}

export interface GuardianDecisionState {
  /** Every settled decision this session, by request id. */
  outcomes: ReadonlyMap<string, GuardianDecisionOutcome>;
}

export interface GuardianDecisionActions {
  recordOutcome: (outcome: GuardianDecisionOutcome) => void;
  reset: () => void;
}

export type GuardianDecisionStore = GuardianDecisionState &
  GuardianDecisionActions;

/**
 * What became of each guardian request decided this session, shared by
 * every surface that decides one (the bell's rows, a request's detail card).
 *
 * The feed is the owner of a request's state, and the daemon writes a
 * decision's outcome back into it; this store holds only the window between
 * a response and that write, so a request decided from one surface reads as
 * decided on every other before the feed catches up. Session-scoped on
 * purpose: nothing here outlives what the feed will shortly project.
 */
const useGuardianDecisionStoreBase = create<GuardianDecisionStore>()((set) => ({
  outcomes: new Map(),
  recordOutcome: (outcome) =>
    set((state) => {
      const outcomes = new Map(state.outcomes);
      outcomes.set(outcome.requestId, outcome);
      return { outcomes };
    }),
  reset: () => set({ outcomes: new Map() }),
}));

export const useGuardianDecisionStore = createSelectors(
  useGuardianDecisionStoreBase,
);
