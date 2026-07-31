import type {
  LiveVoiceBusyServerFrame,
  LiveVoiceReadyServerFrame,
} from "@vellumai/service-contracts/live-voice";

import type {
  EchoMeasurementSummary,
  LiveVoiceMode,
  LiveVoicePcmCapture,
  LiveVoicePcmCaptureSession,
  LiveVoicePcmPlayback,
} from "./audio.js";
import {
  EchoMeasurement,
  LIVE_VOICE_PCM_FRAME_BYTES,
  pcm16Rms,
} from "./audio.js";
import type {
  LiveVoiceChannelClientEventMap,
  LiveVoiceChannelClient,
} from "./channel-client.js";

export const LIVE_VOICE_BUSY_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;
const LIVE_VOICE_BUSY_RETRY_BUDGET_MS = 2_000;
const MAX_ECHO_AMPLITUDE_SAMPLES = 1_200;

export type LiveVoiceCaptionMode = "off" | "user" | "assistant" | "both";
export type { LiveVoiceMode } from "./audio.js";

export const LIVE_VOICE_CAPTION_MODES = [
  "off",
  "user",
  "assistant",
  "both",
] as const satisfies readonly LiveVoiceCaptionMode[];

export type LiveVoiceForegroundState =
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "busy"
  | "failed"
  | "ended";

export interface LiveVoiceTimingMetric {
  readonly name: "socket_ready" | "input_end_to_first_tts";
  readonly durationMs: number;
}

export type LiveVoiceSessionChannel = Pick<
  LiveVoiceChannelClient,
  "on" | "connect" | "sendAudio" | "pttRelease" | "interrupt" | "end" | "close"
>;

export interface LiveVoiceSessionEndpoint {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LiveVoiceForegroundSessionOptions {
  readonly resolveEndpoint: () => Promise<LiveVoiceSessionEndpoint>;
  readonly createChannel: (
    endpoint: LiveVoiceSessionEndpoint,
  ) => LiveVoiceSessionChannel;
  readonly capture: LiveVoicePcmCapture;
  readonly playback: LiveVoicePcmPlayback;
  readonly mode?: LiveVoiceMode;
  readonly inputDevice?: string;
  readonly conversationId?: string;
  readonly captions?: LiveVoiceCaptionMode;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onState?: (state: LiveVoiceForegroundState) => void;
  readonly onCaption?: (role: "user" | "assistant", text: string) => void;
  readonly onCaptionMode?: (mode: LiveVoiceCaptionMode) => void;
  readonly onModeChange?: (mode: LiveVoiceMode, reason: string) => void;
  readonly onMicrophoneState?: (muted: boolean) => void;
  readonly onEchoSummary?: (summary: EchoMeasurementSummary) => void;
  readonly onTiming?: (metric: LiveVoiceTimingMetric) => void;
  readonly onError?: (error: Error) => void;
}

type HandshakeResult =
  | { readonly type: "ready"; readonly frame: LiveVoiceReadyServerFrame }
  | { readonly type: "busy"; readonly frame: LiveVoiceBusyServerFrame };

export class LiveVoiceForegroundSession {
  private readonly now: () => number;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly abortController = new AbortController();
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  private state: LiveVoiceForegroundState = "ended";
  private captionMode: LiveVoiceCaptionMode;
  private mode: LiveVoiceMode;
  private muted = false;
  private channel: LiveVoiceSessionChannel | null = null;
  private captureSession: LiveVoicePcmCaptureSession | null = null;
  private conversationId: string | undefined;
  private previousSessionId: string | undefined;
  private inputEndedAt: number | null = null;
  private firstTtsRecorded = false;
  private captureGeneration = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private failure: Error | null = null;
  private keyOperations: Promise<void> = Promise.resolve();
  private frameOperations: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private playbackGeneration = 0;
  private acceptingTts = true;
  private readonly echoMeasurement = new EchoMeasurement();
  private readonly playbackAmplitudes: number[] = [];
  private playbackAmplitudeIndex = 0;
  private lastMicrophoneAmplitude = 0;

  constructor(private readonly options: LiveVoiceForegroundSessionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? abortableDelay;
    this.captionMode = options.captions ?? "off";
    this.mode = options.mode ?? "push-to-talk";
    this.conversationId = options.conversationId;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get currentState(): LiveVoiceForegroundState {
    return this.state;
  }

  get fatalError(): Error | null {
    return this.failure;
  }

  get currentMode(): LiveVoiceMode {
    return this.mode;
  }

  async start(): Promise<void> {
    if (this.shuttingDown || this.channel !== null) {
      return;
    }
    try {
      await this.openChannel();
      if (this.reconnecting) {
        return;
      }
      if (this.mode === "open-mic") {
        await this.beginCapture();
        this.options.onMicrophoneState?.(this.muted);
      } else {
        this.setState("ready");
      }
    } catch (error) {
      await this.fail(toError(error));
      throw this.failure ?? new Error("Live voice failed to start.");
    }
  }

  handleKey(key: "enter" | "interrupt" | "captions" | "mute"): Promise<void> {
    const operation = this.keyOperations.then(async () => {
      if (this.shuttingDown) {
        return;
      }
      if (key === "captions") {
        this.cycleCaptions();
        return;
      }
      if (key === "interrupt") {
        await this.interruptReply();
        return;
      }
      if (key === "mute") {
        this.toggleMute();
        return;
      }
      if (this.mode === "open-mic") {
        return;
      }
      if (this.state === "ready") {
        await this.beginCapture();
      } else if (this.state === "listening") {
        await this.releaseCapture();
      }
    });
    this.keyOperations = operation.catch(async (error) => {
      if (!this.shuttingDown) {
        await this.fail(toError(error));
      }
    });
    return this.keyOperations;
  }

  waitUntilClosed(): Promise<void> {
    return this.closedPromise;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async beginCapture(): Promise<void> {
    const channel = this.channel;
    if (channel === null) {
      throw new Error("Live voice is not connected.");
    }

    const generation = ++this.captureGeneration;
    this.setState("listening");
    const captureSession = await this.options.capture.startCapture({
      target: this.options.inputDevice,
      onFrame: (frame, rmsAmplitude) => {
        const microphoneAmplitude = this.muted ? 0 : rmsAmplitude;
        this.recordEchoSample(microphoneAmplitude);
        if (
          generation === this.captureGeneration &&
          (this.mode === "open-mic" || this.state === "listening") &&
          this.channel === channel
        ) {
          channel.sendAudio(this.muted ? Buffer.alloc(frame.length) : frame);
        }
      },
    });
    if (this.shuttingDown || generation !== this.captureGeneration) {
      await captureSession.stop();
      return;
    }
    captureSession.setMuted(this.muted);
    this.captureSession = captureSession;
    void captureSession.closed.catch((error) => {
      if (!this.shuttingDown && this.captureSession === captureSession) {
        void this.fail(toError(error));
      }
    });
  }

  private async releaseCapture(): Promise<void> {
    const channel = this.channel;
    const captureSession = this.captureSession;
    if (channel === null || captureSession === null) {
      return;
    }

    const tail = await captureSession.stop();
    if (this.captureSession === captureSession) {
      this.captureSession = null;
    }
    if (this.shuttingDown || this.channel !== channel) {
      return;
    }
    if (tail !== null) {
      channel.sendAudio(tail);
    }
    this.inputEndedAt = this.now();
    this.firstTtsRecorded = false;
    channel.pttRelease();
    this.setState("transcribing");
  }

  private async interruptReply(): Promise<void> {
    if (
      this.channel === null ||
      (this.state !== "thinking" && this.state !== "speaking")
    ) {
      return;
    }
    this.cancelPlaybackGeneration();
    this.channel.interrupt();
    await this.options.playback.flush();
    this.finishEchoMeasurement();
    if (this.mode === "open-mic") {
      this.setState("listening");
    }
  }

  private toggleMute(): void {
    if (this.mode !== "open-mic" || this.captureSession === null) {
      return;
    }
    this.muted = !this.muted;
    this.captureSession.setMuted(this.muted);
    this.options.onMicrophoneState?.(this.muted);
  }

  private cycleCaptions(): void {
    const index = LIVE_VOICE_CAPTION_MODES.indexOf(this.captionMode);
    this.captionMode =
      LIVE_VOICE_CAPTION_MODES[(index + 1) % LIVE_VOICE_CAPTION_MODES.length];
    this.options.onCaptionMode?.(this.captionMode);
  }

  private async openChannel(): Promise<void> {
    const retryStartedAt = this.now();
    let retryIndex = 0;

    while (!this.shuttingDown) {
      const endpoint = await this.options.resolveEndpoint();
      if (this.shuttingDown) {
        throw new Error("Live voice stopped before connecting.");
      }
      const channel = this.options.createChannel(endpoint);
      this.channel = channel;
      const openedAt = this.now();
      let result: HandshakeResult;
      try {
        result = await this.connectChannel(channel);
      } catch (error) {
        if (this.channel === channel) {
          this.channel = null;
        }
        channel.close();
        throw error;
      }

      if (result.type === "ready") {
        this.previousSessionId = result.frame.sessionId;
        this.conversationId = result.frame.conversationId;
        if (
          this.mode === "open-mic" &&
          result.frame.turnDetection !== "server_vad"
        ) {
          this.mode = "push-to-talk";
          this.muted = false;
          this.options.onModeChange?.(
            this.mode,
            "The assistant did not confirm server voice activity detection. Falling back to push-to-talk.",
          );
        }
        this.options.onTiming?.({
          name: "socket_ready",
          durationMs: nonNegativeDuration(this.now() - openedAt),
        });
        return;
      }

      this.channel = null;
      const activeSessionId = result.frame.activeSessionId;
      if (
        this.previousSessionId === undefined ||
        activeSessionId !== this.previousSessionId
      ) {
        throw new Error(
          `Another live-voice session is active (${activeSessionId}). Try again after it ends.`,
        );
      }

      const delay = LIVE_VOICE_BUSY_RETRY_DELAYS_MS[retryIndex];
      const elapsed = this.now() - retryStartedAt;
      if (
        delay === undefined ||
        elapsed + delay > LIVE_VOICE_BUSY_RETRY_BUDGET_MS
      ) {
        throw new Error(
          "The previous live-voice session is still releasing. Try again in a moment.",
        );
      }
      retryIndex += 1;
      this.setState("busy");
      await this.sleep(delay, this.abortController.signal);
    }

    throw new Error("Live voice stopped before connecting.");
  }

  private connectChannel(
    channel: LiveVoiceSessionChannel,
  ): Promise<HandshakeResult> {
    return new Promise<HandshakeResult>((resolve, reject) => {
      let handshakeState: HandshakeResult["type"] | "pending" | "failed" =
        "pending";
      const isActiveReadyChannel = (): boolean =>
        handshakeState === "ready" &&
        this.channel === channel &&
        !this.shuttingDown;
      const settle = (result: HandshakeResult): void => {
        if (handshakeState !== "pending") {
          return;
        }
        handshakeState = result.type;
        resolve(result);
      };
      const rejectOnce = (error: Error): void => {
        if (handshakeState !== "pending") {
          return;
        }
        handshakeState = "failed";
        reject(error);
      };

      channel.on("ready", (frame) => {
        settle({ type: "ready", frame });
      });
      channel.on("busy", (frame) => {
        settle({ type: "busy", frame });
      });
      channel.on("frame", (frame) => {
        if (!isActiveReadyChannel()) {
          return;
        }
        this.enqueueFrame(channel, frame);
      });
      channel.on("error", (event) => {
        const error = new Error(event.message);
        if (handshakeState === "pending") {
          rejectOnce(error);
        } else if (handshakeState === "ready" && event.recoverable) {
          this.options.onError?.(error);
        } else if (isActiveReadyChannel()) {
          void this.fail(error);
        }
      });
      channel.on("closed", (event) => {
        if (handshakeState === "pending") {
          rejectOnce(
            new Error(
              event.reason || "The live-voice connection closed unexpectedly.",
            ),
          );
        } else if (isActiveReadyChannel()) {
          if (event.retryable) {
            void this.reconnectChannel(channel, event.reason);
          } else {
            void this.fail(
              new Error(
                event.reason ||
                  "The live-voice connection closed unexpectedly.",
              ),
            );
          }
        }
      });

      channel.connect({
        conversationId: this.conversationId,
        turnDetection: this.mode === "open-mic" ? "server_vad" : "manual",
      });
    });
  }

  private enqueueFrame(
    channel: LiveVoiceSessionChannel,
    frame: LiveVoiceChannelClientEventMap["frame"],
  ): void {
    const playbackGeneration = this.playbackGeneration;
    const acceptingTts = this.acceptingTts;
    if (frame.type === "speech_started" || frame.type === "turn_cancelled") {
      this.cancelPlaybackGeneration();
      void this.options.playback.flush();
    } else if (frame.type === "thinking") {
      this.acceptingTts = true;
    }
    this.frameOperations = this.frameOperations
      .then(async () => {
        if (this.shuttingDown || this.channel !== channel) {
          return;
        }
        await this.handleFrame(
          channel,
          frame,
          playbackGeneration,
          acceptingTts,
        );
      })
      .catch(async (error) => {
        if (!this.shuttingDown) {
          await this.fail(toError(error));
        }
      });
  }

  private async handleFrame(
    channel: LiveVoiceSessionChannel,
    frame: LiveVoiceChannelClientEventMap["frame"],
    playbackGeneration: number,
    acceptingTts: boolean,
  ): Promise<void> {
    switch (frame.type) {
      case "speech_started":
        await this.options.playback.flush();
        this.finishEchoMeasurement();
        this.setState("listening");
        return;
      case "utterance_end":
        this.inputEndedAt = this.now();
        this.firstTtsRecorded = false;
        this.setState("transcribing");
        return;
      case "stt_partial":
      case "stt_final":
        this.setState("transcribing");
        if (this.captionMode === "user" || this.captionMode === "both") {
          this.options.onCaption?.("user", frame.text);
        }
        return;
      case "thinking":
        this.acceptingTts = true;
        this.setState("thinking");
        return;
      case "assistant_text_delta":
        if (this.captionMode === "assistant" || this.captionMode === "both") {
          this.options.onCaption?.("assistant", frame.text);
        }
        return;
      case "tts_audio":
        if (!acceptingTts || playbackGeneration !== this.playbackGeneration) {
          return;
        }
        if (!this.firstTtsRecorded && this.inputEndedAt !== null) {
          this.firstTtsRecorded = true;
          this.options.onTiming?.({
            name: "input_end_to_first_tts",
            durationMs: nonNegativeDuration(this.now() - this.inputEndedAt),
          });
        }
        this.setState("speaking");
        const audio = Buffer.from(frame.dataBase64, "base64");
        this.queuePlaybackAmplitudes(audio);
        await this.options.playback.write({
          audio,
          mimeType: frame.mimeType,
          sampleRate: frame.sampleRate,
        });
        return;
      case "tts_done":
        await this.completeTurn(channel, true);
        return;
      case "utterance_discarded":
        await this.completeTurn(channel, false);
        return;
      case "turn_cancelled":
        await this.completeTurn(channel, false);
        return;
      default:
        return;
    }
  }

  private async completeTurn(
    channel: LiveVoiceSessionChannel,
    drainPlayback: boolean,
  ): Promise<void> {
    if (drainPlayback) {
      await this.options.playback.drain();
    } else {
      await this.options.playback.flush();
    }
    if (this.shuttingDown || this.channel !== channel) {
      return;
    }

    this.finishEchoMeasurement();
    this.inputEndedAt = null;
    this.firstTtsRecorded = false;
    if (this.mode === "open-mic") {
      this.acceptingTts = false;
      this.setState("listening");
      return;
    }

    this.channel = null;
    channel.end();
    await this.openChannel();
    if (!this.shuttingDown) {
      this.setState("ready");
    }
  }

  private setState(state: LiveVoiceForegroundState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onState?.(state);
  }

  private cancelPlaybackGeneration(): void {
    this.playbackGeneration += 1;
    this.acceptingTts = false;
    this.playbackAmplitudes.length = 0;
    this.playbackAmplitudeIndex = 0;
  }

  private queuePlaybackAmplitudes(audio: Buffer): void {
    for (
      let offset = 0;
      offset < audio.length;
      offset += LIVE_VOICE_PCM_FRAME_BYTES
    ) {
      if (
        this.playbackAmplitudes.length - this.playbackAmplitudeIndex <
        MAX_ECHO_AMPLITUDE_SAMPLES
      ) {
        this.playbackAmplitudes.push(
          pcm16Rms(
            audio.subarray(
              offset,
              Math.min(offset + LIVE_VOICE_PCM_FRAME_BYTES, audio.length),
            ),
          ),
        );
      }
    }
  }

  private recordEchoSample(microphoneAmplitude: number): void {
    this.lastMicrophoneAmplitude = microphoneAmplitude;
    const playback = this.playbackAmplitudes[this.playbackAmplitudeIndex] ?? 0;
    if (this.playbackAmplitudeIndex < this.playbackAmplitudes.length) {
      this.playbackAmplitudeIndex += 1;
      if (this.playbackAmplitudeIndex === this.playbackAmplitudes.length) {
        this.playbackAmplitudes.length = 0;
        this.playbackAmplitudeIndex = 0;
      } else if (this.playbackAmplitudeIndex >= 256) {
        this.playbackAmplitudes.splice(0, this.playbackAmplitudeIndex);
        this.playbackAmplitudeIndex = 0;
      }
    }
    const summary = this.echoMeasurement.addSample({
      microphone: microphoneAmplitude,
      playback,
    });
    if (summary !== null) {
      this.options.onEchoSummary?.(summary);
    }
  }

  private finishEchoMeasurement(): void {
    this.playbackAmplitudes.length = 0;
    this.playbackAmplitudeIndex = 0;
    const summary = this.echoMeasurement.addSample({
      microphone: this.lastMicrophoneAmplitude,
      playback: 0,
    });
    if (summary !== null) {
      this.options.onEchoSummary?.(summary);
    }
  }

  private async reconnectChannel(
    closedChannel: LiveVoiceSessionChannel,
    reason: string,
  ): Promise<void> {
    if (
      this.reconnecting ||
      this.shuttingDown ||
      this.channel !== closedChannel
    ) {
      return;
    }
    this.reconnecting = true;
    this.channel = null;
    this.captureGeneration += 1;
    const captureSession = this.captureSession;
    this.captureSession = null;
    if (captureSession !== null) {
      await captureSession.stop().catch(() => null);
    }
    this.cancelPlaybackGeneration();
    await this.options.playback.flush().catch(() => {});
    this.finishEchoMeasurement();

    let lastError = new Error(
      reason || "The live-voice connection is restarting.",
    );
    const reconnectDelays = [0, ...LIVE_VOICE_BUSY_RETRY_DELAYS_MS] as const;
    try {
      for (const delay of reconnectDelays) {
        if (delay > 0) {
          await this.sleep(delay, this.abortController.signal);
        }
        if (this.shuttingDown) {
          return;
        }
        try {
          await this.openChannel();
          if (this.mode === "open-mic") {
            await this.beginCapture();
            this.options.onMicrophoneState?.(this.muted);
          } else {
            this.setState("ready");
          }
          return;
        } catch (error) {
          lastError = toError(error);
        }
      }
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      lastError = toError(error);
    } finally {
      this.reconnecting = false;
    }
    if (!this.shuttingDown) {
      await this.fail(lastError);
    }
  }

  private async fail(error: Error): Promise<void> {
    if (this.failure === null) {
      this.failure = error;
      try {
        this.setState("failed");
        this.options.onError?.(error);
      } catch {}
    }
    await this.shutdown();
  }

  private async shutdownOnce(): Promise<void> {
    this.shuttingDown = true;
    this.abortController.abort();
    this.captureGeneration += 1;
    this.cancelPlaybackGeneration();

    const captureSession = this.captureSession;
    this.captureSession = null;
    if (captureSession !== null) {
      await captureSession.stop().catch(() => null);
    }

    const channel = this.channel;
    this.channel = null;
    if (channel !== null) {
      try {
        channel.end();
      } catch {
        try {
          channel.close();
        } catch {}
      }
    }

    await this.options.playback.flush().catch(() => {});
    await this.options.playback.close().catch(() => {});
    try {
      if (this.failure === null) {
        this.setState("ended");
      }
    } finally {
      this.resolveClosed();
    }
  }
}

function nonNegativeDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Live voice stopped."));
      return;
    }
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Live voice stopped."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}
