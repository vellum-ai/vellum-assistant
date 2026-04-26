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
  LiveVoiceAudioArchiveResult,
  LiveVoiceAudioArchiveRole,
} from "./live-voice-archive.js";
import {
  getLiveVoiceMetricsAggregateFields,
  type LiveVoiceMetricsClock,
  LiveVoiceMetricsCollector,
} from "./live-voice-metrics.js";
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

export interface LiveVoiceSessionArchiveAudioInput {
  messageId?: string | null;
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  mimeType: string;
  sampleRate?: number;
  durationMs?: number;
  audio: {
    type: "base64";
    dataBase64: string;
  };
}

export type LiveVoiceSessionAudioArchiver = (
  input: LiveVoiceSessionArchiveAudioInput,
) => LiveVoiceAudioArchiveResult | Promise<LiveVoiceAudioArchiveResult>;

export interface LiveVoiceSessionOptions {
  resolveTranscriber?: LiveVoiceStreamingTranscriberResolver;
  startVoiceTurn?: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  archiveAudio?: LiveVoiceSessionAudioArchiver | null;
  emitMetrics?: boolean;
  metricsClock?: LiveVoiceMetricsClock;
  createTurnId?: () => string;
}

interface ActiveAssistantTurn {
  token: symbol;
  turnId: string;
  abortController: AbortController;
  handle: VoiceTurnHandle | null;
  assistantCompleted: boolean;
  ttsDone: boolean;
  finalized: boolean;
  ttsBuffer: string;
  ttsQueue: Promise<void>;
  userMessageId: string | null;
  assistantMessageId: string | null;
  userAudioChunks: Buffer[];
  assistantAudioChunks: Buffer[];
  assistantAudioMimeType: string;
  assistantAudioSampleRate?: number;
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly startVoiceTurn: LiveVoiceTurnStarter | null;
  private readonly streamTtsAudio: LiveVoiceTtsStreamer | null;
  private readonly archiveAudio: LiveVoiceSessionAudioArchiver | null;
  private readonly emitMetrics: boolean;
  private readonly metrics: LiveVoiceMetricsCollector;
  private readonly createTurnId: () => string;
  private readonly conversationId: string;
  private state: LiveVoiceSessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  private readonly finalTranscriptSegments: string[] = [];
  private outboundFrames: Promise<void> = Promise.resolve();
  private pttReleased = false;
  private assistantTurnStarted = false;
  private activeAssistantTurn: ActiveAssistantTurn | null = null;
  private currentTurnId: string | null = null;
  private currentUserMessageId: string | null = null;
  private currentUserAudioChunks: Buffer[] = [];
  private metricsTurnStarted = false;
  private metricsTurnFinished = false;
  private sessionEndMetricsEmitted = false;

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.resolveTranscriber =
      options.resolveTranscriber ?? defaultResolveStreamingTranscriber;
    this.startVoiceTurn = options.startVoiceTurn ?? null;
    this.streamTtsAudio = options.streamTtsAudio ?? null;
    this.archiveAudio = options.archiveAudio ?? null;
    this.emitMetrics = options.emitMetrics ?? false;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
    this.metrics = new LiveVoiceMetricsCollector({
      sessionId: context.sessionId,
      conversationId: this.conversationId,
      ...(options.metricsClock ? { clock: options.metricsClock } : {}),
    });
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
      this.metrics.markReady();
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
    await this.cancelAssistantTurn("session_closed");
    await this.emitSessionEndMetrics();
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

    this.collectUserAudio(chunk);
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
      await this.finalizePendingTurn("audio_error");
    }
  }

  private async releaseUtterance(): Promise<void> {
    if (this.state === "utterance_released") {
      return;
    }

    if (this.state === "transcriber_closed") {
      this.pttReleased = true;
      this.markPushToTalkReleased();
      await this.startAssistantTurnIfReady();
      await this.drainOutboundFrames();
      return;
    }

    if (this.state !== "active") return;

    this.pttReleased = true;
    this.markPushToTalkReleased();
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
        this.markFirstPartial();
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final": {
        const transcript = event.text.trim();
        if (transcript.length > 0) {
          this.finalTranscriptSegments.push(transcript);
        }
        this.markFinalTranscript();
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
        await this.finalizePendingTurn("stt_error");
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
    await this.cancelAssistantTurn("interrupt");
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
    if (content.length === 0) {
      await this.finalizePendingTurn("empty_transcript");
      return;
    }

    this.assistantTurnStarted = true;
    const token = Symbol("live-voice-assistant-turn");
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    const abortController = new AbortController();
    this.activeAssistantTurn = {
      token,
      turnId,
      abortController,
      handle: null,
      assistantCompleted: false,
      ttsDone: false,
      finalized: false,
      ttsBuffer: "",
      ttsQueue: Promise.resolve(),
      userMessageId: this.currentUserMessageId,
      assistantMessageId: null,
      userAudioChunks: this.currentUserAudioChunks,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
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
        approvalMode: "local-live-voice",
        content,
        isInbound: true,
        signal: abortController.signal,
        callbacks: {
          assistant_text_delta: (msg) => {
            if (!this.isForwardingAssistantText(token)) return;
            this.markFirstAssistantDelta(turnId);
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
            activeTurn.assistantCompleted = true;
            if (msg.type === "generation_cancelled") {
              void this.finalizeAssistantTurn(
                activeTurn,
                "cancelled",
                "generation_cancelled",
              );
              return;
            }
            activeTurn.assistantMessageId = msg.messageId ?? null;
            this.completeTtsForTurn(token);
          },
          persisted_user_message_id: (messageId) => {
            const activeTurn = this.activeAssistantTurn;
            if (activeTurn?.token !== token) return;
            activeTurn.userMessageId = messageId;
            this.currentUserMessageId = messageId;
          },
          persisted_assistant_message_id: (messageId) => {
            const activeTurn = this.activeAssistantTurn;
            if (activeTurn?.token !== token) return;
            activeTurn.assistantMessageId = messageId;
          },
        },
        onError: (message) => {
          if (!this.isActiveAssistantTurn(token)) return;
          void (async () => {
            await this.sendFrame({
              type: "error",
              code: LiveVoiceProtocolErrorCode.InvalidField,
              message,
            });
            const activeTurn = this.activeAssistantTurn;
            if (activeTurn?.token !== token) return;
            await this.finalizeAssistantTurn(activeTurn, "cancelled", "error");
          })();
        },
      });

      const activeTurn = this.activeAssistantTurn;
      if (activeTurn?.token !== token) {
        handle.abort();
        return;
      }
      if (activeTurn.finalized) {
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
      await this.finalizePendingTurn("assistant_start_error");
    }
  }

  private async cancelAssistantTurn(reason: string): Promise<void> {
    const turn = this.activeAssistantTurn;
    if (!turn) {
      await this.finalizePendingTurn(reason);
      return;
    }

    this.activeAssistantTurn = null;
    turn.abortController.abort();
    turn.handle?.abort();
    await this.finalizeAssistantTurn(turn, "cancelled", reason);
  }

  private isActiveAssistantTurn(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token && !activeTurn.finalized && !this.isClosed
    );
  }

  private isForwardingAssistantText(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.assistantCompleted &&
      !activeTurn.finalized &&
      !this.isClosed
    );
  }

  private isForwardingTts(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.ttsDone &&
      !activeTurn.finalized &&
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

  private completeTtsForTurn(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    this.flushTtsBuffer(token, true);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (currentTurn?.token !== token || currentTurn.ttsDone) return;

        currentTurn.ttsDone = true;
        await this.sendFrame(
          { type: "tts_done", turnId: currentTurn.turnId },
          () => this.isActiveAssistantTurn(token),
        );
        await this.finalizeAssistantTurn(currentTurn, "completed");

        if (this.activeAssistantTurn?.token === token) {
          if (currentTurn.handle && currentTurn.finalized) {
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
              const activeTurn = this.activeAssistantTurn;
              if (activeTurn?.token !== token) return;
              activeTurn.assistantAudioChunks.push(
                Buffer.from(chunk.dataBase64, "base64"),
              );
              activeTurn.assistantAudioMimeType = chunk.contentType;
              activeTurn.assistantAudioSampleRate = chunk.sampleRate;
              this.metrics.markFirstTtsAudio(activeTurn.turnId);
              ttsAudioFrames = ttsAudioFrames.then(() =>
                this.sendFrame(
                  {
                    type: "tts_audio",
                    mimeType: chunk.contentType,
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

  private collectUserAudio(chunk: Buffer): void {
    const turnId = this.ensureTurnId();
    this.currentUserAudioChunks.push(Buffer.from(chunk));
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFirstAudio(turnId);
  }

  private markPushToTalkReleased(): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markPushToTalkRelease(turnId);
  }

  private markFirstPartial(): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFirstPartial(turnId);
  }

  private markFinalTranscript(): void {
    const turnId = this.ensureTurnId();
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFinalTranscript(turnId);
  }

  private markFirstAssistantDelta(turnId: string): void {
    this.startMetricsTurnIfNeeded(turnId);
    this.metrics.markFirstAssistantDelta(turnId);
  }

  private ensureTurnId(): string {
    if (!this.currentTurnId) {
      this.currentTurnId = this.createTurnId();
    }
    return this.currentTurnId;
  }

  private startMetricsTurnIfNeeded(turnId: string): void {
    if (this.metricsTurnStarted || this.metricsTurnFinished) return;
    this.metrics.startTurn(turnId);
    this.metricsTurnStarted = true;
  }

  private async finalizePendingTurn(reason: string): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId) return;

    await this.archiveBufferedAudio({
      turnId,
      userMessageId: this.currentUserMessageId,
      assistantMessageId: null,
      userAudioChunks: this.currentUserAudioChunks,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
    });
    await this.finishMetricsTurn("cancelled", reason, turnId);
  }

  private async finalizeAssistantTurn(
    turn: ActiveAssistantTurn,
    status: "completed" | "cancelled",
    reason = "completed",
  ): Promise<void> {
    if (turn.finalized) return;

    turn.finalized = true;
    await this.archiveBufferedAudio({
      turnId: turn.turnId,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      userAudioChunks: turn.userAudioChunks,
      assistantAudioChunks: turn.assistantAudioChunks,
      assistantAudioMimeType: turn.assistantAudioMimeType,
      ...(turn.assistantAudioSampleRate !== undefined
        ? { assistantAudioSampleRate: turn.assistantAudioSampleRate }
        : {}),
    });
    await this.finishMetricsTurn(status, reason, turn.turnId);

    if (this.activeAssistantTurn?.token === turn.token && turn.handle) {
      this.activeAssistantTurn = null;
    }
  }

  private async archiveBufferedAudio(input: {
    turnId: string;
    userMessageId: string | null;
    assistantMessageId: string | null;
    userAudioChunks: Buffer[];
    assistantAudioChunks: Buffer[];
    assistantAudioMimeType: string;
    assistantAudioSampleRate?: number;
  }): Promise<void> {
    const userAudio = takeBufferedAudio(input.userAudioChunks);
    if (userAudio) {
      await this.archiveBufferedRoleAudio({
        turnId: input.turnId,
        role: "user",
        messageId: input.userMessageId,
        mimeType: this.context.startFrame.audio.mimeType,
        sampleRate: this.context.startFrame.audio.sampleRate,
        audio: userAudio,
      });
    }

    const assistantAudio = takeBufferedAudio(input.assistantAudioChunks);
    if (assistantAudio) {
      const sampleRate =
        input.assistantAudioSampleRate ??
        this.context.startFrame.audio.sampleRate;
      await this.archiveBufferedRoleAudio({
        turnId: input.turnId,
        role: "assistant",
        messageId: input.assistantMessageId,
        mimeType: input.assistantAudioMimeType,
        sampleRate,
        audio: assistantAudio,
      });
    }
  }

  private async archiveBufferedRoleAudio(input: {
    turnId: string;
    role: LiveVoiceAudioArchiveRole;
    messageId: string | null;
    mimeType: string;
    sampleRate: number;
    audio: Buffer;
  }): Promise<void> {
    const archiveAudio = this.archiveAudio;
    if (!archiveAudio) return;

    const durationMs = estimatePcmDurationMs({
      byteLength: input.audio.byteLength,
      mimeType: input.mimeType,
      sampleRate: input.sampleRate,
    });
    let result: LiveVoiceAudioArchiveResult;
    try {
      result = await archiveAudio({
        messageId: input.messageId,
        sessionId: this.context.sessionId,
        turnId: input.turnId,
        role: input.role,
        mimeType: input.mimeType,
        sampleRate: input.sampleRate,
        ...(durationMs !== undefined ? { durationMs } : {}),
        audio: {
          type: "base64",
          dataBase64: input.audio.toString("base64"),
        },
      });
    } catch (err) {
      result = {
        type: "warning",
        warning: {
          code: "archive_failed",
          message: `Live voice audio archive failed without blocking the turn: ${errorMessage(
            err,
          )}`,
        },
      };
    }

    await this.sendArchiveFrame(input.turnId, input.role, result);
  }

  private async sendArchiveFrame(
    turnId: string,
    role: LiveVoiceAudioArchiveRole,
    result: LiveVoiceAudioArchiveResult,
  ): Promise<void> {
    const artifact =
      result.type === "archived" || result.type === "unlinked"
        ? result.artifact
        : undefined;
    const warning = result.type === "archived" ? undefined : result.warning;
    await this.sendFrame({
      type: "archived",
      conversationId: this.conversationId,
      sessionId: this.context.sessionId,
      turnId,
      role,
      ...(artifact
        ? {
            attachmentId: artifact.attachmentId,
            attachmentIds: [artifact.attachmentId],
          }
        : {}),
      ...(warning ? { warning } : {}),
    });
  }

  private async finishMetricsTurn(
    status: "completed" | "cancelled",
    reason: string,
    turnId: string,
  ): Promise<void> {
    if (!this.metricsTurnStarted || this.metricsTurnFinished) return;

    if (status === "completed") {
      this.metrics.completeTurn(turnId);
    } else {
      this.metrics.cancelTurn(reason, turnId);
    }
    this.metricsTurnFinished = true;

    if (!this.emitMetrics) return;
    await this.emitMetricsFrame(
      status === "completed" ? "turn_completed" : "turn_cancelled",
      turnId,
    );
  }

  private async emitSessionEndMetrics(): Promise<void> {
    if (!this.emitMetrics || this.sessionEndMetricsEmitted) return;

    this.sessionEndMetricsEmitted = true;
    await this.emitMetricsFrame("session_ended");
  }

  private async emitMetricsFrame(
    event: string,
    turnId = this.currentTurnId ?? this.context.sessionId,
  ): Promise<void> {
    const metrics = this.metrics.getSnapshot();
    await this.sendFrame({
      type: "metrics",
      event,
      sessionId: this.context.sessionId,
      conversationId: this.conversationId,
      turnId,
      metrics,
      ...getLiveVoiceMetricsAggregateFields(metrics, turnId),
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
    archiveAudio:
      options.archiveAudio === undefined
        ? defaultArchiveLiveVoiceAudio
        : options.archiveAudio,
    emitMetrics: options.emitMetrics ?? true,
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

async function defaultArchiveLiveVoiceAudio(
  input: LiveVoiceSessionArchiveAudioInput,
): Promise<LiveVoiceAudioArchiveResult> {
  const {
    linkLiveVoiceAssistantResponseAudioToMessage,
    linkLiveVoiceUserUtteranceAudioToMessage,
  } = await import("./live-voice-archive.js");
  return input.role === "user"
    ? linkLiveVoiceUserUtteranceAudioToMessage(input)
    : linkLiveVoiceAssistantResponseAudioToMessage(input);
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

function takeBufferedAudio(chunks: Buffer[]): Buffer | null {
  if (chunks.length === 0) return null;

  const audio = Buffer.concat(chunks);
  chunks.length = 0;
  return audio.byteLength > 0 ? audio : null;
}

function estimatePcmDurationMs(input: {
  byteLength: number;
  mimeType: string;
  sampleRate: number;
}): number | undefined {
  if (
    input.byteLength <= 0 ||
    input.sampleRate <= 0 ||
    input.mimeType.toLowerCase().split(";")[0]?.trim() !== "audio/pcm"
  ) {
    return undefined;
  }

  const bytesPerMonoSample = 2;
  return Math.round(
    (input.byteLength / (input.sampleRate * bytesPerMonoSample)) * 1000,
  );
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
