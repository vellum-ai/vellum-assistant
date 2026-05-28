/**
 * Zustand store for the live voice mode state machine.
 *
 * Mirrors the macOS `LiveVoiceChannelManager.State` enum
 * (see `clients/macos/vellum-assistant/Features/Voice/LiveVoiceChannelManager.swift`)
 * so the web client tracks the same lifecycle:
 * off → connecting → listening → transcribing → thinking → speaking →
 * ending, with a `failed` branch for error states.
 *
 * Holds the session id, conversation id, rolling transcripts, current
 * input amplitude, and the most recent error message. All fields are
 * primitives so per-field selectors via `createSelectors` give minimal
 * re-renders.
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

export type LiveVoiceState =
  | "off"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ending"
  | "failed";

export interface LiveVoiceStoreState {
  /** Current phase of the live voice lifecycle. */
  state: LiveVoiceState;
  /** Server-assigned session id for the active live voice channel. */
  sessionId: string | null;
  /** Conversation id the session is currently attached to. */
  conversationId: string | null;
  /** In-progress user transcript from the STT stream. */
  partialTranscript: string;
  /** Finalized user transcript for the current turn. */
  finalTranscript: string;
  /** Rolling assistant transcript accumulated from streamed deltas. */
  assistantTranscript: string;
  /** Most recent microphone input amplitude in [0, 1]. */
  inputAmplitude: number;
  /** Most recent error message; empty string when there is no error. */
  errorMessage: string;
}

export interface LiveVoiceStoreActions {
  setState: (s: LiveVoiceState) => void;
  setSessionInfo: (info: {
    sessionId: string | null;
    conversationId: string | null;
  }) => void;
  setPartialTranscript: (text: string) => void;
  setFinalTranscript: (text: string) => void;
  appendAssistantTranscript: (delta: string) => void;
  clearAssistantTranscript: () => void;
  setInputAmplitude: (amp: number) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export type LiveVoiceStore = LiveVoiceStoreState & LiveVoiceStoreActions;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_STATE: LiveVoiceStoreState = {
  state: "off",
  sessionId: null,
  conversationId: null,
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  errorMessage: "",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_STATE,

  setState: (s) => set({ state: s }),

  setSessionInfo: ({ sessionId, conversationId }) =>
    set({ sessionId, conversationId }),

  setPartialTranscript: (text) => set({ partialTranscript: text }),

  setFinalTranscript: (text) => set({ finalTranscript: text }),

  appendAssistantTranscript: (delta) =>
    set((prev) => ({ assistantTranscript: prev.assistantTranscript + delta })),

  clearAssistantTranscript: () => set({ assistantTranscript: "" }),

  setInputAmplitude: (amp) => set({ inputAmplitude: amp }),

  setError: (msg) => set({ errorMessage: msg }),

  reset: () => set(INITIAL_STATE),
}));

export const useLiveVoiceStore = createSelectors(useLiveVoiceStoreBase);
