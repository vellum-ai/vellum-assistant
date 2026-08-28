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
}

interface SetupIntentReturnActions {
  beginResolving: () => void;
  settleOutcome: (outcome: SetupIntentOutcome) => void;
  clearOutcome: () => void;
}

const useSetupIntentReturnStoreBase = create<
  SetupIntentReturnState & SetupIntentReturnActions
>()((set) => ({
  pending: false,
  outcome: null,

  beginResolving: () => set({ pending: true, outcome: null }),
  settleOutcome: (outcome) => set({ pending: false, outcome }),
  // `pending` is left alone: a cleared outcome is a resolved return, not one
  // that went back to being in flight.
  clearOutcome: () => set({ outcome: null }),
}));

export const useSetupIntentReturnStore = createSelectors(
  useSetupIntentReturnStoreBase,
);
