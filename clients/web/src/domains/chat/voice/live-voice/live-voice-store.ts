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

import type { LiveVoiceMetricsServerFrame } from "@/domains/chat/voice/live-voice/protocol";
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
 * User-facing activity label for a session, factoring in the orthogonal
 * `reconnecting` signal. Drives the room's aria-live label. During a retry of a
 * dropped connection the base `connecting` phase relabels to "Reconnecting…" so
 * surfaces distinguish it from the initial connect (the JARVIS-1255 gap);
 * `reconnecting` is ignored for every other phase. {@link LIVE_VOICE_STATE_LABELS}
 * stays the single source of base labels.
 */
export function liveVoiceStateLabel(
  state: LiveVoiceSessionState,
  reconnecting: boolean,
): string {
  if (reconnecting && state === "connecting") {
    return "Reconnecting…";
  }
  return LIVE_VOICE_STATE_LABELS[state];
}

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
   * Force-end the current user turn — a manual "send now", identical to the
   * automatic release. In hands-free mode it forces the server VAD's
   * utterance boundary (`ptt_release` is honored as a manual override); in
   * manual mode it is the classic push-to-talk release. No-op unless the
   * session is `listening`.
   */
  release: () => void;
  /**
   * Stop in-flight assistant playback without the user having to speak.
   * Hands-free (server-VAD) sessions: turn-scoped — the daemon cancels the
   * turn and re-arms, and the session returns to `listening`. Manual
   * sessions keep the V1 barge-in semantics, which end the session. No-op
   * unless the session is `speaking`.
   */
  interrupt: () => void;
  /**
   * Mute (or unmute) the mic without ending the session. While muted the
   * capture graph keeps running but silence is streamed in place of the
   * captured PCM (keeps the server VAD / STT stream healthy) and the
   * published amplitude pins to 0.
   */
  setMuted: (muted: boolean) => void;
}

/**
 * Latency pair for the most recent live-voice turn.
 *
 * - `server` — the daemon's `metrics` frame for the turn, `null` until it
 *   arrives (its `roundTripMs` is normalized to `null` by the controller when
 *   an older daemon omits the field).
 * - `clientHeardLatencyMs` — the client-perceived end-of-speech → first
 *   TTS-audio-enqueued delta measured by the controller (includes network +
 *   queueing the server can't see); `null` when the turn produced no audio or
 *   had no pending end-of-speech stamp.
 *
 * Written wholesale as one object so the atomic `use.lastTurnLatency()`
 * selector never observes a torn pair (see docs/STATE_MANAGEMENT.md).
 */
export interface LiveVoiceTurnLatency {
  readonly server: LiveVoiceMetricsServerFrame | null;
  readonly clientHeardLatencyMs: number | null;
}

/** Viewport-space point (px) the color room's entrance grows from. */
export interface LiveVoiceEntryOrigin {
  readonly x: number;
  readonly y: number;
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
  /**
   * True while the controller is retrying a dropped connection (attempt > 0),
   * so surfaces can distinguish it from the initial-connect `connecting`.
   * Orthogonal to `state`, which stays a 1:1 mirror of the macOS enum.
   */
  reconnecting: boolean;
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
   * True while the user muted the mic (see {@link LiveVoiceSessionControls.setMuted}).
   * Written by the controller so surfaces render the muted state; cleared on
   * `reset` and `setSessionContext` — a new session always starts live.
   */
  muted: boolean;
  /**
   * Whether the active session runs hands-free (server-VAD). Published by the
   * controller at start and downgraded on the version-skew fallback (an older
   * daemon that ignores `turnDetection`). Surfaces use it to gate hands-free-
   * only affordances — e.g. the pill's turn-scoped ■ stop, which in a manual
   * session would end the whole session.
   */
  handsFree: boolean;
  /**
   * Viewport-space center of the control the user tapped to start the session
   * (the composer's voice button), captured at start. The color room grows its
   * entrance from here — "the avatar on the screen" the user acted on — instead
   * of a fixed screen-center point. `null` when a session started without a
   * captured origin (falls back to center). Cleared on `reset`; NOT cleared by
   * `setSessionContext`, which the start flow calls after this is set.
   */
  entryOrigin: LiveVoiceEntryOrigin | null;
  /**
   * Latency measurements for the last turn, `null` until a turn is measured.
   * Debug surface only — per the minimal-treatment note on
   * {@link LIVE_VOICE_STATE_LABELS}, no surface renders this: the controller
   * logs one `console.debug("[live-voice] turn latency", …)` line per
   * completed turn and this field waits for a future debug panel.
   */
  lastTurnLatency: LiveVoiceTurnLatency | null;
  /**
   * Provider for the assistant's TTS *output* amplitude in [0, 1], registered
   * by the controller from the active session's {@link LiveVoiceAudioPlayer}
   * (its output-bus analyser). `null` when there is no session, or on a context
   * that can't meter. Read via {@link getLiveVoiceOutputAmplitude}; the room
   * avatar routes between this and the mic amplitude by phase — see
   * {@link getLiveVoiceAvatarAmplitude}. A registered provider (like `controls`)
   * so a non-`speaking` read costs nothing and it clears on session reset.
   */
  outputAmplitudeProvider: (() => number) | null;
  /** Human-readable error message when `state === "failed"`, `null` otherwise. */
  error: string | null;
}

export interface LiveVoiceActions {
  /** Replace the session phase. */
  setState: (state: LiveVoiceSessionState) => void;
  /** Set whether the controller is retrying a dropped connection. */
  setReconnecting: (reconnecting: boolean) => void;
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
  /** Record the muted state published by the controller. */
  setMuted: (muted: boolean) => void;
  /** Record whether the active session runs hands-free (server-VAD). */
  setHandsFree: (handsFree: boolean) => void;
  /** Record the entry origin (the tapped control's center) for the entrance. */
  setEntryOrigin: (origin: LiveVoiceEntryOrigin | null) => void;
  /**
   * Replace the last turn's latency pair wholesale (never patch a member in
   * place) so subscribers of the atomic selector see one consistent object.
   */
  setLastTurnLatency: (lastTurnLatency: LiveVoiceTurnLatency) => void;
  /** Register (or clear) the active player's output-amplitude provider. */
  setOutputAmplitudeProvider: (provider: (() => number) | null) => void;
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
  reconnecting: false,
  assistantId: null,
  conversationId: null,
  startedConversationId: null,
  controls: null,
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  muted: false,
  handsFree: false,
  entryOrigin: null,
  lastTurnLatency: null,
  outputAmplitudeProvider: null,
  error: null,
};

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_SESSION_STATE,
  starter: null,

  setState: (state) => set({ state }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setSessionContext: (assistantId, conversationId) =>
    // A fresh session always opens with the mic live, even if the controller
    // starts it without an intervening `reset`.
    set({
      assistantId,
      conversationId,
      startedConversationId: conversationId,
      muted: false,
    }),
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
  setMuted: (muted) => set({ muted }),
  setHandsFree: (handsFree) => set({ handsFree }),
  setEntryOrigin: (entryOrigin) => set({ entryOrigin }),
  setLastTurnLatency: (lastTurnLatency) => set({ lastTurnLatency }),
  setOutputAmplitudeProvider: (outputAmplitudeProvider) =>
    set({ outputAmplitudeProvider }),
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
 * Assistant TTS *output* amplitude in [0, 1] — the smoothed RMS of the audio the
 * assistant is speaking right now, read from the active player's output-bus
 * analyser via the controller-registered provider. Returns 0 when nothing is
 * playing (or the audio context can't meter). The counterpart to
 * {@link getLiveVoiceInputAmplitude}: mic pulse for `listening`, output pulse
 * for `responding`.
 */
export function getLiveVoiceOutputAmplitude(): number {
  return useLiveVoiceStore.getState().outputAmplitudeProvider?.() ?? 0;
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
 * Stop the in-flight assistant response through the store-registered
 * controls. Turn-scoped for hands-free sessions (the session returns to
 * `listening`); ends a manual session (V1 barge-in semantics). No-op unless
 * the session is `speaking`. See {@link endLiveVoiceSession} for why this is
 * module-level.
 */
export function stopLiveVoiceResponse(): void {
  useLiveVoiceStore.getState().controls?.interrupt();
}

/**
 * Mute or unmute the active session's mic through the store-registered
 * controls (the controller mirrors the state into `muted`). No-op when no
 * session exists. See {@link endLiveVoiceSession} for why this is
 * module-level.
 */
export function setLiveVoiceMuted(muted: boolean): void {
  useLiveVoiceStore.getState().controls?.setMuted(muted);
}

/**
 * Record the viewport-space center of the control that started the session, so
 * the color room grows its entrance from there. Set by the composer just
 * before it invokes the session `starter`. Module-level for the same
 * stable-identity reasons as {@link endLiveVoiceSession}.
 */
export function setLiveVoiceEntryOrigin(
  origin: LiveVoiceEntryOrigin | null,
): void {
  useLiveVoiceStore.getState().setEntryOrigin(origin);
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
