import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/** The decisions a guardian can submit on a pending approval. */
export type GuardianDecisionAction = "approve_once" | "reject";

/**
 * How a decision settled: what was decided on which request, whether the
 * daemon recorded it, whether it applied, and if not, the reason it gave.
 */
export interface GuardianDecisionOutcome {
  requestId: string;
  action: GuardianDecisionAction;
  /**
   * Whether the daemon recorded the decision. True for an applied decision,
   * and for one whose follow-through failed after the commit; false for
   * every decline that left the request as it was.
   */
  committed: boolean;
  applied: boolean;
  reason?: string;
}

export interface GuardianDecisionState {
  /** Every settled decision this session, by request id. */
  outcomes: ReadonlyMap<string, GuardianDecisionOutcome>;
  /** Requests with a decision in flight, from any surface. */
  pendingRequestIds: ReadonlySet<string>;
}

export interface GuardianDecisionActions {
  markPending: (requestId: string) => void;
  clearPending: (requestId: string) => void;
  recordOutcome: (outcome: GuardianDecisionOutcome) => void;
  reset: () => void;
}

export type GuardianDecisionStore = GuardianDecisionState &
  GuardianDecisionActions;

/**
 * What is happening to each guardian request decided this session, shared
 * by every surface that decides one (the bell's rows, a request's detail
 * card): which requests have a decision in flight, and what became of the
 * ones that settled.
 *
 * The feed is the owner of a request's state, and the daemon writes a
 * decision's outcome back into it; this store holds only the window between
 * a click and that write, so a request being decided or decided from one
 * surface reads that way on every other before the feed catches up.
 * Session-scoped on purpose: nothing here outlives what the feed will
 * shortly project.
 */
const useGuardianDecisionStoreBase = create<GuardianDecisionStore>()((set) => ({
  outcomes: new Map(),
  pendingRequestIds: new Set(),
  markPending: (requestId) =>
    set((state) => {
      const pendingRequestIds = new Set(state.pendingRequestIds);
      pendingRequestIds.add(requestId);
      return { pendingRequestIds };
    }),
  clearPending: (requestId) =>
    set((state) => {
      const pendingRequestIds = new Set(state.pendingRequestIds);
      pendingRequestIds.delete(requestId);
      return { pendingRequestIds };
    }),
  recordOutcome: (outcome) =>
    set((state) => {
      const outcomes = new Map(state.outcomes);
      outcomes.set(outcome.requestId, outcome);
      return { outcomes };
    }),
  reset: () => set({ outcomes: new Map(), pendingRequestIds: new Set() }),
}));

export const useGuardianDecisionStore = createSelectors(
  useGuardianDecisionStoreBase,
);
