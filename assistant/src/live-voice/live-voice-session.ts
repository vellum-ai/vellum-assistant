import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../calls/voice-session-bridge.js";
import {
  listProviderIds,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import type {
  LiveVoiceSession as LiveVoiceSessionContract,
  LiveVoiceSessionCloseReason,
  LiveVoiceSessionFactoryContext,
} from "./live-voice-session-manager.js";
import type {
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "./live-voice-tts.js";
import {
  type LiveVoiceClientFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

type LiveVoiceSessionState =
  | "initializing"
  | "active"
  | "utterance_released"
  | "transcriber_closed"
  | "interrupted"
  | "failed"
  | "closed";

const LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD = 180;
const SENTENCE_ENDING_PUNCTUATION = new Set([".", "!", "?"]);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);

export type LiveVoiceStreamingTranscriberResolver = (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;

export type LiveVoiceTurnStarter = (
  options: VoiceTurnOptions,
) => Promise<VoiceTurnHandle>;

export type LiveVoiceTtsStreamer = (
  options: LiveVoiceTtsOptions,
) => Promise<LiveVoiceTtsResult>;

export interface LiveVoiceSessionOptions {
  resolveTranscriber?: LiveVoiceStreamingTranscriberResolver;
  startVoiceTurn?: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  createTurnId?: () => string;
}

interface ActiveAssistantTurn {
  token: symbol;
  abortController: AbortController;
  handle: VoiceTurnHandle | null;
  assistantCompleted: boolean;
  ttsDone: boolean;
  ttsBuffer: string;
  ttsQueue: Promise<void>;
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly startVoiceTurn: LiveVoiceTurnStarter | null;
  private readonly streamTtsAudio: LiveVoiceTtsStreamer | null;
  private readonly createTurnId: () => string;
  private readonly conversationId: string;
  private state: LiveVoiceSessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  private readonly finalTranscriptSegments: string[] = [];
  private outboundFrames: Promise<void> = Promise.resolve();
  private pttReleased = false;
  private assistantTurnStarted = false;
  private activeAssistantTurn: ActiveAssistantTurn | null = null;

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.resolveTranscriber =
      options.resolveTranscriber ?? defaultResolveStreamingTranscriber;
    this.startVoiceTurn = options.startVoiceTurn ?? null;
    this.streamTtsAudio = options.streamTtsAudio ?? null;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
  }

  get finalTranscriptText(): string {
    return this.finalTranscriptSegments.join(" ");
  }

  async start(): Promise<void> {
    if (this.state !== "initializing") return;

    try {
      const transcriber = await this.resolveTranscriber({
        sampleRate: this.context.startFrame.audio.sampleRate,
      });

      if (this.isClosed) {
        stopTranscriberBestEffort(transcriber);
        return;
      }

      if (!transcriber) {
        this.state = "failed";
        await this.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.InvalidField,
          message: unavailableTranscriberMessage(),
        });
        return;
      }

      this.transcriber = transcriber;
      await transcriber.start((event) => {
        void this.handleTranscriberEvent(event);
      });

      if (this.isClosed) {
        stopTranscriberBestEffort(transcriber);
        this.transcriber = null;
        return;
      }

      this.state = "active";
      await this.sendFrame({
        type: "ready",
        sessionId: this.context.sessionId,
        conversationId: this.conversationId,
      });
    } catch (err) {
      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
      if (this.isClosed) return;

      this.state = "failed";
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice transcription could not be started: ${errorMessage(
          err,
        )}`,
      });
    }
  }

  async handleClientFrame(frame: LiveVoiceClientFrame): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return;

    switch (frame.type) {
      case "audio":
        await this.handleAudio(Buffer.from(frame.dataBase64, "base64"));
        return;
      case "ptt_release":
        await this.releaseUtterance();
        return;
      case "interrupt":
        await this.interrupt();
        return;
      case "end":
        await this.close("client_end");
        return;
      case "start":
        return;
    }
  }

  async handleBinaryAudio(chunk: Uint8Array): Promise<void> {
    await this.handleAudio(Buffer.from(chunk));
  }

  async close(_reason: LiveVoiceSessionCloseReason): Promise<void> {
    if (this.isClosed) return;

    this.state = "closed";
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    this.cancelAssistantTurn();
    await this.drainOutboundFrames();
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (
      this.state === "utterance_released" ||
      this.state === "transcriber_closed"
    ) {
      await this.sendAudioAfterReleaseError();
      return;
    }

    if (this.state !== "active") return;

    try {
      this.transcriber?.sendAudio(
        chunk,
        this.context.startFrame.audio.mimeType,
      );
      await this.drainOutboundFrames();
    } catch (err) {
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidAudioPayload,
        message: `Live voice audio could not be sent to transcription: ${errorMessage(
          err,
        )}`,
      });
    }
  }

  private async releaseUtterance(): Promise<void> {
    if (this.state === "utterance_released") {
      return;
    }

    if (this.state === "transcriber_closed") {
      this.pttReleased = true;
      await this.startAssistantTurnIfReady();
      await this.drainOutboundFrames();
      return;
    }

    if (this.state !== "active") return;

    this.pttReleased = true;
    this.state = "utterance_released";
    try {
      this.transcriber?.stop();
    } catch (err) {
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice transcription could not be stopped: ${errorMessage(
          err,
        )}`,
      });
    }
    await this.startAssistantTurnIfReady();
    await this.drainOutboundFrames();
  }

  private async handleTranscriberEvent(
    event: SttStreamServerEvent,
  ): Promise<void> {
    if (
      this.isClosed ||
      this.state === "failed" ||
      this.state === "interrupted"
    ) {
      return;
    }

    switch (event.type) {
      case "partial":
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final": {
        const transcript = event.text.trim();
        if (transcript.length > 0) {
          this.finalTranscriptSegments.push(transcript);
        }
        await this.sendFrame({ type: "stt_final", text: event.text });
        await this.startAssistantTurnIfReady();
        return;
      }
      case "error":
        await this.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.InvalidField,
          message: event.message,
        });
        return;
      case "closed":
        if (!this.isClosed) {
          this.state = "transcriber_closed";
          this.transcriber = null;
          await this.startAssistantTurnIfReady();
        }
        return;
    }
  }

  private async interrupt(): Promise<void> {
    if (this.isClosed || this.state === "failed") return;

    this.state = "interrupted";
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    this.cancelAssistantTurn();
    await this.drainOutboundFrames();
  }

  private async startAssistantTurnIfReady(): Promise<void> {
    if (
      !this.pttReleased ||
      this.assistantTurnStarted ||
      this.isClosed ||
      this.state === "failed"
    ) {
      return;
    }
    if (
      this.state !== "utterance_released" &&
      this.state !== "transcriber_closed"
    ) {
      return;
    }
    if (!this.startVoiceTurn) return;

    const content = this.finalTranscriptText.trim();
    if (content.length === 0) return;

    this.assistantTurnStarted = true;
    const token = Symbol("live-voice-assistant-turn");
    const turnId = this.createTurnId();
    const abortController = new AbortController();
    this.activeAssistantTurn = {
      token,
      abortController,
      handle: null,
      assistantCompleted: false,
      ttsDone: false,
      ttsBuffer: "",
      ttsQueue: Promise.resolve(),
    };

    await this.sendFrame({ type: "thinking", turnId });
    if (!this.isActiveAssistantTurn(token)) return;

    try {
      const handle = await this.startVoiceTurn({
        conversationId: this.conversationId,
        voiceSessionId: this.context.sessionId,
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
        userMessageInterface: "macos",
        assistantMessageInterface: "macos",
        voiceControlPrompt:
          "You are speaking in a local live voice session. Keep replies brief and conversational.",
        content,
        isInbound: true,
        signal: abortController.signal,
        callbacks: {
          assistant_text_delta: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            void this.sendFrame({
              type: "assistant_text_delta",
              text: msg.text,
            });
            this.bufferAssistantTextForTts(token, msg.text);
          },
          message_complete: (msg) => {
            const activeTurn = this.activeAssistantTurn;
            if (
              activeTurn?.token !== token ||
              activeTurn.assistantCompleted ||
              this.isClosed
            ) {
              return;
            }
            if (msg.type !== "message_complete") return;
            activeTurn.assistantCompleted = true;
            this.completeTtsForTurn(token, turnId);
          },
        },
        onError: (message) => {
          if (!this.isActiveAssistantTurn(token)) return;
          void this.sendFrame({
            type: "error",
            code: LiveVoiceProtocolErrorCode.InvalidField,
            message,
          });
        },
      });

      const activeTurn = this.activeAssistantTurn;
      if (activeTurn?.token !== token) {
        handle.abort();
        return;
      }
      if (activeTurn.ttsDone) {
        this.activeAssistantTurn = null;
        return;
      }

      activeTurn.handle = handle;
    } catch (err) {
      if (!this.isActiveAssistantTurn(token)) return;

      this.activeAssistantTurn = null;
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice assistant turn could not be started: ${errorMessage(
          err,
        )}`,
      });
    }
  }

  private cancelAssistantTurn(): void {
    const turn = this.activeAssistantTurn;
    if (!turn) return;

    this.activeAssistantTurn = null;
    turn.abortController.abort();
    turn.handle?.abort();
  }

  private isActiveAssistantTurn(token: symbol): boolean {
    return this.activeAssistantTurn?.token === token && !this.isClosed;
  }

  private isForwardingAssistantText(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.assistantCompleted &&
      !this.isClosed
    );
  }

  private isForwardingTts(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.ttsDone &&
      !activeTurn.abortController.signal.aborted &&
      !this.isClosed
    );
  }

  private bufferAssistantTextForTts(token: symbol, text: string): void {
    if (!this.streamTtsAudio || text.length === 0) return;

    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || activeTurn.assistantCompleted) return;

    activeTurn.ttsBuffer += text;
    this.flushTtsBuffer(token, false);
  }

  private completeTtsForTurn(token: symbol, turnId: string): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    this.flushTtsBuffer(token, true);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (currentTurn?.token !== token || currentTurn.ttsDone) return;

        currentTurn.ttsDone = true;
        await this.sendFrame({ type: "tts_done", turnId }, () =>
          this.isActiveAssistantTurn(token),
        );

        if (this.activeAssistantTurn?.token === token) {
          if (currentTurn.handle) {
            this.activeAssistantTurn = null;
          }
        }
      });
  }

  private flushTtsBuffer(token: symbol, force: boolean): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    if (!this.streamTtsAudio) {
      activeTurn.ttsBuffer = "";
      return;
    }

    const { segments, remainder } = extractSpeakableSegments(
      activeTurn.ttsBuffer,
      force,
    );
    activeTurn.ttsBuffer = remainder;

    for (const segment of segments) {
      this.enqueueTtsSegment(token, segment);
    }
  }

  private enqueueTtsSegment(token: symbol, segment: string): void {
    const activeTurn = this.activeAssistantTurn;
    const streamTtsAudio = this.streamTtsAudio;
    if (activeTurn?.token !== token || !streamTtsAudio) return;

    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (
          currentTurn?.token !== token ||
          currentTurn.abortController.signal.aborted
        ) {
          return;
        }

        try {
          let ttsAudioFrames: Promise<void> = Promise.resolve();
          await streamTtsAudio({
            text: segment,
            signal: currentTurn.abortController.signal,
            outputFormat: "pcm",
            sampleRate: this.context.startFrame.audio.sampleRate,
            onAudioChunk: (chunk) => {
              if (!this.isForwardingTts(token)) return;
              ttsAudioFrames = ttsAudioFrames.then(() =>
                this.sendFrame(
                  {
                    type: "tts_audio",
                    mimeType: "audio/pcm",
                    sampleRate: chunk.sampleRate,
                    dataBase64: chunk.dataBase64,
                  },
                  () => this.isForwardingTts(token),
                ),
              );
            },
          });
          await ttsAudioFrames;
        } catch (err) {
          if (!this.isForwardingTts(token)) return;
          await this.sendFrame(
            {
              type: "error",
              code: LiveVoiceProtocolErrorCode.InvalidField,
              message: `Live voice TTS failed: ${errorMessage(err)}`,
            },
            () => this.isForwardingTts(token),
          );
        }
      });
  }

  private async sendAudioAfterReleaseError(): Promise<void> {
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidAudioPayload,
      message: "Live voice audio received after push-to-talk release.",
    });
  }

  private async sendFrame(
    frame: LiveVoiceServerFramePayload,
    shouldSend: () => boolean = () => true,
  ): Promise<void> {
    this.outboundFrames = this.outboundFrames
      .catch(() => {})
      .then(async () => {
        if (!shouldSend()) return;
        await this.context.sendFrame(frame);
      })
      .catch(() => {
        // Transport failures are handled by the WebSocket/session owner.
      });

    await this.outboundFrames;
  }

  private async drainOutboundFrames(): Promise<void> {
    await this.outboundFrames.catch(() => {});
  }

  private get isClosed(): boolean {
    return this.state === "closed";
  }
}

export function createLiveVoiceSession(
  context: LiveVoiceSessionFactoryContext,
  options: LiveVoiceSessionOptions = {},
): LiveVoiceSession {
  return new LiveVoiceSession(context, {
    ...options,
    startVoiceTurn: options.startVoiceTurn ?? defaultStartVoiceTurn,
    streamTtsAudio:
      options.streamTtsAudio === undefined
        ? defaultStreamLiveVoiceTtsAudio
        : options.streamTtsAudio,
  });
}

async function defaultResolveStreamingTranscriber(
  options: ResolveStreamingTranscriberOptions,
): Promise<StreamingTranscriber | null> {
  const { resolveStreamingTranscriber } =
    await import("../providers/speech-to-text/resolve.js");
  return resolveStreamingTranscriber(options);
}

async function defaultStartVoiceTurn(
  options: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  const { startVoiceTurn } = await import("../calls/voice-session-bridge.js");
  return startVoiceTurn(options);
}

async function defaultStreamLiveVoiceTtsAudio(
  options: LiveVoiceTtsOptions,
): Promise<LiveVoiceTtsResult> {
  const { streamLiveVoiceTtsAudio } = await import("./live-voice-tts.js");
  return streamLiveVoiceTtsAudio(options);
}

function extractSpeakableSegments(
  text: string,
  force: boolean,
): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length > 0) {
    const boundary = findSpeakableBoundary(remainder);
    if (boundary === null) break;

    const segment = remainder.slice(0, boundary).trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    remainder = remainder.slice(boundary);
  }

  if (force) {
    const segment = remainder.trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    remainder = "";
  }

  return { segments, remainder };
}

function findSpeakableBoundary(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return index + 1;
    if (!char || !SENTENCE_ENDING_PUNCTUATION.has(char)) continue;

    let boundary = index + 1;
    while (
      boundary < text.length &&
      TRAILING_SENTENCE_PUNCTUATION.has(text[boundary] ?? "")
    ) {
      boundary += 1;
    }

    if (boundary === text.length || isWhitespace(text[boundary] ?? "")) {
      return boundary;
    }
  }

  if (text.length < LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD) {
    return null;
  }

  const preferredBoundary = findLastWhitespaceBoundary(
    text,
    LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD,
  );
  return preferredBoundary ?? LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD;
}

function findLastWhitespaceBoundary(
  text: string,
  maxLength: number,
): number | null {
  for (let index = maxLength; index > Math.floor(maxLength * 0.6); index -= 1) {
    if (isWhitespace(text[index] ?? "")) {
      return index + 1;
    }
  }
  return null;
}

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function unavailableTranscriberMessage(): string {
  const supportedProviders = listProviderIds()
    .filter((id) => supportsBoundary(id, "daemon-streaming"))
    .join(", ");

  return `Live voice transcription is unavailable. Check that the configured STT provider supports streaming transcription and has credentials configured. Streaming-capable providers: ${supportedProviders}.`;
}

function stopTranscriberBestEffort(
  transcriber: StreamingTranscriber | null,
): void {
  if (!transcriber) return;

  try {
    transcriber.stop();
  } catch {
    // Best effort cleanup during failed startup or session close.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
