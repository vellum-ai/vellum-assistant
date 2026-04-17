/**
 * MeetBargeInWatcher — auto-cancels in-flight TTS playback when a non-bot
 * speaker takes the floor while the bot is mid-utterance.
 *
 * High-level flow:
 *
 *   1. Track the bot's own DOM participant id by snooping
 *      {@link ParticipantChangeEvent}s on the dispatcher and remembering
 *      the joiner whose `isSelf === true`. Mirrors the same self-detection
 *      pattern used by {@link MeetSpeakerResolver} and
 *      {@link MeetConsentMonitor} — the bot's container always emits a
 *      participant.change with `isSelf: true` shortly after joining.
 *
 *   2. Subscribe to `meet.speaking_started` / `meet.speaking_ended` events
 *      on {@link assistantEventHub} (these are the lifecycle events fired
 *      by {@link MeetSessionManager.speak}). The watcher only arms its
 *      barge-in logic while a bot stream is active.
 *
 *   3. While the bot is speaking, watch for two trigger signals on the
 *      meeting's bot-event stream:
 *        - `SpeakerChangeEvent` with `speakerId !== botSpeakerId` —
 *          authoritative DOM signal that someone else has the floor.
 *        - `TranscriptChunkEvent` (interim, confidence > 0.6) attributed
 *          to a non-bot speaker — ASR-side signal that a non-bot voice
 *          is producing audio (catches cases where DOM lags).
 *
 *   4. When a trigger fires, schedule a cancel via
 *      {@link MeetSessionManager.cancelSpeak} after a {@link BARGE_IN_DEBOUNCE_MS}
 *      delay. If the bot stops speaking, the speaker switches back to the
 *      bot, or speaking ends within that window, the pending cancel is
 *      cleared. This prevents a brief cough or transient ASR mis-attribution
 *      from killing legitimate playback.
 *
 * Dependency injection keeps the watcher fully testable: subscribe + clock
 * + timer hooks all default to production wiring but can be swapped for
 * in-memory shims in unit tests.
 */

import type {
  MeetBotEvent,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "../contracts/index.js";

import {
  type AssistantEventCallback,
  type AssistantEventSubscription,
  assistantEventHub,
} from "../../../assistant/src/runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../assistant/src/runtime/assistant-scope.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";

const log = getLogger("meet-barge-in-watcher");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Delay between detecting a non-bot speaker trigger and actually invoking
 * cancel. Lets brief non-bot blips (a cough, a single mis-attributed ASR
 * chunk, the bot's own DOM tile flickering for one frame) pass without
 * killing legitimate playback. The plan calls out 250ms explicitly:
 * comfortably above typical DOM jitter, well below human perception of
 * conversational latency.
 */
export const BARGE_IN_DEBOUNCE_MS = 250;

/**
 * Minimum ASR confidence for an interim transcript chunk to count as a
 * non-bot voice signal. Lower-confidence chunks tend to be background
 * noise or speculative partials that don't yet justify cancelling
 * legitimate bot audio.
 */
export const BARGE_IN_INTERIM_CONFIDENCE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The minimal session-manager surface the watcher depends on. The real
 * {@link MeetSessionManager} satisfies this naturally.
 */
export interface BargeInCanceller {
  cancelSpeak(meetingId: string): Promise<void>;
}

export interface MeetBargeInWatcherDeps {
  meetingId: string;
  /** Drives the actual cancel — typically the active session manager. */
  sessionManager: BargeInCanceller;
  /**
   * Override the dispatcher subscribe (tests). Defaults to the production
   * {@link subscribeToMeetingEvents} helper.
   */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /**
   * Override the assistant-event-hub subscribe (tests). Defaults to the
   * process-level {@link assistantEventHub} singleton.
   */
  subscribeAssistantEvents?: (
    cb: AssistantEventCallback,
  ) => AssistantEventSubscription;
  /** Override `setTimeout` for tests that capture the timer handle. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Override `clearTimeout` paired with {@link setTimeoutFn}. */
  clearTimeoutFn?: (handle: unknown) => void;
  /**
   * Optional override for the debounce window (ms). Defaults to
   * {@link BARGE_IN_DEBOUNCE_MS}. Tests use this to make the window
   * deterministic without juggling the timer hook.
   */
  debounceMs?: number;
  /**
   * Optional override for the interim-chunk confidence floor. Defaults
   * to {@link BARGE_IN_INTERIM_CONFIDENCE_THRESHOLD}. Tests use this to
   * exercise the threshold without having to construct boundary-precision
   * floats.
   */
  interimConfidenceThreshold?: number;
}

// ---------------------------------------------------------------------------
// MeetBargeInWatcher
// ---------------------------------------------------------------------------

export class MeetBargeInWatcher {
  private readonly meetingId: string;
  private readonly sessionManager: BargeInCanceller;
  private readonly subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  private readonly subscribeAssistantEvents: (
    cb: AssistantEventCallback,
  ) => AssistantEventSubscription;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly debounceMs: number;
  private readonly interimConfidenceThreshold: number;

  /** Bot's DOM participant id, captured from the first `isSelf` joiner. */
  private botSpeakerId: string | null = null;

  /** Active bot TTS stream ids — non-empty means the bot is speaking. */
  private activeSpeakingStreams = new Set<string>();

  /** Debounce timer for a pending cancel. `null` when no cancel is queued. */
  private pendingCancelHandle: unknown = null;

  private dispatcherUnsubscribe: MeetEventUnsubscribe | null = null;
  private hubSubscription: AssistantEventSubscription | null = null;

  constructor(deps: MeetBargeInWatcherDeps) {
    this.meetingId = deps.meetingId;
    this.sessionManager = deps.sessionManager;
    this.subscribe = deps.subscribe ?? subscribeToMeetingEvents;
    this.subscribeAssistantEvents =
      deps.subscribeAssistantEvents ??
      ((cb) =>
        assistantEventHub.subscribe(
          { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
          cb,
        ));
    this.setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn =
      deps.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.debounceMs = deps.debounceMs ?? BARGE_IN_DEBOUNCE_MS;
    this.interimConfidenceThreshold =
      deps.interimConfidenceThreshold ?? BARGE_IN_INTERIM_CONFIDENCE_THRESHOLD;
  }

  /**
   * Begin observing the meeting. Idempotent — calling `start` twice is a
   * no-op so the session manager doesn't have to track lifecycle state.
   */
  start(): void {
    if (this.dispatcherUnsubscribe || this.hubSubscription) return;

    this.dispatcherUnsubscribe = this.subscribe(this.meetingId, (event) =>
      this.onMeetingEvent(event),
    );
    this.hubSubscription = this.subscribeAssistantEvents((event) =>
      this.onAssistantEvent(event),
    );
  }

  /**
   * Tear down the dispatcher + hub subscriptions and clear any pending
   * cancel timer. Idempotent.
   */
  stop(): void {
    this.clearPendingCancel();

    if (this.dispatcherUnsubscribe) {
      try {
        this.dispatcherUnsubscribe();
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetBargeInWatcher: dispatcher unsubscribe threw",
        );
      }
      this.dispatcherUnsubscribe = null;
    }

    if (this.hubSubscription) {
      try {
        this.hubSubscription.dispose();
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetBargeInWatcher: assistant-event-hub dispose threw",
        );
      }
      this.hubSubscription = null;
    }

    this.activeSpeakingStreams.clear();
  }

  /** Test-only: read the bot's discovered speaker id. */
  _getBotSpeakerId(): string | null {
    return this.botSpeakerId;
  }

  /** Test-only: read the bot-speaking flag. */
  _isBotSpeaking(): boolean {
    return this.activeSpeakingStreams.size > 0;
  }

  /** Test-only: true while a debounced cancel is queued. */
  _hasPendingCancel(): boolean {
    return this.pendingCancelHandle !== null;
  }

  // ── Event handling ────────────────────────────────────────────────────────

  private onMeetingEvent(event: MeetBotEvent): void {
    try {
      switch (event.type) {
        case "participant.change":
          this.onParticipantChange(event);
          return;
        case "speaker.change":
          this.onSpeakerChange(event);
          return;
        case "transcript.chunk":
          this.onTranscriptChunk(event);
          return;
        default:
          return;
      }
    } catch (err) {
      log.warn(
        { err, meetingId: this.meetingId, eventType: event.type },
        "MeetBargeInWatcher: meeting-event handler threw",
      );
    }
  }

  private onAssistantEvent(event: {
    message: { type: string; meetingId?: string };
  }): void {
    const message = event.message;
    // Filter to our own meeting only — the assistant event hub fans every
    // assistant event to every subscriber, so we have to gate on meetingId
    // ourselves. `meetingId` is part of the `meet.speaking_*` payload shape.
    if (message.meetingId !== this.meetingId) return;

    if (message.type === "meet.speaking_started") {
      const streamId = (message as { streamId?: string }).streamId;
      if (streamId) this.activeSpeakingStreams.add(streamId);
      this.clearPendingCancel();
      return;
    }

    if (message.type === "meet.speaking_ended") {
      const streamId = (message as { streamId?: string }).streamId;
      if (streamId) this.activeSpeakingStreams.delete(streamId);
      if (this.activeSpeakingStreams.size === 0) {
        this.clearPendingCancel();
      }
      return;
    }
  }

  private onParticipantChange(event: ParticipantChangeEvent): void {
    // Snapshot the bot's DOM participant id from the first `isSelf` joiner
    // we see. The bot's `isSelf` participant arrives shortly after the
    // container joins; once captured, we don't overwrite it (a re-join
    // would mint a new id, but in practice the watcher is dropped and
    // recreated alongside the session).
    if (this.botSpeakerId !== null) return;
    for (const participant of event.joined) {
      if (participant.isSelf === true) {
        this.botSpeakerId = participant.id;
        return;
      }
    }
  }

  private onSpeakerChange(event: SpeakerChangeEvent): void {
    if (this.activeSpeakingStreams.size === 0) return;

    if (this.botSpeakerId !== null && event.speakerId === this.botSpeakerId) {
      // Floor returned to the bot — cancel any debounced cancel that was
      // triggered by a transient non-bot blip.
      this.clearPendingCancel();
      return;
    }

    // Non-bot speaker took the floor (or we don't yet know the bot's id —
    // be conservative and treat unknown as non-bot, since the watcher only
    // fires while bot audio is mid-flight).
    this.scheduleCancel("speaker.change");
  }

  private onTranscriptChunk(event: TranscriptChunkEvent): void {
    if (this.activeSpeakingStreams.size === 0) return;
    // Only interim chunks count for barge-in: finals are too late to be
    // a useful real-time signal, and the speaker.change path covers the
    // authoritative DOM-derived signal.
    if (event.isFinal) return;

    if (event.confidence === undefined) return;
    if (event.confidence <= this.interimConfidenceThreshold) return;

    // Drop chunks attributed to the bot itself via `speakerId`. The bot is a
    // silent listener so this should be vanishingly rare, but cheap
    // defense-in-depth keeps us from firing on a mis-tagged echo of the
    // bot's own audio.
    if (
      this.botSpeakerId !== null &&
      event.speakerId !== undefined &&
      event.speakerId === this.botSpeakerId
    ) {
      return;
    }

    // ASR can produce interim chunks with no speaker attribution at all.
    // Those still count as a non-bot voice signal: the bot is a silent
    // listener, so any audible voice in the room is by definition not the
    // bot.
    this.scheduleCancel("transcript.chunk");
  }

  // ── Debounced cancel ──────────────────────────────────────────────────────

  private scheduleCancel(trigger: string): void {
    // If a cancel is already queued, leave it alone — the existing timer
    // will fire at its original deadline. Re-arming on every trigger would
    // *delay* the cancel, which is the opposite of what we want: we want
    // the first non-bot signal to start the clock and the cancel to fire
    // 250ms after that signal (subject to the bot resuming the floor).
    if (this.pendingCancelHandle !== null) return;

    this.pendingCancelHandle = this.setTimeoutFn(() => {
      this.pendingCancelHandle = null;
      // Re-check at fire time — all streams may have ended between
      // scheduling and firing, in which case there's nothing to cancel.
      if (this.activeSpeakingStreams.size === 0) return;

      log.info(
        { meetingId: this.meetingId, trigger },
        "Meet barge-in: cancelling in-flight TTS",
      );
      void this.sessionManager.cancelSpeak(this.meetingId).catch((err) => {
        log.warn(
          { err, meetingId: this.meetingId, trigger },
          "MeetBargeInWatcher: cancelSpeak rejected",
        );
      });
    }, this.debounceMs);
  }

  private clearPendingCancel(): void {
    if (this.pendingCancelHandle === null) return;
    try {
      this.clearTimeoutFn(this.pendingCancelHandle);
    } catch (err) {
      log.warn(
        { err, meetingId: this.meetingId },
        "MeetBargeInWatcher: clearTimeout threw",
      );
    }
    this.pendingCancelHandle = null;
  }
}
