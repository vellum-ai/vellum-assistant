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
import type { LiveVoicePlaybackProgress } from "@/domains/chat/voice/live-voice/tts-playback";
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
 * - `transcribing`: the user's utterance closed; waiting on the final
 *   transcript. Set by server VAD's `utterance_end` in hands-free and by the
 *   turn-boundary `ptt_release` frame in manual mode. Distinct from `thinking`
 *   because it stamps end-of-speech latency and gates the
 *   `utterance_discarded` return to `listening`, though the two share a label
 *   (see {@link LIVE_VOICE_STATE_LABELS}).
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
 *
 * `transcribing` and `thinking` share one label (JARVIS-1559).
 * `toVoiceAvatarVisual` collapses both phases to a single visual, so wording
 * unique to `transcribing` puts two words for one phase on screen at once,
 * across a window that is usually under a second and that offers the user
 * nothing to act on. The pairing belongs in this table rather than in
 * {@link liveVoiceSurfaceLabel}: the session pill and the composer's voice bar
 * read the table directly, so it is the only layer every surface shares.
 */
export const LIVE_VOICE_STATE_LABELS: Record<LiveVoiceSessionState, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening…",
  transcribing: "Thinking…",
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
 * The label a *surface* shows for a session: {@link liveVoiceStateLabel} plus
 * the two remaps that keep the words true of what is actually happening.
 *
 * `speaking` stays set across a mid-turn tool run: the assistant spoke an ack,
 * then went silent while a tool runs. Announcing "Speaking…" while nothing is
 * audible is wrong for the room's caption, wrong for its screen-reader
 * announcement, and wrong for the Dynamic Island (JARVIS-1279). Every surface
 * that renders session activity calls this, the voice room and the iOS Live
 * Activity mirror, so the island always reads exactly what the room reads.
 *
 * `listening` is the same problem through the microphone: the session holds
 * that phase while the mic is muted, so the surface claims to be listening
 * beside a mute button that says it is not. Muted is a state rather than an
 * activity, so it takes no ellipsis where the phases do.
 *
 * Only `listening` is remapped. Muting the microphone does not make the
 * assistant stop thinking or speaking, and relabelling those would trade one
 * false statement for another.
 *
 * {@link liveVoiceStateLabel} stays the lower layer for callers that have no
 * audio signal to consult.
 */
export function liveVoiceSurfaceLabel(
  state: LiveVoiceSessionState,
  reconnecting: boolean,
  assistantAudioActive: boolean,
  muted: boolean,
): string {
  if (state === "listening" && muted) {
    return "Muted";
  }
  return liveVoiceStateLabel(
    state === "speaking" && !assistantAudioActive ? "thinking" : state,
    reconnecting,
  );
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
  /**
   * Mute (or unmute) the assistant's audio without ending the session or
   * stopping the reply in progress. The turn keeps running and the transcript
   * keeps filling; only the sound stops, so unmuting mid-reply drops the user
   * back into it wherever it has reached.
   */
  setOutputMuted: (muted: boolean) => void;
  /**
   * Retune the live session's turn-detection knobs ("pause before reply" /
   * "interrupt sensitivity") without reconnecting. Each field is optional; the
   * daemon applies the change from the next utterance. No-op unless the
   * transport is active.
   */
  updateConfig: (config: {
    silenceThresholdMs?: number;
    bargeInMinSpeechMs?: number;
  }) => void;
  /**
   * Tell the session about a photo the user took mid-call, by the id its
   * upload already returned. The daemon persists it into the conversation
   * straight away, running no turn, so whatever the user says next sees it.
   *
   * Returns whether it reached the session. False during a reconnect gap,
   * which the caller must surface: the photo is already uploaded and the
   * shutter has already fired, so silence would read as success.
   *
   * Callers must gate on `useSupportsVoiceCamera`. See that hook for why an
   * older assistant's rejection cannot be told apart from `update_config`'s.
   */
  attachImage: (attachmentId: string) => boolean;
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
 * Mount-scoped entry points for starting live voice. The composer prewarms
 * playback synchronously from the user's gesture, before its async readiness
 * preflight, then either starts with that player or cancels the reservation.
 */
export interface LiveVoiceSessionStarter {
  /** Unlock playback while the initiating user gesture is still active. */
  prewarm(): void;
  /** Release playback reserved by a preflight that will not start a session. */
  cancelPrewarm(): void;
  /** Start a session, consuming the prewarmed player when one exists. */
  start(assistantId: string, conversationId: string | null): void;
}

export interface LiveVoiceState {
  /** Current phase of the session lifecycle. */
  state: LiveVoiceSessionState;
  /**
   * Whether the assistant's TTS audio is actually queued/playing right now,
   * tracked by the controller from the active {@link LiveVoiceAudioPlayer} with
   * a short idle grace. The `speaking` phase mirrors server turn framing (set on
   * the first `tts_audio`, cleared only on `tts_done`), so a turn that speaks an
   * ack and then runs a tool stays `speaking` while silent; this flag lets the
   * avatar distinguish "actively speaking" from "silent mid-turn" and read as
   * `thinking` during the tool run (see `toVoiceAvatarVisual`, JARVIS-1279).
   * Meaningful only while `state === "speaking"`.
   */
  assistantAudioActive: boolean;
  /** True once microphone capture has started for the active session. */
  microphoneActive: boolean;
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
  /**
   * Bumped each time the assistant refuses a photo that the transport had
   * already accepted. A counter rather than a flag or a payload because the
   * room's only use is "another one just failed": consecutive rejections must
   * each register, and there is nothing about a rejection worth carrying
   * beyond the fact of it.
   */
  photoRejectedSeq: number;
  /** Why the last photo was refused, for the room's wording. */
  photoRejectedReason: "unsupported" | "failed" | null;
  /** Controls registered by the owning controller, `null` when no session. */
  controls: LiveVoiceSessionControls | null;
  /**
   * Session starter registered by the persistently mounted controller hook.
   * `null` only when no controller is mounted (e.g. outside the chat layout).
   * Mount-scoped, not session-scoped: {@link LiveVoiceActions.reset} leaves it
   * registered.
   */
  starter: LiveVoiceSessionStarter | null;
  /**
   * Whether the first-run preferences card stands in for an entry, having
   * intercepted one. Store-held rather than composer-local because every
   * entry point can be intercepted, including the ones with no composer in
   * them (the voice mode shortcut, the companion surface's Talk), and the
   * card is drawn in one place for all of them.
   */
  firstRunCardOpen: boolean;
  /**
   * The daemon's "configure voice" copy from a `not-ready` readiness verdict,
   * or `null`. Non-null means an entry was refused before the room opened;
   * the composer renders it with a deep link to voice settings. Store-held
   * for the same reason as {@link LiveVoiceState.firstRunCardOpen}.
   */
  configNotice: string | null;
  /**
   * One short line describing what the current turn is doing ("Reading a
   * file"), or `""` when it is doing nothing nameable.
   *
   * **The wording is the daemon's**, delivered by the `activity` frame, not
   * composed here. The iOS Live Activity is driven both by that socket and by
   * an APNs push the daemon dispatches when this web layer is suspended; the
   * two must carry identical content state, and only one of them can run web
   * code. See `assistant/src/live-voice/activity-label.ts`.
   *
   * Turn-scoped: the daemon sends `""` when a turn stops working, and
   * `reset()` clears it with everything else.
   */
  activityLabel: string;
  /**
   * The confirmation the current turn is blocked on, or `null` when it is not
   * blocked on one.
   *
   * Delivered alongside {@link activityLabel} by the `activity` frame, because
   * a wait is a thing the turn is "doing" and the two are one fact. It exists
   * for surfaces outside the app — the iOS Live Activity's Approve/Deny
   * buttons — which need an id to answer rather than a card to render; in the
   * app the approval card is already on screen and owns its own request.
   *
   * Turn-scoped, and cleared the moment the decision stops being the user's to
   * make, however it was made.
   */
  pendingApprovalRequestId: string | null;
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
   * True while the user muted the assistant's audio (see
   * {@link LiveVoiceSessionControls.setOutputMuted}). Written by the controller
   * so surfaces render the state; cleared on session reset like `muted`.
   */
  outputMuted: boolean;
  /**
   * Whether the active session runs hands-free (server-VAD). Published by the
   * controller at start and downgraded on the version-skew fallback (an older
   * daemon that ignores `turnDetection`). Surfaces use it to gate hands-free-
   * only affordances — e.g. the pill's turn-scoped ■ stop, which in a manual
   * session would end the whole session.
   */
  handsFree: boolean;
  /**
   * Whether the user (or the assistant, via the `minimize_room` frame) has
   * dismissed the full-screen voice room for this session while keeping the
   * session live. While true, the owning composer's voice bar (on the owning
   * thread) and the title-bar session pill (elsewhere) are the session
   * surfaces. Session-scoped: cleared by `reset()` so a new session always
   * opens in the room.
   */
  roomMinimized: boolean;
  /**
   * Viewport-space center of the control the user tapped to start the session
   * (the composer's voice button). The color room grows its entrance from here
   * — "the avatar on the screen" the user acted on — instead of a fixed
   * screen-center point. `null` when a session started without a captured
   * origin (falls back to center). The composer publishes it just before
   * invoking the `starter`; the controller's `connectSession` carries it across
   * its start-time `reset()` (like `muted`), so it survives to the room mount.
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
  /**
   * Provider for the current response's TTS playback progress (played/total
   * seconds of scheduled audio), registered by the controller from the active
   * session's {@link LiveVoiceAudioPlayer}. `null` when there is no session.
   * Read via {@link getLiveVoicePlaybackProgress} — the voice-room transcript's
   * spoken-word cursor polls it per animation frame. A registered provider
   * (like `outputAmplitudeProvider`) so a non-speaking read costs nothing and
   * it clears on session reset.
   */
  playbackProgressProvider: (() => LiveVoicePlaybackProgress | null) | null;
  /** Human-readable error message when `state === "failed"`, `null` otherwise. */
  error: string | null;
}

export interface LiveVoiceActions {
  /** Replace the session phase. */
  setState: (state: LiveVoiceSessionState) => void;
  /** Record whether assistant TTS audio is currently queued/playing. */
  setAssistantAudioActive: (active: boolean) => void;
  /** Record whether the active session has acquired the microphone. */
  setMicrophoneActive: (active: boolean) => void;
  /**
   * Record what the current turn is doing, as the daemon worded it, and which
   * confirmation it is blocked on if it is blocked on one.
   *
   * One setter for both because they arrive on one frame and describe one
   * state: a turn that is waiting is not also running something, and letting
   * the id be set independently would allow exactly the pair that cannot be
   * true (a wait with no line, a line with a stale wait).
   */
  setActivityLabel: (
    activityLabel: string,
    pendingApprovalRequestId?: string | null,
  ) => void;
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
  /** Record that the assistant refused a photo. See {@link photoRejectedSeq}. */
  notePhotoRejected: (reason: "unsupported" | "failed") => void;
  /** Register (or clear) the owning controller's session controls. */
  setControls: (controls: LiveVoiceSessionControls | null) => void;
  /** Register (or clear) the mounted controller's session starter. */
  setStarter: (starter: LiveVoiceSessionStarter | null) => void;
  /** Open or dismiss the first-run preferences card. */
  setFirstRunCardOpen: (open: boolean) => void;
  /** Publish or clear the pre-open "configure voice" notice. */
  setConfigNotice: (notice: string | null) => void;
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
  /** Record the assistant-audio muted state published by the controller. */
  setOutputMuted: (muted: boolean) => void;
  /** Record whether the active session runs hands-free (server-VAD). */
  setHandsFree: (handsFree: boolean) => void;
  /** Record whether the voice room is dismissed for the active session. */
  setRoomMinimized: (roomMinimized: boolean) => void;
  /** Record the entry origin (the tapped control's center) for the entrance. */
  setEntryOrigin: (origin: LiveVoiceEntryOrigin | null) => void;
  /**
   * Replace the last turn's latency pair wholesale (never patch a member in
   * place) so subscribers of the atomic selector see one consistent object.
   */
  setLastTurnLatency: (lastTurnLatency: LiveVoiceTurnLatency) => void;
  /** Register (or clear) the active player's output-amplitude provider. */
  setOutputAmplitudeProvider: (provider: (() => number) | null) => void;
  /** Register (or clear) the active player's playback-progress provider. */
  setPlaybackProgressProvider: (
    provider: (() => LiveVoicePlaybackProgress | null) | null,
  ) => void;
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

/**
 * The phases of a session that is actually running — everything
 * {@link isLiveVoiceSessionActive} admits. Surfaces that only exist for a
 * running session (the iOS Live Activity's phase) derive their own union from
 * this rather than restating it, so the two cannot drift.
 */
export type ActiveLiveVoiceSessionState = Exclude<
  LiveVoiceSessionState,
  "idle" | "failed"
>;

/**
 * Whether `state` is a live session phase (anything but idle/failed). Narrows,
 * so callers that only handle a running session — e.g. mapping the phase onto
 * a surface's own narrower union — get that for free.
 */
export function isLiveVoiceSessionActive(
  state: LiveVoiceSessionState,
): state is ActiveLiveVoiceSessionState {
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
  firstRunCardOpen: false,
  configNotice: null,
  assistantAudioActive: false,
  microphoneActive: false,
  activityLabel: "",
  pendingApprovalRequestId: null,
  reconnecting: false,
  assistantId: null,
  conversationId: null,
  startedConversationId: null,
  photoRejectedSeq: 0,
  photoRejectedReason: null,
  controls: null,
  partialTranscript: "",
  finalTranscript: "",
  assistantTranscript: "",
  inputAmplitude: 0,
  muted: false,
  outputMuted: false,
  handsFree: false,
  roomMinimized: false,
  entryOrigin: null,
  lastTurnLatency: null,
  outputAmplitudeProvider: null,
  playbackProgressProvider: null,
  error: null,
};

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_SESSION_STATE,
  starter: null,

  setState: (state) => set({ state }),
  setAssistantAudioActive: (assistantAudioActive) =>
    set({ assistantAudioActive }),
  setMicrophoneActive: (microphoneActive) => set({ microphoneActive }),
  setActivityLabel: (activityLabel, pendingApprovalRequestId = null) =>
    set({ activityLabel, pendingApprovalRequestId }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setSessionContext: (assistantId, conversationId) =>
    // A fresh session always opens with the mic live, even if the controller
    // starts it without an intervening `reset`.
    set({
      assistantId,
      conversationId,
      startedConversationId: conversationId,
      muted: false,
      outputMuted: false,
    }),
  setConversationId: (conversationId) => set({ conversationId }),
  notePhotoRejected: (reason) =>
    set((state) => ({
      photoRejectedSeq: state.photoRejectedSeq + 1,
      photoRejectedReason: reason,
    })),
  setControls: (controls) => set({ controls }),
  setStarter: (starter) => set({ starter }),
  setFirstRunCardOpen: (firstRunCardOpen) => set({ firstRunCardOpen }),
  setConfigNotice: (configNotice) => set({ configNotice }),
  setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
  setFinalTranscript: (finalTranscript) => set({ finalTranscript }),
  appendAssistantTranscript: (delta) =>
    set((s) => ({ assistantTranscript: s.assistantTranscript + delta })),
  clearAssistantTranscript: () => set({ assistantTranscript: "" }),
  clearUserTranscripts: () =>
    set({ partialTranscript: "", finalTranscript: "" }),
  setInputAmplitude: (inputAmplitude) => set({ inputAmplitude }),
  setMuted: (muted) => set({ muted }),
  setOutputMuted: (outputMuted) => set({ outputMuted }),
  setHandsFree: (handsFree) => set({ handsFree }),
  setRoomMinimized: (roomMinimized) => set({ roomMinimized }),
  setEntryOrigin: (entryOrigin) => set({ entryOrigin }),
  setLastTurnLatency: (lastTurnLatency) => set({ lastTurnLatency }),
  setOutputAmplitudeProvider: (outputAmplitudeProvider) =>
    set({ outputAmplitudeProvider }),
  setPlaybackProgressProvider: (playbackProgressProvider) =>
    set({ playbackProgressProvider }),
  fail: (message) => set({ state: "failed", error: message }),
  reset: () => set({ ...INITIAL_SESSION_STATE }),
}));

export const useLiveVoiceStore = createSelectors(useLiveVoiceStoreBase);

/**
 * Subscribe to the *settled* session state: the store as it stands once the
 * current synchronous burst of `set()` calls has finished.
 *
 * `useLiveVoiceStore.subscribe` fires synchronously on every single `set()`,
 * and a session transition is rarely one `set()`. Starting a session runs
 * `reset()` (→ `idle`) immediately followed by `setState("connecting")`, then
 * re-applies `reconnecting`, the session context, the carried-over `muted`, and
 * the controls — so a raw subscriber sees an `idle` that never existed as a
 * state of the world, plus four intermediate frames of a half-built session.
 *
 * React consumers never notice: they read through selectors and React batches
 * the burst into one render. Consumers that drive *the world* do, and for them
 * that phantom `idle` is destructive rather than cosmetic — on every hands-free
 * reconnect (a dropped velay socket, JARVIS-1255/1256) it tears down and
 * immediately re-creates the `AVAudioSession`, possibly while backgrounded or
 * locked, and ends and restarts the Live Activity so the island visibly
 * disappears and comes back.
 *
 * So: coalesce the burst into one microtask and hand the listener a fresh
 * `getState()`. A superseded state never reaches it, and a transition costs one
 * callback instead of five — which also keeps the mirror inside ActivityKit's
 * update budget. A microtask rather than a timer, so nothing observable is
 * deferred past the transition itself.
 */
export function subscribeSettledLiveVoiceState(
  listener: (session: LiveVoiceState) => void,
): () => void {
  let scheduled = false;
  let disposed = false;
  const unsubscribe = useLiveVoiceStore.subscribe(() => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      // Unsubscribed inside the burst — a controller unmounting mid-transition.
      // Its own teardown is authoritative; this must not fire after it.
      if (disposed) {
        return;
      }
      listener(useLiveVoiceStore.getState());
    });
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}

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
 * Playback progress (played/total seconds) of the current response's TTS
 * audio, read from the active player via the controller-registered provider.
 * Returns `null` when no session is active or nothing has been scheduled for
 * the current response. Polled per animation frame by the voice-room
 * transcript's spoken-word cursor, so it is module-level (stable identity)
 * and reads through `getState()` — subscribing would re-render the poller on
 * every register/clear (see STATE_MANAGEMENT.md, as with
 * {@link getLiveVoiceOutputAmplitude}).
 */
export function getLiveVoicePlaybackProgress(): LiveVoicePlaybackProgress | null {
  return useLiveVoiceStore.getState().playbackProgressProvider?.() ?? null;
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
 * Dismiss the full-screen voice room while keeping the session live — the
 * owning composer's voice bar and the title-bar pill become the session
 * surfaces. No-op when no session is active, so it is safe to call at any
 * time (e.g. from a server-driven `minimize_room` frame). See
 * {@link endLiveVoiceSession} for why this is module-level.
 */
export function minimizeVoiceRoom(): void {
  const { state, setRoomMinimized } = useLiveVoiceStore.getState();
  if (isLiveVoiceSessionActive(state)) {
    setRoomMinimized(true);
  }
}

/**
 * Bring the full-screen voice room back for the active session. No-op when no
 * session is active. See {@link endLiveVoiceSession} for why this is
 * module-level.
 */
export function restoreVoiceRoom(): void {
  const { state, setRoomMinimized } = useLiveVoiceStore.getState();
  if (isLiveVoiceSessionActive(state)) {
    setRoomMinimized(false);
  }
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
 * Mute or unmute the assistant's audio through the store-registered controls
 * (the controller mirrors the state into `outputMuted`). No-op when no session
 * exists. See {@link endLiveVoiceSession} for why this is module-level.
 */
export function setLiveVoiceOutputMuted(muted: boolean): void {
  useLiveVoiceStore.getState().controls?.setOutputMuted(muted);
}

/**
 * Retune the active session's "pause before reply" / "interrupt sensitivity"
 * live through the store-registered controls (the in-session voice-room gear).
 * No-op when no session exists or the transport isn't active. Module-level for
 * the same stable-identity reasons as {@link endLiveVoiceSession}.
 */
export function updateLiveVoiceSessionConfig(config: {
  silenceThresholdMs?: number;
  bargeInMinSpeechMs?: number;
}): void {
  useLiveVoiceStore.getState().controls?.updateConfig(config);
}

/**
 * Hand the active session a photo the user took mid-call, by attachment id.
 * Returns whether it reached the session: false when no session exists or the
 * transport is mid-reconnect, which the caller must surface rather than treat
 * as sent. Module-level for the same stable-identity reasons as
 * {@link endLiveVoiceSession}.
 */
export function attachLiveVoiceImage(attachmentId: string): boolean {
  return (
    useLiveVoiceStore.getState().controls?.attachImage(attachmentId) ?? false
  );
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
