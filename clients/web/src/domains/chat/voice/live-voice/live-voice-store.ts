/**
 * Zustand store holding the observable state of a single live-voice session.
 *
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
 * Phase of the live-voice session.
 *
 * - `idle` — no session (or a finished one cleaned up).
 * - `connecting` — minting a token / opening the socket, before `ready`.
 * - `listening` — mic is capturing and streaming PCM to the server.
 * - `transcribing` — user turn ended (push-to-talk released or server turn
 *   boundary); waiting on the final transcript.
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

/**
 * User-facing activity label per session state, shared by every surface that
 * shows session activity (the composer's voice bar and the title-bar session
 * pill), so the two always agree.
 *
 * Deliberately minimal treatment (decided 2026-07-06): assistant output
 * streams into the thread transcript like text chat, so surfaces only carry a
 * small label. `idle`/`failed` map to an empty label — hosts unmount their
 * voice UI in those states.
 */
export const LIVE_VOICE_STATE_LABELS: Record<LiveVoiceSessionState, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  ending: "Ending…",
  failed: "",
};

/**
 * Imperative controls for the active session, registered by the
 * {@link useLiveVoice} controller instance that owns it. Lets a globally
 * mounted component (e.g. the title-bar session pill) drive a session owned by
 * the composer's hook instance.
 */
export interface LiveVoiceSessionControls {
  /** End the voice session (release mic, socket, and audio). */
  stop: () => void;
  /**
   * Force-end the current user turn — a manual push-to-talk release, identical
   * to the automatic silence release (the green ↑ "send now" button). No-op
   * unless the session is `listening`.
   */
  release: () => void;
  /**
   * Stop in-flight assistant playback without the user having to speak. V1
   * behavior: same path as barge-in interrupt, which ends the session (a later
   * engine revision makes it turn-scoped). No-op unless the session is
   * `speaking`. Dormant until the turn-scoped interrupt lands (engine plan,
   * JARVIS-1240) — deliberately kept registered, but no surface wires it yet.
   */
  interrupt: () => void;
}

/**
 * Starts a live-voice session for `assistantId`, attaching `conversationId`
 * when non-null. Registered into the store by the persistently mounted
 * session-controller hook (see `use-live-voice-session-controller.ts`) so any
 * surface — e.g. the composer's entry-point mic — can start a session without
 * owning the controller hook instance.
 */
export type LiveVoiceSessionStarter = (
  assistantId: string,
  conversationId: string | null,
) => void;

export interface LiveVoiceState {
  /** Current phase of the session lifecycle. */
  state: LiveVoiceSessionState;
  /** Assistant the active session was started for, `null` when idle. */
  assistantId: string | null;
  /**
   * Conversation the active session is attached to, if any. Authoritative:
   * when a session starts without a conversation, the server assigns one and
   * this field is updated on the `ready` frame.
   */
  conversationId: string | null;
  /**
   * Conversation id the session was *started* with — `null` for a session
   * started without an attached conversation (a draft composer). Unlike
   * `conversationId`, this is never overwritten by the server's `ready`
   * frame, so the composer that started a draft session keeps matching it
   * (see {@link isLiveVoiceSessionOwnedBy}).
   */
  startedConversationId: string | null;
  /** Controls registered by the owning controller, `null` when no session. */
  controls: LiveVoiceSessionControls | null;
  /**
   * Session starter registered by the persistently mounted controller hook.
   * `null` only when no controller is mounted (e.g. outside the chat layout).
   * Mount-scoped, not session-scoped: {@link LiveVoiceActions.reset} leaves it
   * registered.
   */
  starter: LiveVoiceSessionStarter | null;
  /** In-flight partial transcript of the user's current utterance. */
  partialTranscript: string;
  /** Last finalized user transcript. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. */
  assistantTranscript: string;
  /** Smoothed RMS mic amplitude in [0, 1] for UI / barge-in. */
  inputAmplitude: number;
  /**
   * Machine reason from the last server `turn_cancelled` frame (e.g.
   * `empty_transcript`, `stt_failed`, `turn_failed`, `tts_failed`).
   * Non-fatal — the session resumed listening. Cleared when the next turn
   * is accepted and on reset.
   */
  turnCancelledReason: string | null;
  /** Human-readable error message when `state === "failed"`, `null` otherwise. */
  error: string | null;
}

export interface LiveVoiceActions {
  /** Replace the session phase. */
  setState: (state: LiveVoiceSessionState) => void;
  /**
   * Record which assistant/conversation the session was started for. Sets
   * both `conversationId` and `startedConversationId`; called once per
   * session, at start.
   */
  setSessionContext: (
    assistantId: string,
    conversationId: string | null,
  ) => void;
  /**
   * Republish the authoritative conversation id from the server's `ready`
   * frame. Leaves `startedConversationId` at its start-time value.
   */
  setConversationId: (conversationId: string) => void;
  /** Register (or clear) the owning controller's session controls. */
  setControls: (controls: LiveVoiceSessionControls | null) => void;
  /** Register (or clear) the mounted controller's session starter. */
  setStarter: (starter: LiveVoiceSessionStarter | null) => void;
  setPartialTranscript: (text: string) => void;
  setFinalTranscript: (text: string) => void;
  /** Append a delta to the accumulated assistant transcript. */
  appendAssistantTranscript: (delta: string) => void;
  /** Reset the assistant transcript ahead of a new response. */
  clearAssistantTranscript: () => void;
  /**
   * Reset the user transcripts (partial + final) ahead of a new utterance, so
   * multi-turn (hands-free) sessions key them to the current turn.
   */
  clearUserTranscripts: () => void;
  setInputAmplitude: (amplitude: number) => void;
  setTurnCancelledReason: (reason: string | null) => void;
  /** Transition to `failed` with a message. */
  fail: (message: string) => void;
  /**
   * Reset every session field back to the idle defaults. Deliberately leaves
   * `starter` registered — it belongs to the controller's mount lifecycle,
   * not the session lifecycle, and must survive session teardown so the next
   * session can start.
   */
  reset: () => void;
}

export type LiveVoiceStore = LiveVoiceState & LiveVoiceActions;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Whether `state` is a live session phase (anything but idle/failed). */
export function isLiveVoiceSessionActive(state: LiveVoiceSessionState): boolean {
  return state !== "idle" && state !== "failed";
}

/**
 * Whether the mic is live in `state` — capturing audio with amplitude flowing
 * into the store. True for the whole listening→speaking span: the capture
 * graph runs for the entire session so amplitude keeps flowing for barge-in
 * even while the assistant is transcribing/thinking/speaking (see
 * `use-live-voice.ts` "Mic forwarding"). False for `connecting` (capture not
 * started) and `ending`/terminal states (teardown).
 *
 * Drives the `active` flag of every session waveform (composer voice bar and
 * title-bar pill): the bars scroll in new samples exactly while the mic is
 * hot, and freeze otherwise.
 */
export function isLiveVoiceMicLive(state: LiveVoiceSessionState): boolean {
  return (
    state === "listening" ||
    state === "transcribing" ||
    state === "thinking" ||
    state === "speaking"
  );
}

/**
 * Whether the composer bound to `composerConversationId` owns the active
 * session — i.e. it is the surface whose action row swaps to the voice bar
 * (and whose title-bar pill therefore hides).
 *
 * A composer owns the session when its conversation matches either the
 * session's authoritative `conversationId` or the `startedConversationId` it
 * was started with. The second arm covers the draft case: a session started
 * from a composer with no conversation (`null`) gets a server-assigned
 * `conversationId` on `ready`, but the draft composer — still bound to no
 * conversation — must keep owning it until the user navigates away.
 *
 * Exactly one of {composer voice bar, title-bar pill} renders for an active
 * session: the composer shows its voice UI iff this returns `true` for it,
 * and the pill host shows the pill iff the currently visible composer (if
 * any) does not own the session.
 */
export function isLiveVoiceSessionOwnedBy(
  session: Pick<
    LiveVoiceState,
    "state" | "conversationId" | "startedConversationId"
  >,
  composerConversationId: string | null | undefined,
): boolean {
  if (!isLiveVoiceSessionActive(session.state)) {
    return false;
  }
  const composerId = composerConversationId ?? null;
  return (
    composerId === session.conversationId ||
    composerId === session.startedConversationId
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Session-scoped fields restored by `reset()`. Excludes `starter` (mount-scoped). */
const INITIAL_SESSION_STATE: Omit<LiveVoiceState, "starter"> = {
  state: "idle",
  assistantId: null,
  conversationId: null,
  startedConversationId: null,
  controls: null,
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  turnCancelledReason: null,
  error: null,
};

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_SESSION_STATE,
  starter: null,

  setState: (state) => set({ state }),
  setSessionContext: (assistantId, conversationId) =>
    set({ assistantId, conversationId, startedConversationId: conversationId }),
  setConversationId: (conversationId) => set({ conversationId }),
  setControls: (controls) => set({ controls }),
  setStarter: (starter) => set({ starter }),
  setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
  setFinalTranscript: (finalTranscript) => set({ finalTranscript }),
  appendAssistantTranscript: (delta) =>
    set((s) => ({ assistantTranscript: s.assistantTranscript + delta })),
  clearAssistantTranscript: () => set({ assistantTranscript: "" }),
  clearUserTranscripts: () => set({ partialTranscript: "", finalTranscript: "" }),
  setInputAmplitude: (inputAmplitude) => set({ inputAmplitude }),
  setTurnCancelledReason: (turnCancelledReason) => set({ turnCancelledReason }),
  fail: (message) => set({ state: "failed", error: message }),
  reset: () => set({ ...INITIAL_SESSION_STATE }),
}));

export const useLiveVoiceStore = createSelectors(useLiveVoiceStoreBase);

/**
 * Stable amplitude poll function for waveform canvases: sampled ~30 Hz inside
 * their draw loops, so amplitude must never flow through props/re-renders.
 * Module-level (not a per-component `useCallback`) so every surface shares the
 * one identity.
 */
export function getLiveVoiceInputAmplitude(): number {
  return useLiveVoiceStore.getState().inputAmplitude;
}

/**
 * End the active live-voice session through the store-registered
 * {@link LiveVoiceSessionControls}. No-op when no session (or no controls)
 * exists. Module-level so every surface with an "end session" affordance (the
 * composer's voice bar, the title-bar pill) shares one stable identity and
 * reads `controls` via `getState()` in the callback — subscribing to
 * `controls` just to call it would re-render on register/clear (see
 * STATE_MANAGEMENT.md).
 */
export function endLiveVoiceSession(): void {
  useLiveVoiceStore.getState().controls?.stop();
}

/**
 * Manually release the current push-to-talk turn ("send now") through the
 * store-registered controls. No-op when no session is `listening`. See
 * {@link endLiveVoiceSession} for why this is module-level.
 */
export function releaseLiveVoiceTurn(): void {
  useLiveVoiceStore.getState().controls?.release();
}

/**
 * Dismiss a surfaced live-voice failure by resetting the store back to idle.
 * `failed` is terminal for the session, so this only clears the surfaced
 * error (the mount-scoped `starter` survives, as with any reset). Module-level
 * for the same stable-identity reasons as {@link endLiveVoiceSession}: both
 * failure surfaces — the composer's error `Notice` and the title-bar
 * `VoiceSessionErrorChip` — share this one reference, keeping their dismiss
 * behavior identical by construction.
 */
export function dismissLiveVoiceFailure(): void {
  useLiveVoiceStore.getState().reset();
}

/**
 * Reactive form of {@link isLiveVoiceSessionOwnedBy} for components: whether
 * the active session is owned by the composer bound to
 * `composerConversationId`. Boolean-valued so per-field session churn never
 * re-renders the subscriber.
 */
export function useIsLiveVoiceSessionOwnedBy(
  composerConversationId: string | null | undefined,
): boolean {
  return useLiveVoiceStore((s) =>
    isLiveVoiceSessionOwnedBy(s, composerConversationId),
  );
}
