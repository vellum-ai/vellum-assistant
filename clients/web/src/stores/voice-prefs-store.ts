/**
 * Zustand store for live-voice mode preferences.
 *
 * Owns whether the user- and assistant-side transcripts are shown in
 * the voice UI, plus a one-time flag recording that the user has seen
 * the first-run voice experience. Voice-mode components read these via
 * the generated selector hooks (`useVoicePrefsStore.use.*`).
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the whole voice-prefs slice into
 *   a single localStorage key, `vellum:voice-prefs`.
 * - Cross-tab updates: the persist middleware doesn't sync across tabs
 *   on its own. We listen for `storage` events on `vellum:voice-prefs`
 *   and call `persist.rehydrate()` to pull in the other tab's write.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface VoicePrefsState {
  /** Whether the user-side transcript is shown in the voice UI. */
  showUserTranscript: boolean;
  /** Whether the assistant-side transcript is shown in the voice UI. */
  showAssistantTranscript: boolean;
  /** True once the user has seen the first-run voice experience. */
  firstRunSeen: boolean;
}

export interface VoicePrefsActions {
  setShowUserTranscript: (next: boolean) => void;
  setShowAssistantTranscript: (next: boolean) => void;
  /** Flip `firstRunSeen` to true on first observation. No-op afterwards. */
  markFirstRunSeen: () => void;
}

export type VoicePrefsStore = VoicePrefsState & VoicePrefsActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: VoicePrefsState = {
  showUserTranscript: false,
  showAssistantTranscript: false,
  firstRunSeen: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const VOICE_PREFS_STORE_KEY = "vellum:voice-prefs";

const useVoicePrefsStoreBase = create<VoicePrefsStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

      setShowUserTranscript: (next: boolean) =>
        set({ showUserTranscript: next }),
      setShowAssistantTranscript: (next: boolean) =>
        set({ showAssistantTranscript: next }),
      markFirstRunSeen: () => {
        if (!get().firstRunSeen) {
          set({ firstRunSeen: true });
        }
      },
    }),
    {
      name: VOICE_PREFS_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        showUserTranscript: state.showUserTranscript,
        showAssistantTranscript: state.showAssistantTranscript,
        firstRunSeen: state.firstRunSeen,
      }),
    },
  ),
);

export const useVoicePrefsStore = createSelectors(useVoicePrefsStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === VOICE_PREFS_STORE_KEY) {
      void useVoicePrefsStoreBase.persist.rehydrate();
    }
  });
}
