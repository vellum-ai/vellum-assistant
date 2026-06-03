/**
 * Zustand store holding the observable state of a single live-voice session.
 *
 * Web-app counterpart to the `@Observable` fields on the macOS
 * `LiveVoiceChannelManager` (`clients/macos/.../LiveVoiceChannelManager.swift`).
 * The {@link useLiveVoice} controller owns the session lifecycle and writes here
 * through the actions; UI subscribes via per-field selectors so it only
 * re-renders on the fields it reads.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * **Primary API** — per-field selectors:
 * ```ts
 * const state = useLiveVoiceStore.use.state();
 * ```
 *
 * **Non-React code** — use `.getState()` in callbacks, effects, handlers:
 * ```ts
 * const { state } = useLiveVoiceStore.getState();
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

/**
 * Phase of the live-voice session. Mirrors the macOS
 * `LiveVoiceChannelManager.State` enum 1:1.
 *
 * - `idle` — no session (or a finished one cleaned up).
 * - `connecting` — minting a token / opening the socket, before `ready`.
 * - `listening` — mic is capturing and streaming PCM to the server.
 * - `transcribing` — push-to-talk released; waiting on the final transcript.
 * - `thinking` — server is generating the assistant response.
 * - `speaking` — TTS audio is queued/playing.
 * - `ending` — graceful teardown in progress.
 * - `failed` — the session failed; `error` carries the message.
 */
export type LiveVoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ending"
  | "failed";

export interface LiveVoiceState {
  /** Current phase of the session lifecycle. */
  state: LiveVoiceSessionState;
  /** In-flight partial transcript of the user's current utterance. */
  partialTranscript: string;
  /** Last finalized user transcript. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. */
  assistantTranscript: string;
  /** Smoothed RMS mic amplitude in [0, 1] for UI / barge-in. */
  inputAmplitude: number;
  /** Human-readable error message when `state === "failed"`, `null` otherwise. */
  error: string | null;
}

export interface LiveVoiceActions {
  /** Replace the session phase. */
  setState: (state: LiveVoiceSessionState) => void;
  setPartialTranscript: (text: string) => void;
  setFinalTranscript: (text: string) => void;
  /** Append a delta to the accumulated assistant transcript. */
  appendAssistantTranscript: (delta: string) => void;
  /** Reset the assistant transcript ahead of a new response. */
  clearAssistantTranscript: () => void;
  setInputAmplitude: (amplitude: number) => void;
  /** Transition to `failed` with a message. */
  fail: (message: string) => void;
  /** Reset every field back to the idle defaults. */
  reset: () => void;
}

export type LiveVoiceStore = LiveVoiceState & LiveVoiceActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const INITIAL_STATE: LiveVoiceState = {
  state: "idle",
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  error: null,
};

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_STATE,

  setState: (state) => set({ state }),
  setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
  setFinalTranscript: (finalTranscript) => set({ finalTranscript }),
  appendAssistantTranscript: (delta) =>
    set((s) => ({ assistantTranscript: s.assistantTranscript + delta })),
  clearAssistantTranscript: () => set({ assistantTranscript: "" }),
  setInputAmplitude: (inputAmplitude) => set({ inputAmplitude }),
  fail: (message) => set({ state: "failed", error: message }),
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useLiveVoiceStore = createSelectors(useLiveVoiceStoreBase);
