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
  capture?: LiveVoicePcmCaptureLike;
  playback?: LiveVoicePcmPlaybackLike;
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
  private readonly capture: LiveVoicePcmCaptureLike;
  private readonly playback: LiveVoicePcmPlaybackLike;
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
    this.capture = deps.capture ?? new LiveVoicePcmCapture();
    this.playback = deps.playback ?? new LiveVoicePcmPlayback();
    this.store = deps.store ?? useLiveVoiceStore;
  }

  // -------------------------------------------------------------------------
  // Public API (mirrors `LiveVoiceChannelManaging` from VoiceModeManager.swift)
  // -------------------------------------------------------------------------

  async start(conversationId: string): Promise<void> {
    this.sessionGeneration += 1;
    this.playbackReadyForResponse = false;
    this.isUserMuted = false;

    const actions = this.actions();
    actions.setState("connecting");
    actions.setError("");

    // Build a fresh client for this session — see the field comment
    // for why the client must not be reused across sessions.
    this.client = this.clientFactory();
    await this.client.start({
      conversationId,
      onEvent: (event) => this.handleEvent(event),
      onFailure: (failure) => this.handleFailure(failure),
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
    this.playback.handleInterrupt();
    // The playback gate is now closed; the next assistant response's
    // first `ttsAudio` must call `resetForNextResponse()` before
    // enqueueing.
    this.playbackReadyForResponse = false;
    await this.startCapture();
  }

  async stopListening(): Promise<void> {
    this.isUserMuted = true;
    this.client?.releasePushToTalk();
    this.capture.stop();
  }

  async end(): Promise<void> {
    // Bump the generation so any in-flight `ttsDone` continuation that
    // resumes after this teardown bails before touching state.
    this.sessionGeneration += 1;
    this.playbackReadyForResponse = false;

    this.capture.shutdown();
    this.playback.handleEnd();
    await this.client?.end();
    // Drop the closed client so the next `start()` builds a fresh one.
    this.client = null;
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
          this.playback.resetForNextResponse();
          this.playbackReadyForResponse = true;
        }
        this.playback.enqueueTtsAudio({
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
    this.capture.shutdown();
    this.playback.handleInterrupt();
    this.client?.close();
    // Drop the closed client so the next `start()` builds a fresh one.
    this.client = null;
  }

  private async completeAssistantTurn(): Promise<void> {
    // Capture the generation before awaiting playback so we can detect
    // a teardown (`end()` / failure) that happens while we wait. Without
    // this guard the post-await mutations would clobber `off` / `failed`
    // with `listening` and re-open the playback gate for a session that
    // no longer exists.
    const myGeneration = this.sessionGeneration;
    await this.playback.waitUntilPlaybackFinishes();
    if (myGeneration !== this.sessionGeneration) {
      return;
    }
    // Re-arm the gate flag so the next response's first `ttsAudio`
    // calls `resetForNextResponse()` again before enqueueing.
    this.playbackReadyForResponse = false;
    this.playback.resetForNextResponse();
    const actions = this.actions();
    // Clear the rolling assistant transcript so the next turn starts
    // from a clean buffer.
    actions.clearAssistantTranscript();
    // Skip the transition back to `listening` if the user explicitly
    // muted via `stopListening()` — re-arming the mic would silently
    // override the user's mute. The next user action
    // (`interruptSpeakingAndStartListening` or `end`) drives the next
    // state transition.
    if (this.isUserMuted) {
      return;
    }
    actions.setState("listening");
  }

  // -------------------------------------------------------------------------
  // Capture lifecycle
  // -------------------------------------------------------------------------

  private async startCapture(): Promise<void> {
    const started = await this.capture.start({
      onChunk: (chunk) => {
        this.client?.sendAudio(chunk.pcm16);
      },
      onAmplitude: (amplitude) => {
        this.actions().setInputAmplitude(amplitude);
      },
    });
    if (!started) return;
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
