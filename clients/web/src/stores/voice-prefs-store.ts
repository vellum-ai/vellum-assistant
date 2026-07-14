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

/**
 * "Interrupt sensitivity" — how easily the user's speech cuts off the
 * assistant mid-reply. Higher sensitivity interrupts sooner (less sustained
 * speech required); lower is more forgiving of coughs, filler words, and the
 * assistant's own TTS bleeding through imperfect echo cancellation. Maps to the
 * daemon's `bargeInMinSpeechMs` — note the mapping is *inverse* (more sensitive
 * ⇒ fewer ms). See {@link INTERRUPT_SENSITIVITY_TO_MS}.
 */
export type InterruptSensitivity = "low" | "medium" | "high";

/** Default "pause before reply" (ms) — mirrors the daemon `liveVoice.vad.silenceThresholdMs` default. */
export const DEFAULT_PAUSE_BEFORE_REPLY_MS = 1200;
/** Bounds for the "pause before reply" slider (ms); stays inside the daemon's accepted range. */
export const MIN_PAUSE_BEFORE_REPLY_MS = 500;
export const MAX_PAUSE_BEFORE_REPLY_MS = 3000;

/** Default interrupt sensitivity — the ms value mirrors the daemon `bargeInMinSpeechMs` default (250). */
export const DEFAULT_INTERRUPT_SENSITIVITY: InterruptSensitivity = "medium";

/**
 * Interrupt-sensitivity level → sustained-speech ms sent as `bargeInMinSpeechMs`.
 * Inverse: a *higher* sensitivity needs *less* speech to barge in.
 */
export const INTERRUPT_SENSITIVITY_TO_MS: Record<InterruptSensitivity, number> =
  {
    high: 100,
    medium: 250,
    low: 600,
  };

/** Resolve an interrupt-sensitivity level to the `bargeInMinSpeechMs` it sends. */
export function interruptSensitivityToMs(level: InterruptSensitivity): number {
  return INTERRUPT_SENSITIVITY_TO_MS[level];
}

/**
 * Clamp a "pause before reply" value to the supported range and round to a
 * whole millisecond, so neither the slider nor a stale persisted value can send
 * an out-of-range `silenceThresholdMs` the daemon would reject.
 */
export function clampPauseBeforeReplyMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_PAUSE_BEFORE_REPLY_MS;
  return Math.round(
    Math.min(
      MAX_PAUSE_BEFORE_REPLY_MS,
      Math.max(MIN_PAUSE_BEFORE_REPLY_MS, ms),
    ),
  );
}

export interface VoicePrefsState {
  /** Whether the user-side transcript is shown in the voice UI. */
  showUserTranscript: boolean;
  /** Whether the assistant-side transcript is shown in the voice UI. */
  showAssistantTranscript: boolean;
  /** True once the user has seen the first-run voice experience. */
  firstRunSeen: boolean;
  /**
   * Trailing-silence duration (ms) after the user stops speaking before the
   * assistant replies — the "pause before reply" setting. Sent as the session's
   * `silenceThresholdMs`. A longer pause tolerates mid-thought pauses without
   * the assistant jumping in.
   */
  pauseBeforeReplyMs: number;
  /** How easily the user can interrupt the assistant mid-reply. */
  interruptSensitivity: InterruptSensitivity;
}

export interface VoicePrefsActions {
  setShowUserTranscript: (next: boolean) => void;
  setShowAssistantTranscript: (next: boolean) => void;
  /** Flip `firstRunSeen` to true on first observation. No-op afterwards. */
  markFirstRunSeen: () => void;
  setPauseBeforeReplyMs: (next: number) => void;
  setInterruptSensitivity: (next: InterruptSensitivity) => void;
}

export type VoicePrefsStore = VoicePrefsState & VoicePrefsActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: VoicePrefsState = {
  showUserTranscript: false,
  showAssistantTranscript: false,
  firstRunSeen: false,
  pauseBeforeReplyMs: DEFAULT_PAUSE_BEFORE_REPLY_MS,
  interruptSensitivity: DEFAULT_INTERRUPT_SENSITIVITY,
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
      setPauseBeforeReplyMs: (next: number) =>
        set({
          pauseBeforeReplyMs: clampPauseBeforeReplyMs(next),
        }),
      setInterruptSensitivity: (next: InterruptSensitivity) =>
        set({ interruptSensitivity: next }),
    }),
    {
      name: VOICE_PREFS_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        showUserTranscript: state.showUserTranscript,
        showAssistantTranscript: state.showAssistantTranscript,
        firstRunSeen: state.firstRunSeen,
        pauseBeforeReplyMs: state.pauseBeforeReplyMs,
        interruptSensitivity: state.interruptSensitivity,
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
