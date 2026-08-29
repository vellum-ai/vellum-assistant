import { create } from "zustand";

import type { SetupIntentOutcome } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { createSelectors } from "@/utils/create-selectors";

/**
 * The 3DS redirect return, held outside the cards that render it.
 *
 * Stripe sends the user back to a freshly loaded billing page, where resolving
 * the SetupIntent takes a Stripe.js read plus a server-side confirm whose
 * webhook-poll fallback runs for up to 20 seconds. Every consumer of that
 * outcome sits inside the billing tab panel, which unmounts the moment the
 * user switches to Usage, so the state lives here instead: the resolution
 * writes into the store and a panel picks it up whenever it mounts.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */
interface SetupIntentReturnState {
  /**
   * True from reading Stripe's redirect params until the outcome settles. The
   * outcome is replayed into a modal opened for it, so the cards gate their
   * add-a-card actions on this to keep a competing modal from opening first.
   */
  pending: boolean;
  outcome: SetupIntentOutcome | null;
  /**
   * The request scope the settled outcome was produced under. This store is
   * module level and survives the user or organization switch that remounts
   * the request-scoped `QueryClient`, so consumers compare this against the
   * scope in hand before replaying a saved card or invalidating a cache.
   */
  scopeKey: string | null;
}

interface SetupIntentReturnActions {
  beginResolving: () => void;
  settleOutcome: (outcome: SetupIntentOutcome, scopeKey: string) => void;
  discardResolution: () => void;
  clearOutcome: () => void;
}

const useSetupIntentReturnStoreBase = create<
  SetupIntentReturnState & SetupIntentReturnActions
>()((set) => ({
  pending: false,
  outcome: null,
  scopeKey: null,

  beginResolving: () => set({ pending: true, outcome: null, scopeKey: null }),
  settleOutcome: (outcome, scopeKey) =>
    set({ pending: false, outcome, scopeKey }),
  // The return resolved for an identity that is no longer on screen, so it
  // ends the pending window without publishing anything to replay.
  discardResolution: () =>
    set({ pending: false, outcome: null, scopeKey: null }),
  // `pending` is left alone: a cleared outcome is a resolved return, not one
  // that went back to being in flight.
  clearOutcome: () => set({ outcome: null, scopeKey: null }),
}));

export const useSetupIntentReturnStore = createSelectors(
  useSetupIntentReturnStoreBase,
);
