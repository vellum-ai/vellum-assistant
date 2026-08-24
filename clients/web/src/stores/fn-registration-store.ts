import { create } from "zustand";

/**
 * Whether the desktop helper is actually watching Fn.
 *
 * Registration is a request to the host and it can be refused: the helper
 * needs Input Monitoring, and a user who never granted it has a binding that
 * cannot fire. Nothing in the DOM can observe that, so the hook that registers
 * publishes the answer here and the settings card reads it.
 *
 * This exists because the card is the only place that can do anything useful
 * with the failure. Fn is offered there as the recommended binding, and an
 * offer the host has already refused is worse than no offer: the user sees a
 * selected option, presses the key, and nothing happens. Silently binding
 * something else instead would be worse still, since the card would then show
 * one binding while another was live.
 *
 * `null` means no attempt has been made (Fn is not the current binding, or the
 * host has no helper at all), which is not the same as a refusal.
 *
 * Top-level rather than in the voice domain because the two sides live in
 * different domains: chat registers, settings reports.
 */
interface FnRegistrationState {
  registered: boolean | null;
  setRegistered: (registered: boolean | null) => void;
}

export const useFnRegistrationStore = create<FnRegistrationState>()((set) => ({
  registered: null,
  setRegistered: (registered) => set({ registered }),
}));
