/**
 * Zustand store for voice-recording state shared between the voice
 * input button and the chat composer.
 *
 * Owns the recording phase state machine: idle → recording → processing
 * → done → idle, with error branches. Auto-dismiss timers transition
 * `done` (800 ms) and `error` (3 s) back to `idle`.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * **Primary API** — per-field selectors:
 * ```ts
 * const phase = useVoiceRecordingStore.use.phase();
 * ```
 *
 * **Non-React code** — use `.getState()` in callbacks, effects, handlers:
 * ```ts
 * const { phase } = useVoiceRecordingStore.getState();
 * ```
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceRecordingPhase =
  | "idle"
  | "recording"
  | "processing"
  | "done"
  | "error";

export interface VoiceRecordingState {
  /** Current phase of the recording lifecycle. */
  phase: VoiceRecordingPhase;
  /** Error code when `phase === "error"`, `null` otherwise. */
  errorCode: string | null;
  /**
   * Live interim transcript while `phase === "recording"`, published by the
   * recording `VoiceInputButton` instance (streaming STT or Web Speech).
   * Global so window-level consumers — the Electron dictation overlay sync —
   * see partials regardless of which button instance (chat composer or the
   * global push-to-talk fallback) owns the session.
   */
  interimTranscript: string;
  /**
   * Smoothed live mic level in the range 0..1 while recording. Published
   * globally so the Electron dictation overlay can mirror the composer
   * waveform without opening a second capture graph.
   */
  audioLevel: number;
  /**
   * Front-app insertion failure (`dictation-automation-denied` /
   * `dictation-paste-blocked`) flagged during the current session. The
   * session still finalizes into `done` — the transcript soft-lands in the
   * composer — but the dictation overlay must show the error rather than a
   * success check. Cleared on the next `startRecording`.
   */
  dictationInsertionError: string | null;
}

export interface VoiceRecordingActions {
  startRecording: () => void;
  stopRecording: () => void;
  finalize: () => void;
  fail: (code: string) => void;
  reset: () => void;
  setInterimTranscript: (text: string) => void;
  setAudioLevel: (level: number) => void;
  flagDictationInsertionError: (code: string) => void;
}

export type VoiceRecordingStore = VoiceRecordingState & VoiceRecordingActions;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Duration (ms) that the "done" state is shown before auto-dismissing. */
const DONE_DISMISS_MS = 800;

/** Duration (ms) that the "error" state is shown before auto-dismissing. */
const ERROR_DISMISS_MS = 3000;

// ---------------------------------------------------------------------------
// Timer management (module-scoped — one recording session at a time)
// ---------------------------------------------------------------------------

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearDismissTimer() {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useVoiceRecordingStoreBase = create<VoiceRecordingStore>()((set) => ({
  phase: "idle",
  errorCode: null,
  interimTranscript: "",
  audioLevel: 0,
  dictationInsertionError: null,

  startRecording: () => {
    clearDismissTimer();
    set({
      phase: "recording",
      errorCode: null,
      interimTranscript: "",
      audioLevel: 0,
      dictationInsertionError: null,
    });
  },

  stopRecording: () => {
    clearDismissTimer();
    set({
      phase: "processing",
      errorCode: null,
      interimTranscript: "",
      audioLevel: 0,
    });
  },

  finalize: () => {
    clearDismissTimer();
    set({ phase: "done", errorCode: null });
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      set({ phase: "idle", errorCode: null });
    }, DONE_DISMISS_MS);
  },

  fail: (code: string) => {
    clearDismissTimer();
    set({ phase: "error", errorCode: code });
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      set({ phase: "idle", errorCode: null });
    }, ERROR_DISMISS_MS);
  },

  reset: () => {
    clearDismissTimer();
    set({
      phase: "idle",
      errorCode: null,
      interimTranscript: "",
      audioLevel: 0,
      dictationInsertionError: null,
    });
  },

  setInterimTranscript: (text: string) => {
    set({ interimTranscript: text });
  },

  setAudioLevel: (level: number) => {
    const clamped = Math.max(0, Math.min(1, level));
    set({ audioLevel: clamped });
  },

  flagDictationInsertionError: (code: string) => {
    set({ dictationInsertionError: code });
  },
}));

export const useVoiceRecordingStore = createSelectors(useVoiceRecordingStoreBase);
