/**
 * LiveVoiceChannelManager — orchestrates the live voice session lifecycle.
 *
 * TypeScript port of the public surface of
 * `clients/macos/vellum-assistant/Features/Voice/LiveVoiceChannelManager.swift`.
 *
 * Wires together three collaborators:
 *
 *   - `LiveVoiceChannelClient` — WebSocket transport (`/v1/live-voice`).
 *   - `LiveVoicePcmCapture` — 16 kHz mono microphone capture.
 *   - `LiveVoicePcmPlayback` — gapless TTS playback.
 *
 * State lives in the `useLiveVoiceStore` Zustand store; the manager is
 * pure logic (no React) and mutates the store via `getState()`. The
 * `state` field tracks the same machine as the macOS app:
 * `off → connecting → listening → transcribing → thinking → speaking →
 * ending`, with a `failed` branch on error.
 *
 * Collaborators are constructor-injected so tests can pass minimal fakes
 * without touching the DOM, WebSocket, or Web Audio APIs.
 */

import type {
  LiveVoiceChannelEvent,
  LiveVoiceChannelFailure,
  LiveVoiceChannelStartOptions,
} from "@/domains/voice/live-voice/live-voice-channel-client";
import { LiveVoiceChannelClient } from "@/domains/voice/live-voice/live-voice-channel-client";
import type {
  LiveVoiceStore,
  LiveVoiceStoreActions,
  LiveVoiceStoreState,
} from "@/domains/voice/live-voice/live-voice-store";
import { useLiveVoiceStore } from "@/domains/voice/live-voice/live-voice-store";
import type { LiveVoicePcmCaptureStartOptions } from "@/domains/voice/live-voice/pcm-capture";
import { LiveVoicePcmCapture } from "@/domains/voice/live-voice/pcm-capture";
import type { LiveVoiceTtsChunk } from "@/domains/voice/live-voice/pcm-playback";
import { LiveVoicePcmPlayback } from "@/domains/voice/live-voice/pcm-playback";

// ---------------------------------------------------------------------------
// Dependency contracts
// ---------------------------------------------------------------------------

/**
 * Subset of `LiveVoiceChannelClient` the manager depends on. The fake
 * used in tests captures the `onEvent` / `onFailure` callbacks from
 * `start()` so the test can drive event sequences synchronously.
 */
export interface LiveVoiceChannelClientLike {
  start(options: LiveVoiceChannelStartOptions): Promise<void>;
  sendAudio(data: ArrayBuffer | Int16Array): void;
  releasePushToTalk(): void;
  interrupt(): void;
  end(): Promise<void>;
  close(): void;
}

/** Subset of `LiveVoicePcmCapture` the manager depends on. */
export interface LiveVoicePcmCaptureLike {
  start(options: LiveVoicePcmCaptureStartOptions): Promise<boolean>;
  stop(): void;
  shutdown(): void;
}

/** Subset of `LiveVoicePcmPlayback` the manager depends on. */
export interface LiveVoicePcmPlaybackLike {
  readonly isPlaying: boolean;
  enqueueTtsAudio(chunk: LiveVoiceTtsChunk): void;
  handleInterrupt(): void;
  handleEnd(): void;
  handleSessionError(): void;
  resetForNextResponse(): void;
  waitUntilPlaybackFinishes(): Promise<void>;
}

/**
 * Minimal store surface the manager pokes from outside React. Matches
 * the `getState()` shape of `useLiveVoiceStore`; tests pass a fake that
 * records mutations without spinning up the real Zustand store.
 */
export interface LiveVoiceStoreLike {
  getState(): LiveVoiceStore;
}

export interface LiveVoiceChannelManagerDeps {
  /**
   * Factory invoked once per `start()` to create a fresh
   * `LiveVoiceChannelClient`. The underlying client is single-shot —
   * after `end()` or a failure transitions it to `closed`, calling
   * `start()` on the same instance is a no-op. We must instantiate a
   * new client each time the manager starts a session.
   */
  clientFactory?: () => LiveVoiceChannelClientLike;
  /**
   * Factory invoked once per `start()` to create a fresh
   * `LiveVoicePcmCapture`. Like the client, capture is single-shot:
   * `shutdown()` (called by `end()` / failure paths) sets
   * `isShutdown = true` and subsequent `start()` calls return `false`
   * without ever restarting the microphone. We must instantiate a new
   * capture each time the manager starts a session, otherwise the
   * second session's `ready` event never transitions out of
   * `connecting`.
   */
  captureFactory?: () => LiveVoicePcmCaptureLike;
  /**
   * Factory invoked once per `start()` to create a fresh
   * `LiveVoicePcmPlayback`. Mirrors the capture factory rationale —
   * playback teardown flips a one-shot disabled bit, so reusing the
   * same instance across sessions leaves the next response unable to
   * play any audio.
   */
  playbackFactory?: () => LiveVoicePcmPlaybackLike;
  store?: LiveVoiceStoreLike;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const DEFAULT_FAILURE_MESSAGE = "Live voice session failed";

export class LiveVoiceChannelManager {
  /**
   * Per-session client factory. We construct a fresh client in `start()`
   * because `LiveVoiceChannelClient` is single-shot: once `end()` /
   * `close()` move it to the `closed` state, subsequent `start()`
   * calls early-return without ever emitting a `ready` event.
   */
  private readonly clientFactory: () => LiveVoiceChannelClientLike;
  private client: LiveVoiceChannelClientLike | null = null;
  /**
   * Per-session capture factory. We construct a fresh capture in
   * `start()` because `LiveVoicePcmCapture.shutdown()` (called by
   * `end()` / failure teardown) sets `isShutdown = true` and later
   * `start()` returns `false`. Reusing the same instance across
   * sessions left the next session's `ready` event unable to restart
   * the microphone — the UI stayed stuck in `connecting` forever.
   */
  private readonly captureFactory: () => LiveVoicePcmCaptureLike;
  private capture: LiveVoicePcmCaptureLike | null = null;
  /**
   * Per-session playback factory. Mirrors `captureFactory` — playback
   * teardown is also one-shot disable, so a reused instance silently
   * drops every subsequent response's audio.
   */
  private readonly playbackFactory: () => LiveVoicePcmPlaybackLike;
  private playback: LiveVoicePcmPlaybackLike | null = null;
  private readonly store: LiveVoiceStoreLike;

  /**
   * Monotonically incremented whenever the session boundary changes
   * (`start`, `end`, failure). The `ttsDone` continuation captures this
   * before awaiting `waitUntilPlaybackFinishes()` and bails after the
   * await if it no longer matches — that race lets us avoid clobbering
   * the `off`/`failed` state that teardown set while we were waiting,
   * and prevents `resetForNextResponse()` from re-opening the playback
   * gate after the session has gone away.
   */
  private sessionGeneration = 0;

  /**
   * Tracks whether `playback.resetForNextResponse()` has been called for
   * the current assistant response. The PCM playback flips its
   * `acceptsAudio` gate closed on `handleInterrupt` / `handleEnd`, so
   * the first `ttsAudio` of every new response must re-open the gate
   * before enqueueing — otherwise the chunk is silently dropped (e.g.
   * the barge-in -> new utterance flow leaves the assistant mute).
   */
  private playbackReadyForResponse = false;

  /**
   * Set to `true` by `stopListening()` (user pressed PTT-release) and
   * cleared by `start()` / `interruptSpeakingAndStartListening()`. When
   * a `ttsDone` continuation lands after the user has muted, we skip
   * the transition back to `listening` so the UI does not silently
   * re-arm the mic against the user's wish.
   */
  private isUserMuted = false;

  constructor(deps: LiveVoiceChannelManagerDeps = {}) {
    this.clientFactory =
      deps.clientFactory ?? (() => new LiveVoiceChannelClient());
    this.captureFactory =
      deps.captureFactory ?? (() => new LiveVoicePcmCapture());
    this.playbackFactory =
      deps.playbackFactory ?? (() => new LiveVoicePcmPlayback());
    this.store = deps.store ?? useLiveVoiceStore;
  }

  // -------------------------------------------------------------------------
  // Public API (mirrors `LiveVoiceChannelManaging` from VoiceModeManager.swift)
  // -------------------------------------------------------------------------

  async start(conversationId: string): Promise<void> {
    this.sessionGeneration += 1;
    // Snapshot the generation at handler-registration time. Server frames
    // that arrive after `end()` / failure (which bump the generation) are
    // dropped at the dispatch boundary so they cannot leak STT, assistant
    // text, or TTS playback from a torn-down session into the global
    // store — e.g. a conversation switch during the 1s `end()` grace
    // window must not surface frames from the old conversation in the
    // new conversation's UI.
    const sessionGen = this.sessionGeneration;
    this.playbackReadyForResponse = false;
    this.isUserMuted = false;

    const actions = this.actions();
    actions.setState("connecting");
    actions.setError("");

    // Build a fresh client/capture/playback for this session — see the
    // field comments for why these must not be reused across sessions.
    this.client = this.clientFactory();
    this.capture = this.captureFactory();
    this.playback = this.playbackFactory();
    await this.client.start({
      conversationId,
      onEvent: (event) => {
        if (sessionGen !== this.sessionGeneration) return;
        this.handleEvent(event);
      },
      onFailure: (failure) => {
        if (sessionGen !== this.sessionGeneration) return;
        this.handleFailure(failure);
      },
    });
  }

  async interruptSpeakingAndStartListening(
    // Conversation id is part of the macOS protocol surface so callers
    // can swap conversations atomically. The current web manager
    // assumes the existing channel matches and just resumes capture —
    // future work can reopen the channel when the id changes.
    _conversationId: string,
  ): Promise<void> {
    this.isUserMuted = false;
    this.client?.interrupt();
    this.playback?.handleInterrupt();
    // The playback gate is now closed; the next assistant response's
    // first `ttsAudio` must call `resetForNextResponse()` before
    // enqueueing.
    this.playbackReadyForResponse = false;
    await this.startCapture();
  }

  async stopListening(): Promise<void> {
    this.isUserMuted = true;
    this.client?.releasePushToTalk();
    this.capture?.stop();
  }

  async end(): Promise<void> {
    // Bump the generation so any in-flight `ttsDone` continuation that
    // resumes after this teardown bails before touching state.
    this.sessionGeneration += 1;
    this.playbackReadyForResponse = false;

    this.capture?.shutdown();
    this.playback?.handleEnd();
    await this.client?.end();
    // Drop the closed collaborators so the next `start()` builds fresh
    // ones — `shutdown()` permanently disables capture/playback.
    this.client = null;
    this.capture = null;
    this.playback = null;
    this.actions().reset();
  }

  // -------------------------------------------------------------------------
  // Event mapping
  // -------------------------------------------------------------------------

  private handleEvent(event: LiveVoiceChannelEvent): void {
    const actions = this.actions();
    switch (event.type) {
      case "ready":
        actions.setSessionInfo({
          sessionId: event.sessionId,
          conversationId: event.conversationId,
        });
        void this.startCapture();
        return;
      case "sttPartial":
        actions.setPartialTranscript(event.text);
        actions.setState("transcribing");
        return;
      case "sttFinal":
        actions.setFinalTranscript(event.text);
        actions.setPartialTranscript("");
        return;
      case "thinking":
        actions.setState("thinking");
        // Reset the rolling assistant transcript at the start of each
        // response — mirrors `prepareForAssistantResponse()` in
        // `LiveVoiceChannelManager.swift`.
        actions.clearAssistantTranscript();
        return;
      case "assistantTextDelta":
        if (this.currentState() !== "speaking") {
          actions.setState("speaking");
        }
        actions.appendAssistantTranscript(event.text);
        return;
      case "ttsAudio":
        // The PCM playback's `acceptsAudio` gate is flipped closed by
        // any prior `handleInterrupt` / `handleEnd` / `ttsDone`. The
        // first audio chunk of a new response must re-open the gate
        // before enqueueing so the assistant's reply is actually heard.
        if (!this.playbackReadyForResponse) {
          this.playback?.resetForNextResponse();
          this.playbackReadyForResponse = true;
        }
        this.playback?.enqueueTtsAudio({
          pcm: event.pcm,
          mimeType: event.mimeType,
          sampleRate: event.sampleRate,
          channels: 1,
        });
        return;
      case "ttsDone":
        void this.completeAssistantTurn();
        return;
      case "metrics":
        // Best-effort logging — metrics are diagnostic only.
        console.debug("[LiveVoiceChannelManager] metrics", event.metrics);
        return;
      case "archived":
        // No state change; just record the archival for diagnostics.
        console.debug(
          "[LiveVoiceChannelManager] archived",
          event.conversationId,
          event.sessionId,
        );
        return;
    }
  }

  private handleFailure(failure: LiveVoiceChannelFailure): void {
    // Bump the generation so any in-flight `ttsDone` continuation that
    // resumes after this teardown bails before touching state.
    this.sessionGeneration += 1;
    this.playbackReadyForResponse = false;

    const message = this.failureMessage(failure);
    const actions = this.actions();
    actions.setError(message);
    actions.setState("failed");

    // Same teardown as `end()` minus the protocol `end` frame — the
    // channel is already gone, so we use `close()` instead.
    this.capture?.shutdown();
    this.playback?.handleInterrupt();
    this.client?.close();
    // Drop the closed collaborators so the next `start()` builds fresh
    // ones — `shutdown()` permanently disables capture/playback.
    this.client = null;
    this.capture = null;
    this.playback = null;
  }

  private async completeAssistantTurn(): Promise<void> {
    // Capture the generation before awaiting playback so we can detect
    // a teardown (`end()` / failure) that happens while we wait. Without
    // this guard the post-await mutations would clobber `off` / `failed`
    // with `listening` and re-open the playback gate for a session that
    // no longer exists.
    const myGeneration = this.sessionGeneration;
    await this.playback?.waitUntilPlaybackFinishes();
    if (myGeneration !== this.sessionGeneration) {
      return;
    }
    // Re-arm the gate flag so the next response's first `ttsAudio`
    // calls `resetForNextResponse()` again before enqueueing.
    this.playbackReadyForResponse = false;
    this.playback?.resetForNextResponse();
    const actions = this.actions();
    // Clear the rolling assistant transcript so the next turn starts
    // from a clean buffer.
    actions.clearAssistantTranscript();
    // If the user has called `stopListening()` (i.e. PTT-released), the
    // assistant server treats the `ptt_release` as terminal for this
    // session — subsequent audio frames are rejected or ignored. The
    // WebSocket is logically dead, so tear it down here instead of
    // dangling in a half-alive state. The next user action will
    // `start()` a fresh session.
    if (this.isUserMuted) {
      await this.end();
      return;
    }
    actions.setState("listening");
  }

  // -------------------------------------------------------------------------
  // Capture lifecycle
  // -------------------------------------------------------------------------

  private async startCapture(): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    const started = await capture.start({
      onChunk: (chunk) => {
        this.client?.sendAudio(chunk.pcm16);
      },
      onAmplitude: (amplitude) => {
        this.actions().setInputAmplitude(amplitude);
      },
    });
    // A concurrent `end()` / failure may have nulled or replaced
    // `this.capture` while we awaited start(). If so the session is
    // gone and we must not clobber the resulting `off` / `failed` state.
    if (this.capture !== capture) return;
    if (!started) {
      // Capture failed to start (mic permission denied, suspended-
      // context resume rejection, worklet load failure, etc.).
      // Without audio frames the WS would dangle in `connecting`
      // forever — its 10s timeout was already cleared by the `ready`
      // frame. Surface as a connection failure so the overlay shows the
      // error and the button enters retry mode.
      this.handleFailure({
        type: "connectionFailed",
        message: "Microphone permission denied or unavailable",
      });
      return;
    }
    if (this.currentState() !== "failed") {
      this.actions().setState("listening");
    }
  }

  // -------------------------------------------------------------------------
  // Store helpers
  // -------------------------------------------------------------------------

  private actions(): LiveVoiceStoreActions {
    return this.store.getState();
  }

  private currentState(): LiveVoiceStoreState["state"] {
    return this.store.getState().state;
  }

  private failureMessage(failure: LiveVoiceChannelFailure): string {
    switch (failure.type) {
      case "connectionFailed":
      case "protocolError":
      case "timeout":
        return failure.message || DEFAULT_FAILURE_MESSAGE;
      case "abnormalClosure":
        return failure.reason || DEFAULT_FAILURE_MESSAGE;
      case "busy":
      case "connectionRejected":
        return DEFAULT_FAILURE_MESSAGE;
    }
  }
}
