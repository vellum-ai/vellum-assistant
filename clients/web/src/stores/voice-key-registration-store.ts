import { create } from "zustand";

/**
 * Whether the desktop helper is actually watching the voice key.
 *
 * Registration is a request to the host and it can be refused: the helper
 * needs Input Monitoring, and a user who never granted it has a key that
 * cannot fire. Nothing in the DOM can observe that, so the hook that registers
 * publishes the answer here and the settings card reads it.
 *
 * This exists because the card is the only place that can do anything useful
 * with the failure. A refused key shows as a selected option the user presses
 * to no effect, and silently binding something else instead would be worse,
 * since the card would then show one key while another was live.
 *
 * `null` means no attempt has been made (the key is off, or the host has no
 * helper at all), which is not the same as a refusal.
 *
 * Top-level rather than in the voice domain because the two sides live in
 * different domains: chat registers, settings reports.
 */
interface VoiceKeyRegistrationState {
  registered: boolean | null;
  setRegistered: (registered: boolean | null) => void;
}

export const useVoiceKeyRegistrationStore = create<VoiceKeyRegistrationState>()(
  (set) => ({
    registered: null,
    setRegistered: (registered) => set({ registered }),
  }),
);
