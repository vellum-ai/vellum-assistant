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
  client?: LiveVoiceChannelClientLike;
  capture?: LiveVoicePcmCaptureLike;
  playback?: LiveVoicePcmPlaybackLike;
  store?: LiveVoiceStoreLike;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const DEFAULT_FAILURE_MESSAGE = "Live voice session failed";

export class LiveVoiceChannelManager {
  private readonly client: LiveVoiceChannelClientLike;
  private readonly capture: LiveVoicePcmCaptureLike;
  private readonly playback: LiveVoicePcmPlaybackLike;
  private readonly store: LiveVoiceStoreLike;

  constructor(deps: LiveVoiceChannelManagerDeps = {}) {
    this.client = deps.client ?? new LiveVoiceChannelClient();
    this.capture = deps.capture ?? new LiveVoicePcmCapture();
    this.playback = deps.playback ?? new LiveVoicePcmPlayback();
    this.store = deps.store ?? useLiveVoiceStore;
  }

  // -------------------------------------------------------------------------
  // Public API (mirrors `LiveVoiceChannelManaging` from VoiceModeManager.swift)
  // -------------------------------------------------------------------------

  async start(conversationId: string): Promise<void> {
    const actions = this.actions();
    actions.setState("connecting");
    actions.setError("");

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
    this.client.interrupt();
    this.playback.handleInterrupt();
    await this.startCapture();
  }

  async stopListening(): Promise<void> {
    this.client.releasePushToTalk();
    this.capture.stop();
  }

  async end(): Promise<void> {
    this.capture.shutdown();
    this.playback.handleEnd();
    await this.client.end();
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
    const message = this.failureMessage(failure);
    const actions = this.actions();
    actions.setError(message);
    actions.setState("failed");

    // Same teardown as `end()` minus the protocol `end` frame — the
    // channel is already gone, so we use `close()` instead.
    this.capture.shutdown();
    this.playback.handleInterrupt();
    this.client.close();
  }

  private async completeAssistantTurn(): Promise<void> {
    await this.playback.waitUntilPlaybackFinishes();
    this.playback.resetForNextResponse();
    const actions = this.actions();
    // Clear the rolling assistant transcript so the next turn starts
    // from a clean buffer.
    actions.clearAssistantTranscript();
    actions.setState("listening");
  }

  // -------------------------------------------------------------------------
  // Capture lifecycle
  // -------------------------------------------------------------------------

  private async startCapture(): Promise<void> {
    const started = await this.capture.start({
      onChunk: (chunk) => {
        this.client.sendAudio(chunk.pcm16);
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
