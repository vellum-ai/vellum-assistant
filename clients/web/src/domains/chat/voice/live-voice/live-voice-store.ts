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
import type { WatchCaptureTarget } from "@vellumai/ipc-contract";

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
 *   (see {@link LIVE_VOICE_STATE_KEYS}).
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
 * Catalog key for a session's status word, in the `chat` namespace.
 */
export type LiveVoiceStatusKey =
  | "liveVoiceStatus.connecting"
  | "liveVoiceStatus.reconnecting"
  | "liveVoiceStatus.listening"
  | "liveVoiceStatus.thinking"
  | "liveVoiceStatus.speaking"
  | "liveVoiceStatus.ending"
  | "liveVoiceStatus.muted";

/**
 * The status key each session state carries, before the surface remaps in
 * {@link liveVoiceSurfaceLabelKey}. `null` is a phase with no word at all:
 * hosts unmount their voice UI in `idle` and `failed`.
 *
 * Deliberately minimal treatment (decided 2026-07-06): assistant output
 * streams into the thread transcript like text chat, so surfaces only carry a
 * small label.
 *
 * `transcribing` and `thinking` share one key (JARVIS-1559).
 * `toVoiceAvatarVisual` collapses both phases to a single visual, so wording
 * unique to `transcribing` puts two words for one phase on screen at once,
 * across a window that is usually under a second and that offers the user
 * nothing to act on.
 *
 * A phase and its wording are paired here and nowhere else. The wording itself
 * is `liveVoiceStatus` in the `chat` catalog, and every surface resolves the
 * key through it, so each of them says the same thing in the reader's own
 * language.
 */
export const LIVE_VOICE_STATE_KEYS: Record<
  LiveVoiceSessionState,
  LiveVoiceStatusKey | null
> = {
  idle: null,
  connecting: "liveVoiceStatus.connecting",
  listening: "liveVoiceStatus.listening",
  transcribing: "liveVoiceStatus.thinking",
  thinking: "liveVoiceStatus.thinking",
  speaking: "liveVoiceStatus.speaking",
  ending: "liveVoiceStatus.ending",
  failed: null,
};

/**
 * The catalog key a *surface* shows for a session: the phase's own key plus the
 * remaps that keep the word true of what is actually happening. Keys exist so
 * surfaces can localize without forking the decision table.
 *
 * `connecting` relabels to "Reconnecting…" while the controller is retrying a
 * dropped connection, so a surface distinguishes a retry from the initial
 * connect (the JARVIS-1255 gap). `reconnecting` is ignored for every other
 * phase.
 *
 * `speaking` stays set across a mid-turn tool run: the assistant spoke an ack,
 * then went silent while a tool runs. Announcing "Speaking…" while nothing is
 * audible is wrong for the room's caption, wrong for its screen-reader
 * announcement, and wrong for the Dynamic Island (JARVIS-1279). Every surface
 * that renders session activity calls this, the room and the out-of-app
 * mirrors alike, so the island always reads exactly what the room reads.
 *
 * `listening` is the same problem through the microphone: the session holds
 * that phase while the mic is muted, so the surface claims to be listening
 * beside a mute button that says it is not. Muted is a state rather than an
 * activity, so it takes no ellipsis where the phases do.
 *
 * Only `listening` is remapped for mute. Muting the microphone does not make
 * the assistant stop thinking or speaking, and relabelling those would trade
 * one false statement for another.
 */
export function liveVoiceSurfaceLabelKey(
  state: LiveVoiceSessionState,
  reconnecting: boolean,
  assistantAudioActive: boolean,
  muted: boolean,
): LiveVoiceStatusKey | null {
  if (state === "listening" && muted) {
    return "liveVoiceStatus.muted";
  }
  if (state === "connecting" && reconnecting) {
    return "liveVoiceStatus.reconnecting";
  }
  if (state === "speaking" && !assistantAudioActive) {
    return "liveVoiceStatus.thinking";
  }
  return LIVE_VOICE_STATE_KEYS[state];
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
  /**
   * Share a camera frame the viewfinder's gate kept, by the id its upload
   * already returned. The daemon persists it as its own user message straight
   * away, so the transcript carries every keep in the order they arrived and
   * nothing is staged for a later turn to pick up.
   *
   * Returns whether it reached the session. Unlike `attachImage` a false needs
   * no report: nobody pressed anything, and the next keep sends a newer frame.
   *
   * Callers must gate on `useSupportsSightStream`.
   */
  sightFrame: (attachmentId: string) => boolean;
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
  /**
   * Start a session, consuming the prewarmed player when one exists.
   *
   * `seedText` takes a first turn on the session's behalf once the microphone
   * is live, so the assistant speaks without waiting for the user. It becomes
   * a real user message in the conversation, so a caller passes one only where
   * that reads honestly. See `voice-entry-greeting.ts` for the rule and the
   * copy. `seedVisible` renders it as the user's own message rather than
   * hiding it, for a seed that is their words; `endAfterSeedReply` ends the
   * session once its reply has been heard.
   */
  start(
    assistantId: string,
    conversationId: string | null,
    options?: LiveVoiceSeedOptions,
  ): void;
  /**
   * Put a typed turn to the running session. Returns whether it went out: a
   * session that is not up, or an assistant without typed turns, takes
   * nothing, and the caller keeps the words.
   */
  sendText(text: string): boolean;
}

/** The first turn a session takes on a caller's behalf, and what follows it. */
export interface LiveVoiceSeedOptions {
  seedText?: string;
  seedVisible?: boolean;
  endAfterSeedReply?: boolean;
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
  /**
   * Set once the assistant answers a kept camera frame with `unknown_type`,
   * meaning it has no `sight_frame` handler at all.
   *
   * The runtime backstop for a mis-gated assistant, whatever produced the
   * mis-gating. `use-supports-sight-stream.ts` pins a version floor, but no
   * version floor can be airtight: a dev release dispatched by hand from a
   * stale ref stamps a fresh timestamp onto a pre-merge commit, and the
   * comparator weighs the timestamp ahead of the sha, so such a build clears
   * any floor. Without this latch each keep against it uploads an attachment,
   * is refused, and leaves that attachment behind for good, because an
   * assistant that never understood the frame never reclaims it either.
   *
   * Session-scoped: it lives in {@link INITIAL_SESSION_STATE}, so a reconnect
   * (which resets with `sessionContinues`) tries again against whatever
   * assistant answers next.
   */
  sightFramesUnsupported: boolean;
  /**
   * Ids of kept frames sent to the assistant with no verdict yet, newest last,
   * capped at {@link SIGHT_FRAME_LEDGER_CAP}.
   *
   * An assistant that persisted a keep answers with nothing at all, so the
   * only exact retirement is an error frame naming the attachment. An
   * assistant that echoes no id leaves nothing to correlate, so its refusal
   * retracts every claim in this ledger and retires none of them.
   */
  outstandingSightFrames: readonly string[];
  /** Ids the cap pushed off the ledger, newest last, capped the same way. */
  prunedSightFrames: readonly string[];
  /**
   * Photos sent to the assistant with no verdict yet.
   *
   * A count rather than ids: nothing here needs to know WHICH photo, only how
   * many standalone persists can be queued ahead of a keep, since the daemon
   * runs them one at a time and never supersedes a photo. Only a refusal
   * retires one, so this over-counts the ones that quietly persisted, which
   * only ever lengthens a wait. See `queueUnacknowledgedSightFrames`.
   */
  outstandingPhotoSends: number;
  /**
   * Uploads to give back, accumulating until the session-lifetime reclaimer
   * drains them.
   *
   * Deliberately NOT session state: it is not reset with a session, because
   * the refusal that fills it can land while the room is minimized (so the
   * room's hook is unmounted and cannot consume) and the call can then end
   * before anything drains. A queue that a session teardown could discard
   * would strand exactly the uploads it is meant to collect.
   */
  sightFramesToReclaim: readonly SightFrameReclaim[];
  /**
   * Displayed keeps a refusal invalidated, accumulating until the room's sight
   * surface consumes them.
   *
   * Session state, unlike the reclaim queue: a retraction is about a thumbnail
   * on screen, and a session that ended took its thumbnail with it. Separate
   * from the queue so each has exactly one consumer and neither can clear work
   * belonging to the other.
   */
  sightFrameRetractions: readonly string[];
  /** Controls registered by the owning controller, `null` when no session. */
  controls: LiveVoiceSessionControls | null;
  /**
   * Which session lifetime this is. It moves when a session tears down and
   * never during one, reconnects included, so an async continuation that read
   * it mid-session can tell that its session is over. `controls` cannot
   * answer that question: reconnect attempts republish a fresh controls
   * object within one session. Never restored to the initial value: a
   * terminal {@link LiveVoiceActions.reset} bumps it, and a mid-session reset
   * (`sessionContinues`) leaves it alone.
   */
  sessionGeneration: number;
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
  /**
   * Whether the server VAD is holding an utterance open: set on
   * `speech_started`, cleared on `utterance_end` / `utterance_discarded`. The
   * session's own answer to "is the user talking right now", published because
   * a surface renders that boundary directly (the camera-mode status pill's
   * dot). Only hands-free sessions have one; a manual session leaves it false.
   * Session-scoped, so `reset()` clears it with everything else.
   */
  utteranceOpen: boolean;
  /**
   * The display or window the user is sharing with the session, or null when
   * nothing is shared. The ask behind the macOS companion's share control:
   * `use-live-voice-screen-share.ts` takes frames of it for as long as it is
   * set and the session can be shown anything, and lowers it when it cannot.
   * Session-scoped, and kept across a reconnect: the user is still sharing
   * while the transport comes back.
   */
  screenShareTarget: WatchCaptureTarget | null;
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
   * {@link LIVE_VOICE_STATE_KEYS}, no surface renders this: the controller
   * logs one `console.debug("[live-voice] turn latency", …)` line per
   * completed turn and this field waits for a future debug panel.
   */
  lastTurnLatency: LiveVoiceTurnLatency | null;
  /**
   * Provider for the assistant's TTS *output* amplitude in [0, 1], registered
   * by the controller from the active session's {@link LiveVoiceAudioPlayer}
   * (its output-bus analyser). `null` when there is no session, or on a context
   * that can't meter. Read via {@link getLiveVoiceOutputAmplitude} by the room's
   * `responding` band and the output meters on the composer bar and the pill;
   * the mic amplitude behind `listening` is a separate field. A registered
   * provider (like `controls`) so a non-`speaking` read costs nothing and it
   * clears on session reset.
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
  /**
   * What the user can do about the current failure, beyond dismissing it.
   * `null` for a failure with no way out but trying again later.
   *
   * `reclaim` means another live-voice session holds the daemon's single
   * slot, and it can be ended from here. `holderConversationId` is where that
   * session is, when the daemon named it, so a surface can offer to go there
   * instead of ending it.
   */
  errorRecovery: LiveVoiceErrorRecovery | null;
}

/** See {@link LiveVoiceState.errorRecovery}. */
export interface LiveVoiceErrorRecovery {
  kind: "reclaim";
  holderConversationId: string | null;
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
  /** Record a photo that reached the transport. */
  notePhotoSent: () => void;
  /** Record a kept frame that reached the transport. */
  noteSightFrameSent: (attachmentId: string) => void;
  /**
   * Record that the assistant refused a kept frame, and work out what it costs.
   *
   * `attachmentId` is the id the error named, when the assistant echoes one.
   * With it, retirement and retraction are exact. Without it (any assistant at
   * the current version floor) there is nothing to correlate, so the refusal
   * takes down every outstanding claim and retires none of them.
   */
  noteSightFrameRefused: (
    unsupported: boolean,
    attachmentId?: string | null,
  ) => void;
  /**
   * Remove the reclaims whose time has come and hand them back, in one state
   * transition. Entries still waiting on their `notBefore` stay queued.
   *
   * The only way to empty the queue, deliberately. A clear that did not return
   * what it removed could drop an entry queued between a consumer reading the
   * queue and acting on it, and that entry would be an upload nothing ever
   * deletes. Taking makes the invariant structural: whatever leaves the queue
   * is in the caller's hands, and whatever arrives after a take is still
   * queued for the next one.
   *
   * Leaves the state untouched when nothing is due, so a consumer keyed on the
   * queue is not woken by its own no-op.
   */
  takeDueSightFrameReclaims: (now: number) => readonly SightFrameReclaim[];
  /**
   * Remove every queued retraction and hand it back, in one state transition.
   *
   * The only way to empty it, for the same reason
   * {@link takeDueSightFrameReclaims} is: a clear that did not return what it
   * removed could drop a retraction queued between a consumer reading the list
   * and acting on it, and the surface would go on showing a frame that never
   * reached the transcript.
   */
  takeSightFrameRetractions: () => readonly string[];
  /** Register (or clear) the owning controller's session controls. */
  setControls: (controls: LiveVoiceSessionControls | null) => void;
  /** Register (or clear) the mounted controller's session starter. */
  setStarter: (starter: LiveVoiceSessionStarter | null) => void;
  /** Open or dismiss the first-run preferences card. */
  setFirstRunCardOpen: (open: boolean) => void;
  /** Publish or clear the pre-open "configure voice" notice. */
  setConfigNotice: (notice: string | null) => void;
  /** Record whether the server VAD is holding an utterance open. */
  setUtteranceOpen: (utteranceOpen: boolean) => void;
  /** Set or clear what the session is being shown. See `screenShareTarget`. */
  setScreenShareTarget: (screenShareTarget: WatchCaptureTarget | null) => void;
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
  fail: (message: string, recovery?: LiveVoiceErrorRecovery | null) => void;
  /**
   * Reset every session field back to the idle defaults. Deliberately leaves
   * `starter` registered — it belongs to the controller's mount lifecycle,
   * not the session lifecycle, and must survive session teardown so the next
   * session can start.
   *
   * Bumps `sessionGeneration`, unless `sessionContinues` says this reset
   * clears state inside one logical session (the reconnect path re-entering
   * its connect flow), which keeps work pinned to the session, a photo upload
   * above all, deliverable once the transport is back.
   */
  reset: (opts?: { sessionContinues?: boolean }) => void;
}

/**
 * An upload nothing will ever collect, paired with the assistant holding it.
 *
 * The pair rather than the id alone because this queue outlives the session
 * that produced it. Draining is a cleanup duty, not session state: it must
 * survive a session ending (the room unmounts the moment a call ends, and a
 * minimized room is not mounted at all), and it must never aim a delete at
 * whichever assistant happens to be current when the drain runs.
 */
export interface SightFrameReclaim {
  readonly assistantId: string;
  readonly attachmentId: string;
  /**
   * The conversation whose serialized persist queue the deadline waits out.
   * Carried so a later send can tell whether it joined this queue or an
   * unrelated conversation's; absent on refusal-routed entries, which carry
   * no deadline to move.
   */
  readonly conversationId?: string;
  /**
   * Epoch milliseconds before which this must not be deleted, when it has to
   * wait at all. See {@link PER_JOB_CEILING_MS}.
   */
  readonly notBefore?: number;
}

/**
 * The longest one standalone-image persist can take on the daemon.
 *
 * Each of them waits up to `PROCESSING_WAIT_MS` (30s in
 * `assistant/src/live-voice/live-voice-photo.ts`) for the conversation's
 * processing lock before giving up, and then writes. 35s covers that wait plus
 * the write.
 */
export const PER_JOB_CEILING_MS = 35_000;

/**
 * How many kept frames the outstanding ledger remembers, and how many pruned
 * ids it keeps behind it.
 *
 * A send is only ever retired by an error naming it, because an accepted keep
 * is answered with nothing and an unnamed refusal cannot say which send it
 * retires. Without a bound the ledger would grow for the length of a call.
 * The cap is memory hygiene and nothing else: see `noteSightFrameSent` for
 * why a pruned id cannot become a wrong deletion.
 */
const SIGHT_FRAME_LEDGER_CAP = 8;

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
 * Whether the user is part-way through saying something, as the session
 * reports it.
 *
 * Two sessions, two signals, and no third opinion about either: hands-free
 * runs on the server VAD, whose boundary the store publishes as
 * `utteranceOpen`, and a manual session has no VAD at all, so the thing that
 * opens the user's turn is the session reaching `listening`, which is where
 * push-to-talk starts forwarding audio. Named for the user rather than the
 * session, whose own `speaking` phase is the assistant's voice and the
 * opposite of this. One answer to "is the user talking" for every surface
 * that acts on the edge of a turn: the room's sight arms a keep on it, and the
 * screen share takes a frame on each side of it.
 */
export function isLiveVoiceUserSpeaking(
  session: Pick<LiveVoiceState, "state" | "handsFree" | "utteranceOpen">,
): boolean {
  return session.handsFree
    ? session.utteranceOpen
    : session.state === "listening";
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

/**
 * Session-scoped fields restored by `reset()`. Excludes `starter`
 * (mount-scoped) and `sessionGeneration` (monotonic across sessions).
 */
const INITIAL_SESSION_STATE: Omit<
  LiveVoiceState,
  "starter" | "sessionGeneration" | "sightFramesToReclaim"
> = {
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
  sightFramesUnsupported: false,
  outstandingSightFrames: [],
  prunedSightFrames: [],
  outstandingPhotoSends: 0,
  sightFrameRetractions: [],
  controls: null,
  utteranceOpen: false,
  screenShareTarget: null,
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
  errorRecovery: null,
};

/** Append reclaims not already queued, so a repeated refusal cannot duplicate. */
function mergeSightFrameReclaims(
  queued: readonly SightFrameReclaim[],
  next: readonly SightFrameReclaim[],
): readonly SightFrameReclaim[] {
  const seen = new Set(queued.map((r) => `${r.assistantId}/${r.attachmentId}`));
  return [
    ...queued,
    ...next.filter((r) => !seen.has(`${r.assistantId}/${r.attachmentId}`)),
  ];
}

/**
 * Push every waiting reclaim out by one job's worth of time.
 *
 * A send that goes out while reset-routed entries are still waiting lands
 * BEHIND the jobs they are waiting on, when it joins the same conversation
 * queue, so it moves their deadline by exactly what it adds. The daemon
 * serializes standalone persists per conversation, so a send in a different
 * conversation joins a different queue and moves nothing: extending across
 * conversations would let an active call's steady keeps hold an unrelated
 * orphan's deadline open for as long as the call runs. Event-driven and
 * bounded: one job's worth per send that actually happened, and an entry with
 * no deadline (a refusal routed it) is never given one.
 */
function extendPendingSightFrameReclaims(
  queued: readonly SightFrameReclaim[],
  conversationId: string | null,
): readonly SightFrameReclaim[] {
  if (conversationId === null) {
    return queued;
  }
  if (
    !queued.some(
      (entry) =>
        entry.notBefore !== undefined &&
        entry.conversationId === conversationId,
    )
  ) {
    return queued;
  }
  return queued.map((entry) =>
    entry.notBefore === undefined || entry.conversationId !== conversationId
      ? entry
      : {
          ...entry,
          notBefore: entry.notBefore + PER_JOB_CEILING_MS,
        },
  );
}

/**
 * The uploads a session boundary leaves unaccounted for.
 *
 * Reaching the transport is not an acknowledgement that anything was stored.
 * A socket that closes between the send and the persist takes the frame with
 * it, and the assistant answers nothing either way, so at a session boundary
 * every id still in the ledger is one nobody can say landed.
 *
 * They are queued for deletion rather than dropped, which is the same trade
 * the latch-time prune makes. Most of them DID persist and were simply never
 * acknowledged, and a delete aimed at a persisted frame is refused by the
 * daemon's link-awareness, so the cost is a burst of refused deletes bounded
 * by the ledger cap and its prunes. The alternative costs an upload that
 * genuinely was lost, kept for good, since nothing else collects an
 * attachment no message links.
 *
 * The race with a persist still running is benign in both directions. A
 * delete that lands first leaves the persist unable to resolve the
 * attachment, which fails that frame and reclaims nothing; one that lands
 * after the persist has read the row cannot take the bytes back out of the
 * message being written.
 */
function queueUnacknowledgedSightFrames(
  state: LiveVoiceState,
): readonly SightFrameReclaim[] {
  const assistantId = state.assistantId;
  const unacknowledged = [
    ...new Set([...state.prunedSightFrames, ...state.outstandingSightFrames]),
  ];
  if (assistantId === null || unacknowledged.length === 0) {
    return state.sightFramesToReclaim;
  }
  // Not before the daemon has had time to finish whatever it still had queued.
  //
  // The daemon runs standalone-image persists one at a time and never
  // supersedes a photo, so a keep can sit behind an arbitrary number of them,
  // and a fixed wait would be a guess. It does not have to be: this client is
  // the SOLE producer of that queue. Only `attach_image` and `sight_frame`
  // feed it (`live-voice-session.ts` dispatches them to `persistPhoto` and
  // `persistSightFrame`, the only two callers of the queue), both arrive on
  // one session's socket, and the daemon runs a single live-voice session at a
  // time. So the ledgers below enumerate everything that can possibly be
  // queued ahead, and the ceiling is that count plus this job, each at
  // `PER_JOB_CEILING_MS`.
  //
  // It over-counts on purpose: a photo that already persisted is still
  // counted, because nothing acknowledges one. Over-counting only ever waits
  // longer, which is the safe direction: a delete that fires while the
  // persist is still queued takes the frame with it, while one that waits
  // out jobs long finished merely leaves a lost upload uncollected for a
  // while. No cap trims the wait for the same reason, since any cap under
  // the queue's true drain time reopens the early delete.
  const queuedAhead = state.outstandingPhotoSends + unacknowledged.length;
  const notBefore = Date.now() + (queuedAhead + 1) * PER_JOB_CEILING_MS;
  const conversationId = state.conversationId ?? undefined;
  return mergeSightFrameReclaims(
    state.sightFramesToReclaim,
    unacknowledged.map((attachmentId) => ({
      assistantId,
      attachmentId,
      conversationId,
      notBefore,
    })),
  );
}

const useLiveVoiceStoreBase = create<LiveVoiceStore>()((set) => ({
  ...INITIAL_SESSION_STATE,
  starter: null,
  sessionGeneration: 0,
  sightFramesToReclaim: [],

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
      // Answered for, so it can no longer be queued ahead of anything.
      outstandingPhotoSends: Math.max(0, state.outstandingPhotoSends - 1),
    })),
  // The cap drops the OLDEST id, and a dropped id cannot become a wrong
  // deletion. Overflow only happens against an assistant that is answering
  // nothing, which is an assistant persisting the keeps; one that cannot take
  // the frame refuses the very first send, long before eight are in flight.
  // The pruned ids are kept anyway, and unioned into the reclaim queue if the
  // latch does fire, so nothing is dropped silently. Reclaiming a pruned id is
  // safe even when the assistant did persist it: the attachment delete is
  // refused for a row a message links.
  notePhotoSent: () =>
    set((s) => ({
      outstandingPhotoSends: s.outstandingPhotoSends + 1,
      sightFramesToReclaim: extendPendingSightFrameReclaims(
        s.sightFramesToReclaim,
        s.conversationId,
      ),
    })),
  noteSightFrameSent: (attachmentId) =>
    set((s) => {
      // This send joins its conversation's queue, so it moves the deadline of
      // exactly the reclaims waiting on that queue.
      const sightFramesToReclaim = extendPendingSightFrameReclaims(
        s.sightFramesToReclaim,
        s.conversationId,
      );
      const appended = [...s.outstandingSightFrames, attachmentId];
      if (appended.length <= SIGHT_FRAME_LEDGER_CAP) {
        return { outstandingSightFrames: appended, sightFramesToReclaim };
      }
      const overflow = appended.length - SIGHT_FRAME_LEDGER_CAP;
      return {
        outstandingSightFrames: appended.slice(overflow),
        prunedSightFrames: [
          ...s.prunedSightFrames,
          ...appended.slice(0, overflow),
        ].slice(-SIGHT_FRAME_LEDGER_CAP),
        sightFramesToReclaim,
      };
    }),
  noteSightFrameRefused: (unsupported, attachmentId = null) =>
    set((s) => {
      const outstanding = s.outstandingSightFrames;
      if (unsupported) {
        // Nothing this assistant was sent was stored, and it reclaims nothing,
        // so every id still accounted for is the client's to give back. The
        // named id joins them: an assistant that echoes one may be naming a
        // send the cap already pruned.
        const orphans = [
          ...new Set([
            ...s.prunedSightFrames,
            ...outstanding,
            ...(attachmentId === null ? [] : [attachmentId]),
          ]),
        ];
        const assistantId = s.assistantId;
        return {
          sightFramesUnsupported: true,
          // The share ends with the latch rather than merely pausing behind
          // it. The latch resets on a reconnect, which can land on an
          // upgraded assistant, and a target kept across that gap would
          // resume a share the surface had already drawn as stopped.
          screenShareTarget: null,
          outstandingSightFrames: [],
          prunedSightFrames: [],
          sightFramesToReclaim:
            assistantId === null
              ? s.sightFramesToReclaim
              : mergeSightFrameReclaims(
                  s.sightFramesToReclaim,
                  orphans.map((id) => ({ assistantId, attachmentId: id })),
                ),
        };
      }
      if (attachmentId !== null) {
        // Exact: the error names its own frame, so the ledger retires that
        // entry wherever it sits and the retraction speaks for that keep alone,
        // regardless of how many older sends are still unanswered.
        return {
          outstandingSightFrames: outstanding.filter(
            (id) => id !== attachmentId,
          ),
          prunedSightFrames: s.prunedSightFrames.filter(
            (id) => id !== attachmentId,
          ),
          sightFrameRetractions: [
            ...new Set([...s.sightFrameRetractions, attachmentId]),
          ],
        };
      }
      // Fallback for an assistant that names nothing: the refusal is about
      // exactly one unanswered send, with nothing to say which, so the only
      // honest answer for the surface is to take down every claim it might be
      // about. A retraction for a keep that quietly persisted costs only the
      // shared flash, since the frame itself sits in the transcript; leaving
      // the refused keep's flash up claims the call shared a frame it did
      // not. The ledgers keep every entry: retiring a guess would exempt it
      // from the reset-time reclaim, and that reclaim is what sorts the
      // persisted from the lost, refusing the delete for a frame a message
      // links and collecting the one nothing does.
      return {
        sightFrameRetractions: [
          ...new Set([
            ...s.sightFrameRetractions,
            ...s.prunedSightFrames,
            ...outstanding,
          ]),
        ],
      };
    }),
  takeDueSightFrameReclaims: (now) => {
    let taken: readonly SightFrameReclaim[] = [];
    // Read and split inside one updater, so nothing can be appended between
    // the two halves.
    set((s) => {
      const due = s.sightFramesToReclaim.filter(
        (entry) => entry.notBefore === undefined || entry.notBefore <= now,
      );
      if (due.length === 0) {
        return {};
      }
      taken = due;
      return {
        sightFramesToReclaim: s.sightFramesToReclaim.filter(
          (entry) => entry.notBefore !== undefined && entry.notBefore > now,
        ),
      };
    });
    return taken;
  },
  takeSightFrameRetractions: () => {
    let taken: readonly string[] = [];
    // Read and emptied inside one updater, so nothing can be appended between
    // the two halves.
    set((s) => {
      taken = s.sightFrameRetractions;
      return { sightFrameRetractions: [] };
    });
    return taken;
  },
  setControls: (controls) => set({ controls }),
  setStarter: (starter) => set({ starter }),
  setFirstRunCardOpen: (firstRunCardOpen) => set({ firstRunCardOpen }),
  setConfigNotice: (configNotice) => set({ configNotice }),
  setUtteranceOpen: (utteranceOpen) => set({ utteranceOpen }),
  setScreenShareTarget: (screenShareTarget) => set({ screenShareTarget }),
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
  fail: (message, recovery = null) =>
    set({ state: "failed", error: message, errorRecovery: recovery }),
  // The bump marks the session boundary for anything async that outlives the
  // session, a photo upload above all (see `attachLiveVoiceImage`). A reset
  // inside one logical session says so, and the generation holds.
  reset: (opts) =>
    set((s) => ({
      ...INITIAL_SESSION_STATE,
      sessionGeneration: opts?.sessionContinues
        ? s.sessionGeneration
        : s.sessionGeneration + 1,
      // A share survives a reconnect for the reason the generation does: the
      // user is still sharing, and the transport coming back is not their
      // business.
      screenShareTarget: opts?.sessionContinues ? s.screenShareTarget : null,
      // `sightFramesToReclaim` is absent from INITIAL_SESSION_STATE on purpose
      // and so survives this: a queue a teardown could discard would strand
      // the uploads it exists to collect. It also GROWS here, because the
      // ledgers this replaces hold sends nobody ever acknowledged. Both reset
      // kinds route them the same way, deliberately in the reset itself, so a
      // third kind cannot be added that forgets to.
      //
      // `sightFramesUnsupported` is the opposite and does reset, because the
      // latch is about the assistant that just answered and a reconnect can
      // land on an upgraded one.
      sightFramesToReclaim: queueUnacknowledgedSightFrames(s),
    })),
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
 * `sessionGeneration` is the generation read at the shutter press: the upload
 * between press and delivery can outlive the session the photo was taken in,
 * and a photo from an ended session fails here rather than landing in
 * whichever session is current when the upload resolves. Returns whether it
 * reached the pressed session: false when that session is over, when no
 * session exists, or when the transport is mid-reconnect, which the caller
 * must surface rather than treat as sent. Module-level for the same
 * stable-identity reasons as {@link endLiveVoiceSession}.
 */
export function attachLiveVoiceImage(
  attachmentId: string,
  sessionGeneration: number,
): boolean {
  const state = useLiveVoiceStore.getState();
  if (state.sessionGeneration !== sessionGeneration) {
    return false;
  }
  const sent = state.controls?.attachImage(attachmentId) ?? false;
  if (sent) {
    state.notePhotoSent();
  }
  return sent;
}

/**
 * Share a kept camera frame with the active session, by attachment id, so the
 * daemon persists it into the conversation as its own message.
 * `sessionGeneration` is the generation read when the frame was captured: the
 * upload between the keep and this call can outlive the session it was sampled
 * in, and a frame from an ended session is refused here rather than persisted
 * into whichever conversation is current. Returns whether it reached that
 * session. Module-level for the same stable-identity reasons as
 * {@link endLiveVoiceSession}.
 */
/**
 * Share `target` with the running session, or stop sharing with `null`.
 *
 * Module-level for the reason {@link endLiveVoiceSession} is: the command
 * arrives from the companion surface through main, and the root layout that
 * consumes it holds no session. A target is dropped unless a session is
 * running that can actually be shown it, since nothing could be shown one
 * otherwise and the surface would draw a share that never flows; the session's
 * own reset clears it at the end.
 *
 * The latch is one of the terms, not just the session. A picker left open
 * when the assistant refuses a frame is still pressable, and a target taken
 * from it would sit in the store unshown until a reconnect cleared the latch
 * and started capture off a gesture the user made before the refusal.
 */
export function setLiveVoiceScreenShare(
  target: WatchCaptureTarget | null,
): void {
  const state = useLiveVoiceStore.getState();
  if (
    target !== null &&
    (!isLiveVoiceSessionActive(state.state) || state.sightFramesUnsupported)
  ) {
    return;
  }
  state.setScreenShareTarget(target);
}

export function sendLiveVoiceSightFrame(
  attachmentId: string,
  sessionGeneration: number,
): boolean {
  const state = useLiveVoiceStore.getState();
  if (state.sessionGeneration !== sessionGeneration) {
    return false;
  }
  // An assistant that answered `unknown_type` once answers it every time, and
  // each attempt strands another attachment. See {@link sightFramesUnsupported}.
  if (state.sightFramesUnsupported) {
    return false;
  }
  const sent = state.controls?.sightFrame(attachmentId) ?? false;
  if (sent) {
    state.noteSightFrameSent(attachmentId);
  }
  return sent;
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
