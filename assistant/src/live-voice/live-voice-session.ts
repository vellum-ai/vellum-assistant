import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../calls/voice-session-bridge.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { ActionLifecycleMessage } from "../daemon/message-types/actions.js";
import { hasActivePerceptionConsent } from "../perception/consent-grants.js";
import { perceptionEventType } from "../perception/perception-event.js";
import { buildPerceptionKnowledgeContext } from "../perception/personal-knowledge-context.js";
import { sanitizeText } from "../perception/sanitization.js";
import {
  listProviderIds,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import { getLogger } from "../util/logger.js";
import type {
  LiveVoiceAudioArchiveResult,
  LiveVoiceAudioArchiveRole,
} from "./live-voice-archive.js";
import {
  getLiveVoiceMetricsAggregateFields,
  type LiveVoiceMetricsClock,
  LiveVoiceMetricsCollector,
  type LiveVoiceMetricsEvent,
} from "./live-voice-metrics.js";
import {
  type LiveVoiceSession as LiveVoiceSessionContract,
  type LiveVoiceSessionCloseReason,
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionStartupError,
} from "./live-voice-session-manager.js";
import type {
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
  LiveVoiceTtsSession,
  LiveVoiceTtsSessionOptions,
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

const log = getLogger("live-voice");

const LIVE_VOICE_TTS_SEGMENT_CHAR_THRESHOLD = 180;
const SENTENCE_ENDING_PUNCTUATION = new Set([".", "!", "?"]);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['"', "'", ")", "]"]);

function resolveLiveVoiceSourceChannel(
  sourceChannel: string | undefined,
): "vellum" {
  return sourceChannel === "vellum" ? sourceChannel : "vellum";
}

function resolveLiveVoiceSourceInterface(
  sourceInterface: string | undefined,
): "macos" | "tauri" {
  return sourceInterface === "tauri" ? sourceInterface : "macos";
}

export type LiveVoiceStreamingTranscriberResolver = (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;

export type LiveVoiceTurnStarter = (
  options: VoiceTurnOptions,
) => Promise<VoiceTurnHandle>;

export type LiveVoiceTtsStreamer = (
  options: LiveVoiceTtsOptions,
) => Promise<LiveVoiceTtsResult>;

/**
 * Opens a persistent multi-utterance streaming TTS session. Live-voice
 * prefers this path when the configured provider supports it (currently
 * xAI) because it amortises the WebSocket handshake across every text
 * delta in the turn — eliminating the per-segment latency the streamer
 * path otherwise pays.
 *
 * The function is expected to throw a `LiveVoiceTtsError` with code
 * `LIVE_VOICE_TTS_STREAMING_UNAVAILABLE` when the provider can't open a
 * session; callers should treat that as a soft fallback signal and revert
 * to per-segment `streamTtsAudio` for the remainder of the turn.
 */
export type LiveVoiceTtsSessionOpener = (
  options: LiveVoiceTtsSessionOptions,
) => Promise<LiveVoiceTtsSession>;

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
  /**
   * Optional persistent-session TTS opener. When provided, the session
   * runs in "stream-as-you-speak" mode: every assistant text delta is
   * forwarded to the open session as-is and the provider (e.g. xAI)
   * streams audio chunks back as it produces them — bypassing the
   * sentence-segmentation buffer entirely. The session is finalized at
   * `message_complete` and closed on abort/error.
   *
   * If the opener throws `LIVE_VOICE_TTS_STREAMING_UNAVAILABLE` (provider
   * does not support sessions), the session silently falls back to the
   * per-segment `streamTtsAudio` path for that turn.
   */
  openTtsStreamingSession?: LiveVoiceTtsSessionOpener | null;
  archiveAudio?: LiveVoiceSessionAudioArchiver | null;
  emitMetrics?: boolean;
  metricsClock?: LiveVoiceMetricsClock;
  createTurnId?: () => string;
  getPerceptionMemoryContext?: () => string | null;
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
  /**
   * Lazy persistent TTS session promise. `null` when no opener is
   * configured. Resolves to a session when streaming-session mode is in
   * use, or `null` when the opener bailed (e.g. provider doesn't support
   * sessions) and we've fallen back to per-segment mode.
   */
  ttsSessionPromise: Promise<LiveVoiceTtsSession | null> | null;
  /** Pending tts_audio frames written from the session's chunk callback. */
  ttsSessionAudioFrames: Promise<void>;
  /** True once the session has been finalized or aborted. */
  ttsSessionFinalized: boolean;
  userMessageId: string | null;
  assistantMessageId: string | null;
  userAudioChunks: Buffer[];
  assistantAudioChunks: Buffer[];
  assistantAudioMimeType: string;
  assistantAudioSampleRate?: number;
  announcedActionLifecycleStages: Set<string>;
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly startVoiceTurn: LiveVoiceTurnStarter | null;
  private readonly streamTtsAudio: LiveVoiceTtsStreamer | null;
  private readonly openTtsStreamingSession: LiveVoiceTtsSessionOpener | null;
  private readonly archiveAudio: LiveVoiceSessionAudioArchiver | null;
  private readonly emitMetrics: boolean;
  private readonly metrics: LiveVoiceMetricsCollector;
  private readonly createTurnId: () => string;
  private readonly getPerceptionMemoryContext: () => string | null;
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
  private terminalTurnFrameSent = false;
  private sessionEndMetricsEmitted = false;
  /**
   * Probed once during `start()` and frozen for the rest of the session.
   * `true` means the active TTS provider advertised support for persistent
   * streaming sessions AND `openTtsStreamingSession` was wired — every
   * assistant turn in this session will use the session-mode pipeline.
   * `false` keeps the session on the per-segment `streamTtsAudio` path.
   *
   * Probing eagerly here (rather than lazily on the first delta) avoids
   * the queue race condition that would arise from mixing session-mode and
   * segment-mode work within the same turn.
   */
  private ttsStreamingSessionsSupported = false;

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.resolveTranscriber =
      options.resolveTranscriber ?? defaultResolveStreamingTranscriber;
    this.startVoiceTurn = options.startVoiceTurn ?? null;
    this.streamTtsAudio = options.streamTtsAudio ?? null;
    this.openTtsStreamingSession = options.openTtsStreamingSession ?? null;
    this.archiveAudio = options.archiveAudio ?? null;
    this.emitMetrics = options.emitMetrics ?? false;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.getPerceptionMemoryContext =
      options.getPerceptionMemoryContext ?? defaultPerceptionMemoryContext;
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
        return await this.failStartup(unavailableTranscriberMessage());
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

      // Streaming-session support is settled at session-create time by the
      // caller (factory wires the opener iff the configured provider
      // advertises capability). A non-null opener means we're committed to
      // session-mode for every assistant turn in this session.
      this.ttsStreamingSessionsSupported = Boolean(
        this.openTtsStreamingSession,
      );

      this.state = "active";
      this.metrics.markReady();
      await this.sendFrame({
        type: "ready",
        sessionId: this.context.sessionId,
        conversationId: this.conversationId,
      });
    } catch (err) {
      if (err instanceof LiveVoiceSessionStartupError) {
        throw err;
      }

      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
      if (this.isClosed) return;

      await this.failStartup(
        `Live voice transcription could not be started: ${errorMessage(err)}`,
      );
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

    const shouldEmitSessionEndMetrics = this.state !== "failed";
    this.state = "closed";
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    await this.cancelAssistantTurn("session_closed");
    if (shouldEmitSessionEndMetrics) {
      await this.emitSessionEndMetrics();
    }
    await this.drainOutboundFrames();
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (
      this.state === "utterance_released" ||
      this.state === "transcriber_closed"
    ) {
      // Browser mic pipelines can deliver a few late frames after the client
      // sends `ptt_release`. The utterance boundary is already fixed, so drop
      // them silently rather than flooding the HUD with recoverable errors.
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
      this.state = "transcriber_closed";
      this.transcriber = null;
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
        await this.publishAudioExcerpt(transcript);
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
    if (this.state !== "transcriber_closed") {
      return;
    }
    if (!this.startVoiceTurn) return;

    const content = this.finalTranscriptText.trim();
    if (content.length === 0) {
      await this.finalizePendingTurn("empty_transcript");
      await this.sendTerminalTurnFrame();
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
      ttsSessionPromise: null,
      ttsSessionAudioFrames: Promise.resolve(),
      ttsSessionFinalized: false,
      userMessageId: this.currentUserMessageId,
      assistantMessageId: null,
      userAudioChunks: this.currentUserAudioChunks,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
      announcedActionLifecycleStages: new Set<string>(),
    };

    await this.sendFrame({ type: "thinking", turnId });
    if (!this.isActiveAssistantTurn(token)) return;

    try {
      const handle = await this.startVoiceTurn({
        conversationId: this.conversationId,
        voiceSessionId: this.context.sessionId,
        userMessageChannel: resolveLiveVoiceSourceChannel(
          this.context.startFrame.sourceChannel,
        ),
        assistantMessageChannel: resolveLiveVoiceSourceChannel(
          this.context.startFrame.sourceChannel,
        ),
        userMessageInterface: resolveLiveVoiceSourceInterface(
          this.context.startFrame.sourceInterface,
        ),
        assistantMessageInterface: resolveLiveVoiceSourceInterface(
          this.context.startFrame.sourceInterface,
        ),
        voiceControlPrompt: buildLiveVoiceControlPrompt(
          this.getPerceptionMemoryContext(),
        ),
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
          action_lifecycle: (msg) => {
            if (!this.isActiveAssistantTurn(token)) return;
            void this.handleActionLifecycleUpdate(token, msg);
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

  private async handleActionLifecycleUpdate(
    token: symbol,
    msg: ActionLifecycleMessage,
  ): Promise<void> {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || activeTurn.assistantCompleted) return;
    const lifecycleKey = `${msg.actionId}:${msg.stage}`;
    if (activeTurn.announcedActionLifecycleStages.has(lifecycleKey)) return;
    activeTurn.announcedActionLifecycleStages.add(lifecycleKey);

    const cue = actionLifecycleCue(msg);
    if (!cue) return;

    await this.sendFrame(
      {
        type: "assistant_text_delta",
        text: cue,
      },
      () => this.isForwardingAssistantText(token),
    );
    this.bufferAssistantTextForTts(token, cue);
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
    // Best-effort: if a streaming TTS session was opened for this turn,
    // tear it down so the upstream WebSocket releases promptly. The session
    // already listens to abortController.signal but closing explicitly here
    // avoids relying on signal-handler ordering.
    if (turn.ttsSessionPromise) {
      void turn.ttsSessionPromise.then(async (session) => {
        if (!session) return;
        try {
          await session.close();
        } catch {
          // ignore close errors during cancellation
        }
      });
    }
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
    if (text.length === 0) return;

    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || activeTurn.assistantCompleted) return;

    // Streaming-session mode: forward every delta into a single persistent
    // session for this turn. xAI handles segmentation/synthesis pacing
    // itself, so we don't need to buffer up sentence boundaries.
    if (this.ttsStreamingSessionsSupported && this.openTtsStreamingSession) {
      this.appendTextToTtsStreamingSession(token, text);
      return;
    }

    if (!this.streamTtsAudio) return;
    activeTurn.ttsBuffer += text;
    this.flushTtsBuffer(token, false);
  }

  private completeTtsForTurn(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    // Streaming-session mode: finalize the active session, then signal the
    // client. The session emits its terminal audio chunk via the existing
    // chunk pipeline so playback finishes naturally.
    if (this.ttsStreamingSessionsSupported && this.openTtsStreamingSession) {
      this.finalizeTtsStreamingSessionForTurn(token);
      return;
    }

    this.flushTtsBuffer(token, true);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (currentTurn?.token !== token || currentTurn.ttsDone) return;

        currentTurn.ttsDone = true;
        await this.finalizeAssistantTurn(
          currentTurn,
          "completed",
          "completed",
          {
            clearActive: false,
          },
        );
        await this.sendFrame(
          { type: "tts_done", turnId: currentTurn.turnId },
          () =>
            this.activeAssistantTurn?.token === token &&
            currentTurn.finalized &&
            !this.isClosed,
        );

        if (this.activeAssistantTurn?.token === token) {
          if (currentTurn.handle && currentTurn.finalized) {
            this.activeAssistantTurn = null;
          }
        }
      });
  }

  /**
   * Lazy-open the persistent TTS session for this turn (if not already
   * open) and append the delta. The session-mode opener is only wired in
   * the factory when the configured provider advertises session support,
   * so any open failure here is a hard error (network/auth) and we surface
   * it as an error frame to the client.
   */
  private appendTextToTtsStreamingSession(token: symbol, text: string): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    if (!activeTurn.ttsSessionPromise) {
      activeTurn.ttsSessionPromise = this.openLiveVoiceTtsSessionForTurn(
        token,
        activeTurn,
      );
    }

    const sessionPromise = activeTurn.ttsSessionPromise;
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        let session: LiveVoiceTtsSession | null = null;
        try {
          session = await sessionPromise;
        } catch (err) {
          log.warn(
            { message: errorMessage(err) },
            "Live voice TTS streaming-session open failed",
          );
          if (!this.isForwardingTts(token)) return;
          await this.sendFrame(
            {
              type: "error",
              code: LiveVoiceProtocolErrorCode.InvalidField,
              message: `Live voice TTS failed: ${errorMessage(err)}`,
            },
            () => this.isForwardingTts(token),
          );
          return;
        }
        if (!session) return;

        const currentTurn = this.activeAssistantTurn;
        if (
          currentTurn?.token !== token ||
          currentTurn.abortController.signal.aborted ||
          currentTurn.ttsSessionFinalized
        ) {
          return;
        }

        try {
          await session.appendText(text);
        } catch (err) {
          log.warn(
            { textLength: text.length, message: errorMessage(err) },
            "Live voice TTS streaming-session appendText failed",
          );
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

  /**
   * Finalize the streaming TTS session for `token`'s turn, wait for the
   * provider to emit its terminal audio chunk, then send `tts_done`.
   */
  private finalizeTtsStreamingSessionForTurn(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) return;

    const sessionPromise = activeTurn.ttsSessionPromise;
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (currentTurn?.token !== token || currentTurn.ttsDone) return;

        let session: LiveVoiceTtsSession | null = null;
        if (sessionPromise) {
          try {
            session = await sessionPromise;
          } catch {
            // appendText path already surfaced the error frame; here we
            // just continue to send tts_done so the client can clean up.
            session = null;
          }
        }

        if (session && !currentTurn.ttsSessionFinalized) {
          currentTurn.ttsSessionFinalized = true;
          try {
            await session.finalize();
          } catch (err) {
            log.warn(
              { message: errorMessage(err) },
              "Live voice TTS streaming-session finalize failed",
            );
          }
          await currentTurn.ttsSessionAudioFrames;
          try {
            await session.close();
          } catch {
            // ignore close errors
          }
        }

        currentTurn.ttsDone = true;
        await this.finalizeAssistantTurn(
          currentTurn,
          "completed",
          "completed",
          {
            clearActive: false,
          },
        );
        await this.sendFrame(
          { type: "tts_done", turnId: currentTurn.turnId },
          () =>
            this.activeAssistantTurn?.token === token &&
            currentTurn.finalized &&
            !this.isClosed,
        );

        if (this.activeAssistantTurn?.token === token) {
          if (currentTurn.handle && currentTurn.finalized) {
            this.activeAssistantTurn = null;
          }
        }
      });
  }

  /**
   * Open a live-voice TTS streaming session for the given turn. Errors
   * propagate up to the queue chain that called this method — the caller
   * surfaces them as a client-facing error frame.
   */
  private async openLiveVoiceTtsSessionForTurn(
    token: symbol,
    activeTurn: ActiveAssistantTurn,
  ): Promise<LiveVoiceTtsSession | null> {
    if (!this.openTtsStreamingSession) return null;
    return await this.openTtsStreamingSession({
      signal: activeTurn.abortController.signal,
      outputFormat: "pcm",
      sampleRate: this.context.startFrame.audio.sampleRate,
      onAudioChunk: (chunk) => {
        if (!this.isForwardingTts(token)) return;
        const liveTurn = this.activeAssistantTurn;
        if (liveTurn?.token !== token) return;
        liveTurn.assistantAudioChunks.push(
          Buffer.from(chunk.dataBase64, "base64"),
        );
        liveTurn.assistantAudioMimeType = chunk.contentType;
        liveTurn.assistantAudioSampleRate = chunk.sampleRate;
        this.metrics.markFirstTtsAudio(liveTurn.turnId);
        liveTurn.ttsSessionAudioFrames = liveTurn.ttsSessionAudioFrames.then(
          () =>
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
          // The catch path used to be silent on the daemon side — the only
          // signal was the `error` frame sent to the client. That made
          // diagnosing provider auth/config/network failures impossible
          // without attaching a debugger. Log the full error here so the
          // failure mode is visible in the assistant log alongside the
          // user-facing error frame.
          const errAsAny = err as Error & {
            code?: unknown;
            statusCode?: unknown;
            cause?: unknown;
          };
          log.warn(
            {
              segmentLength: segment.length,
              errorName: errAsAny?.name,
              errorCode:
                typeof errAsAny?.code === "string" ? errAsAny.code : undefined,
              statusCode:
                typeof errAsAny?.statusCode === "number"
                  ? errAsAny.statusCode
                  : undefined,
              cause:
                errAsAny?.cause instanceof Error
                  ? errAsAny.cause.message
                  : undefined,
              message: errorMessage(err),
            },
            "Live voice TTS segment synthesis failed",
          );
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

  private async sendTerminalTurnFrame(): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId || this.terminalTurnFrameSent || this.isClosed) return;
    this.terminalTurnFrameSent = true;
    await this.sendFrame({ type: "tts_done", turnId });
  }

  private async finalizeAssistantTurn(
    turn: ActiveAssistantTurn,
    status: "completed" | "cancelled",
    reason = "completed",
    options: { clearActive?: boolean } = {},
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

    if (
      (options.clearActive ?? true) &&
      this.activeAssistantTurn?.token === turn.token &&
      turn.handle
    ) {
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
    event: LiveVoiceMetricsEvent,
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

  private async failStartup(message: string): Promise<never> {
    this.state = "failed";
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidField,
      message,
    });
    throw new LiveVoiceSessionStartupError(message);
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

  /**
   * Best-effort publish of a finalised STT turn as a `perception.audio_excerpt`
   * event so the assistant can reason over spoken context.
   *
   * Gated by:
   * - The master `perception` flag (must be on for any perception event).
   * - The sub-flag `perception-audio-excerpt` (default off).
   * - A per-conversation `perception_consent_grants` row — that gate lands in
   *   phase 4C and reuses the existing `confirmation_request` flow; until it
   *   lands, the feature flag is the only gate. Failures here never bubble
   *   back to the live-voice session.
   */
  private async publishAudioExcerpt(transcript: string): Promise<void> {
    try {
      if (transcript.length === 0) return;
      const config = getConfig();
      if (!isAssistantFeatureFlagEnabled("perception", config)) return;
      if (!isAssistantFeatureFlagEnabled("perception-audio-excerpt", config)) {
        return;
      }

      if (
        !hasActivePerceptionConsent({
          conversationId: this.conversationId,
          eventKind: "audio_excerpt",
        })
      ) {
        return;
      }

      const sanitized = sanitizeText(transcript, 1024);
      if (sanitized.length === 0) return;

      const eventId = `audio-excerpt:${this.context.sessionId}:${randomUUID()}`;
      const ts = new Date().toISOString();

      await assistantEventHub.publish({
        id: eventId,
        emittedAt: ts,
        message: {
          type: perceptionEventType("audio_excerpt"),
          perception: {
            eventId,
            ts,
            source: { module: "live-voice" },
            payload: {
              kind: "audio_excerpt",
              conversationId: this.conversationId,
              sessionId: this.context.sessionId,
              turnId: this.conversationId,
              transcriptRedacted: sanitized,
              confidence: 1,
            },
          },
        },
      } as never);
    } catch (err) {
      log.warn(
        {
          err,
          sessionId: this.context.sessionId,
          conversationId: this.conversationId,
        },
        "failed to publish audio_excerpt perception event",
      );
    }
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
    // The session-mode opener is OPT-IN. Production wiring (http-server)
    // probes provider capability synchronously and passes
    // `defaultOpenLiveVoiceTtsStreamingSession` when supported. Tests that
    // don't pass `openTtsStreamingSession` get null and stay on the
    // legacy per-segment path — preserving prior test behaviour.
    openTtsStreamingSession: options.openTtsStreamingSession ?? null,
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

/**
 * Exported so production callers (`http-server.ts`) can wire it after a
 * provider-capability probe. Tests that use `createLiveVoiceSession`
 * directly without passing `openTtsStreamingSession` continue to get the
 * legacy per-segment path.
 */
export async function defaultOpenLiveVoiceTtsStreamingSession(
  options: LiveVoiceTtsSessionOptions,
): Promise<LiveVoiceTtsSession> {
  const { openLiveVoiceTtsStreamingSession } =
    await import("./live-voice-tts.js");
  return openLiveVoiceTtsStreamingSession(options);
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

function buildLiveVoiceControlPrompt(
  perceptionMemoryContext: string | null,
): string {
  const basePrompt =
    "You are speaking in a local live voice session. Keep replies brief and conversational.";
  if (!perceptionMemoryContext || perceptionMemoryContext.trim().length === 0) {
    return basePrompt;
  }
  const escaped = perceptionMemoryContext.replace(
    /<\/perception_memory\s*>/gi,
    "&lt;/perception_memory&gt;",
  );
  return `${basePrompt}\n\n<perception_memory>\n${escaped}\n</perception_memory>`;
}

function defaultPerceptionMemoryContext(): string | null {
  try {
    return buildPerceptionKnowledgeContext();
  } catch {
    return null;
  }
}

function actionLifecycleCue(msg: ActionLifecycleMessage): string | null {
  const label = friendlyActionName(msg.actionName);
  switch (msg.stage) {
    case "started":
      return `Starting ${label}. `;
    case "executing":
      return `Working on ${label}. `;
    case "completed":
      return `${label} complete. `;
    case "failed":
      return `${label} failed. `;
    case "rollback_started":
      return `Rolling back ${label}. `;
    case "rollback_completed":
      return `Rollback complete for ${label}. `;
    default:
      return null;
  }
}

function friendlyActionName(actionName: string): string {
  const normalized = actionName.replace(/[_-]+/g, " ").trim();
  return normalized.length > 0 ? normalized : "action";
}
