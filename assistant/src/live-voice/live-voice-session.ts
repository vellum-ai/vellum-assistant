import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  MediaTurnDetector,
  type TurnDetectorConfig,
} from "../calls/media-turn-detector.js";
import { sanitizeForTts } from "../calls/tts-text-sanitizer.js";
import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../calls/voice-session-bridge.js";
import { getConfig } from "../config/loader.js";
import { ensureConversationExists } from "../persistence/conversation-crud.js";
import {
  listProviderIds,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import { publishConversationListAndMetadataChanged } from "../runtime/sync/resource-sync-events.js";
import { detectPcm16SpeechActivity } from "../stt/speech-energy.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import { extractSpeakableSegments } from "../tts/speakable-segments.js";
import type {
  LiveVoiceAudioArchiveResult,
  LiveVoiceAudioArchiveRole,
} from "./live-voice-archive.js";
import type { LiveVoiceCredentialReadiness } from "./live-voice-credential-preflight.js";
import {
  getLiveVoiceMetricsAggregateFields,
  type LiveVoiceMetricsClock,
  LiveVoiceMetricsCollector,
  type LiveVoiceMetricsEvent,
  type LiveVoiceTurnSeedMarks,
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
} from "./live-voice-tts.js";
import {
  type LiveVoiceClientFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

type LiveVoiceSessionState =
  | "initializing"
  | "active"
  | "interrupted"
  | "failed"
  | "closed";

// Cap on audio buffered while a server-VAD utterance waits for its
// transcriber (PCM16 mono seconds; oldest chunks are dropped past the cap).
const SERVER_VAD_PENDING_AUDIO_MAX_SECONDS = 10;
// Idle-mic chunks retained while the VAD detector is idle; flushed on speech
// onset so the transcriber gets leading context without streaming an open
// quiet mic.
const SERVER_VAD_PRE_ROLL_MAX_CHUNKS = 25;

export type LiveVoiceStreamingTranscriberResolver = (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;

export type LiveVoiceCredentialReadinessResolver =
  () => Promise<LiveVoiceCredentialReadiness>;

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
  /**
   * STT/TTS credential preflight run before any session wiring; a
   * `not-ready` verdict rejects the start frame with its `userMessage`.
   * `null` skips the preflight.
   */
  resolveCredentialReadiness?: LiveVoiceCredentialReadinessResolver | null;
  startVoiceTurn?: LiveVoiceTurnStarter;
  streamTtsAudio?: LiveVoiceTtsStreamer | null;
  archiveAudio?: LiveVoiceSessionAudioArchiver | null;
  emitMetrics?: boolean;
  metricsClock?: LiveVoiceMetricsClock;
  createTurnId?: () => string;
  /**
   * Overrides the server-VAD turn detector thresholds. The production
   * factory seeds these from `liveVoice.vad` config when unset.
   */
  turnDetectorConfig?: TurnDetectorConfig;
  /**
   * Overrides the mean-amplitude energy gate that classifies a server-VAD
   * audio chunk as speech. The production factory seeds this from
   * `liveVoice.vad.speechEnergyThreshold` config when unset; defaults to
   * `DEFAULT_SPEECH_ENERGY_THRESHOLD`.
   */
  speechEnergyThreshold?: number;
}

type LiveVoiceUtterancePhase =
  | "pending"
  | "streaming"
  | "released"
  | "transcriber_closed";

// One capture→transcribe→turn cycle. A session runs many of these back to
// back: each cycle owns its transcriber, transcript, audio buffers, and
// metrics-turn flags so consecutive turns stay isolated.
interface UtteranceCycle {
  phase: LiveVoiceUtterancePhase;
  released: boolean;
  assistantTurnStarted: boolean;
  // The whole cycle (turn included) finalized; the record can no longer
  // accept audio and the session may re-arm over it.
  completed: boolean;
  transcriber: StreamingTranscriber | null;
  pendingAudioChunks: Buffer[];
  pendingAudioBytes: number;
  finalTranscriptSegments: string[];
  turnId: string | null;
  userMessageId: string | null;
  userAudioChunks: Buffer[];
  metricsTurnStarted: boolean;
  metricsTurnFinished: boolean;
  // Marks captured while the previous cycle's metrics turn was still open
  // (server_vad overlap); seeded into the collector when this cycle's
  // metrics turn starts.
  stashedMetricsMarks: StashedMetricsMarks;
}

interface StashedMetricsMarks {
  firstAudioAtMs: number | null;
  firstPartialAtMs: number | null;
  speechStartAtMs: number | null;
  utteranceEndAtMs: number | null;
  finalTranscriptAtMs: number | null;
}

type UtteranceStartResult =
  | { status: "started" }
  | { status: "stale" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

interface ActiveAssistantTurn {
  token: symbol;
  turnId: string;
  utterance: UtteranceCycle;
  abortController: AbortController;
  handle: VoiceTurnHandle | null;
  assistantCompleted: boolean;
  ttsDone: boolean;
  // A tts_audio frame actually went out to the client — the barge-in gate:
  // speech only cancels a turn that has audibly started speaking.
  ttsAudioStarted: boolean;
  finalized: boolean;
  ttsBuffer: string;
  // A non-empty speakable segment reached the TTS queue — gates the eager
  // first-segment flush that trades clause quality for speech onset.
  ttsSegmentEnqueued: boolean;
  ttsQueue: Promise<void>;
  assistantMessageId: string | null;
  assistantAudioChunks: Buffer[];
  assistantAudioMimeType: string;
  assistantAudioSampleRate?: number;
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly resolveCredentialReadiness: LiveVoiceCredentialReadinessResolver | null;
  private readonly startVoiceTurn: LiveVoiceTurnStarter | null;
  private readonly streamTtsAudio: LiveVoiceTtsStreamer | null;
  private readonly archiveAudio: LiveVoiceSessionAudioArchiver | null;
  private readonly emitMetrics: boolean;
  private readonly metrics: LiveVoiceMetricsCollector;
  private readonly createTurnId: () => string;
  private readonly conversationId: string;
  private state: LiveVoiceSessionState = "initializing";
  private currentUtterance: UtteranceCycle | null = null;
  private outboundFrames: Promise<void> = Promise.resolve();
  private activeAssistantTurn: ActiveAssistantTurn | null = null;
  private sessionEndMetricsEmitted = false;
  // Non-null iff the start frame requested turnDetection "server_vad".
  private readonly turnDetector: MediaTurnDetector | null;
  // Energy gate for server-VAD speech classification; undefined defers to
  // DEFAULT_SPEECH_ENERGY_THRESHOLD.
  private readonly speechEnergyThreshold: number | undefined;
  private readonly maxPendingAudioBytes: number;
  // Set on VAD speech onset; consumed when the first speech chunk is routed
  // to an utterance so the metric lands on the right turn.
  private vadSpeechStartPending = false;
  // Bounded ring of idle-mic chunks skipped while the VAD detector is idle;
  // flushed ahead of the first routed chunk on speech onset.
  private vadPreRollChunks: Buffer[] = [];
  // The ring holds speech parked during the release→turn-start window;
  // protected from silent-chunk eviction until it flushes.
  private vadPreRollHasSpeech = false;
  // Detector turn-end that fired while its speech sat parked in the ring;
  // replayed once the parked speech flushes into the next armed utterance.
  private vadPendingTurnEnd: "silence" | "max-duration" | null = null;
  private readonly metricsClock: LiveVoiceMetricsClock;

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.resolveTranscriber =
      options.resolveTranscriber ?? defaultResolveStreamingTranscriber;
    this.resolveCredentialReadiness =
      options.resolveCredentialReadiness ?? null;
    this.startVoiceTurn = options.startVoiceTurn ?? null;
    this.streamTtsAudio = options.streamTtsAudio ?? null;
    this.archiveAudio = options.archiveAudio ?? null;
    this.emitMetrics = options.emitMetrics ?? false;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
    this.metricsClock = options.metricsClock ?? Date.now;
    this.metrics = new LiveVoiceMetricsCollector({
      sessionId: context.sessionId,
      conversationId: this.conversationId,
      ...(options.metricsClock ? { clock: options.metricsClock } : {}),
    });
    this.speechEnergyThreshold = options.speechEnergyThreshold;
    this.turnDetector =
      context.startFrame.turnDetection === "server_vad"
        ? new MediaTurnDetector(options.turnDetectorConfig ?? {}, {
            onTurnStart: () => this.handleVadSpeechStart(),
            onTurnEnd: (reason) => this.handleVadUtteranceEnd(reason),
          })
        : null;
    this.maxPendingAudioBytes =
      context.startFrame.audio.sampleRate *
      2 *
      SERVER_VAD_PENDING_AUDIO_MAX_SECONDS;
  }

  get finalTranscriptText(): string {
    return this.currentUtterance?.finalTranscriptSegments.join(" ") ?? "";
  }

  async start(): Promise<void> {
    if (this.state !== "initializing") {
      return;
    }

    if (this.resolveCredentialReadiness) {
      const readiness = await this.resolveCredentialReadiness();
      if (readiness.status === "not-ready") {
        return await this.failStartup(
          readiness.userMessage,
          LiveVoiceProtocolErrorCode.CredentialsUnavailable,
        );
      }
    }

    const result = await this.beginUtterance();
    switch (result.status) {
      case "stale":
        return;
      case "unavailable":
        return await this.failStartup(
          result.message,
          LiveVoiceProtocolErrorCode.CredentialsUnavailable,
        );
      case "error":
        return await this.failStartup(result.message);
      case "started":
        this.metrics.markReady();
        await this.sendFrame({
          type: "ready",
          sessionId: this.context.sessionId,
          conversationId: this.conversationId,
          turnDetection: this.turnDetector ? "server_vad" : "manual",
        });
    }
  }

  async handleClientFrame(frame: LiveVoiceClientFrame): Promise<void> {
    if (this.state === "closed" || this.state === "failed") {
      return;
    }

    switch (frame.type) {
      case "audio":
        await this.handleAudio(Buffer.from(frame.dataBase64, "base64"));
        return;
      case "ptt_release":
        await this.releaseFromClient();
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
    if (this.isClosed) {
      return;
    }

    const shouldEmitSessionEndMetrics = this.state !== "failed";
    this.state = "closed";
    this.turnDetector?.dispose();
    const utterance = this.currentUtterance;
    if (utterance) {
      stopTranscriberBestEffort(utterance.transcriber);
      utterance.transcriber = null;
    }
    await this.cancelAssistantTurn("session_closed");
    if (shouldEmitSessionEndMetrics) {
      await this.emitSessionEndMetrics();
    }
    await this.drainOutboundFrames();
  }

  // Creates the next utterance record and arms a fresh streaming transcriber
  // for it. Called once from start() and, in server_vad mode, again after
  // every finalized turn (per-utterance phase tracks the cycle).
  private async beginUtterance(): Promise<UtteranceStartResult> {
    const utterance: UtteranceCycle = {
      phase: "pending",
      released: false,
      assistantTurnStarted: false,
      completed: false,
      transcriber: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      finalTranscriptSegments: [],
      turnId: null,
      userMessageId: null,
      userAudioChunks: [],
      metricsTurnStarted: false,
      metricsTurnFinished: false,
      stashedMetricsMarks: {
        firstAudioAtMs: null,
        firstPartialAtMs: null,
        speechStartAtMs: null,
        utteranceEndAtMs: null,
        finalTranscriptAtMs: null,
      },
    };
    this.currentUtterance = utterance;
    // Speech parked while the previous cycle wound down belongs to this
    // cycle: buffer it before the transcriber arms, and capture the detector
    // turn-end that already fired for it (if any) to replay below.
    this.flushVadPreRollIntoPending(utterance);
    const replayTurnEnd = this.vadPendingTurnEnd;
    this.vadPendingTurnEnd = null;

    try {
      const transcriber = await this.resolveTranscriber({
        sampleRate: this.context.startFrame.audio.sampleRate,
      });

      if (this.isUtteranceStale(utterance)) {
        stopTranscriberBestEffort(transcriber);
        return { status: "stale" };
      }

      if (!transcriber) {
        return {
          status: "unavailable",
          message: unavailableTranscriberMessage(),
        };
      }

      utterance.transcriber = transcriber;
      await transcriber.start((event) => {
        void this.handleTranscriberEvent(utterance, event);
      });

      if (this.isUtteranceStale(utterance)) {
        stopTranscriberBestEffort(transcriber);
        utterance.transcriber = null;
        return { status: "stale" };
      }

      utterance.phase = "streaming";
      this.state = "active";
      await this.flushPendingUtteranceAudio(utterance);
      if (utterance.released) {
        await this.stopUtteranceForRelease(utterance);
      } else if (replayTurnEnd) {
        // The parked utterance completed during the window (detector already
        // idle): replay its boundary so it turns without more speech.
        await this.sendFrame({ type: "utterance_end", reason: replayTurnEnd });
        await this.releaseUtterance();
      }
      return { status: "started" };
    } catch (err) {
      stopTranscriberBestEffort(utterance.transcriber);
      utterance.transcriber = null;
      if (this.isUtteranceStale(utterance)) {
        return { status: "stale" };
      }
      return {
        status: "error",
        message: `Live voice transcription could not be started: ${errorMessage(
          err,
        )}`,
      };
    }
  }

  private isUtteranceStale(utterance: UtteranceCycle): boolean {
    return (
      this.isClosed ||
      this.state === "failed" ||
      this.currentUtterance !== utterance
    );
  }

  // Fire-and-forget re-arm: end-of-turn work (terminal frames, archival,
  // metrics) must never block on the next transcriber's startup. Failures
  // surface through rearmAfterTurn's error frame. Multi-turn cycling is a
  // server_vad capability; manual sessions keep single-utterance semantics
  // (no speculative post-turn transcriber).
  private scheduleRearmAfterTurn(): void {
    if (!this.turnDetector) {
      return;
    }
    void this.rearmAfterTurn().catch(() => {});
  }

  private async rearmAfterTurn(): Promise<void> {
    if (this.isClosed || this.state === "failed") {
      return;
    }

    const current = this.currentUtterance;
    if (current && !current.completed) {
      // server_vad armed the next utterance during the finished turn; it may
      // already be released and waiting to start its own turn.
      await this.startAssistantTurnIfReady();
      return;
    }
    await this.armUtterance();
  }

  private async armUtterance(): Promise<void> {
    const result = await this.beginUtterance();
    if (result.status === "started" || result.status === "stale") {
      return;
    }

    this.state = "failed";
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidField,
      message: result.message,
    });
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (this.turnDetector) {
      await this.handleServerVadAudio(this.turnDetector, chunk);
      return;
    }

    const utterance = this.currentUtterance;
    if (!utterance || this.isClosed || this.state === "failed") {
      return;
    }

    if (utterance.released || utterance.phase === "transcriber_closed") {
      await this.sendAudioAfterReleaseError();
      return;
    }

    if (this.state === "initializing") {
      return;
    }

    this.collectUserAudio(utterance, chunk);
    if (utterance.phase === "pending") {
      utterance.pendingAudioChunks.push(Buffer.from(chunk));
      return;
    }
    await this.forwardAudioToTranscriber(utterance, chunk);
  }

  // server_vad ingress: every chunk feeds the energy VAD (never an error
  // frame — audio is accepted in every non-closed state). Chunks route to
  // the current utterance; once that cycle is spent, speech lazily arms the
  // next utterance so barge-in speech is captured from its onset.
  private async handleServerVadAudio(
    detector: MediaTurnDetector,
    chunk: Buffer,
  ): Promise<void> {
    if (
      this.isClosed ||
      this.state === "failed" ||
      this.state === "initializing"
    ) {
      return;
    }

    const hasSpeech = detectPcm16SpeechActivity(
      chunk,
      this.speechEnergyThreshold,
    );
    detector.onMediaChunk(hasSpeech);

    // Idle mic: hold silent chunks in the bounded pre-roll instead of
    // collecting or streaming them; flushed on speech onset so the
    // transcriber still gets leading context ahead of the first syllable.
    if (!hasSpeech && !detector.isActive) {
      this.pushVadPreRoll(chunk, false);
      return;
    }

    let utterance = this.currentUtterance;
    if (!utterance) {
      return;
    }
    if (utterance.released || utterance.completed) {
      // Parked speech makes silent chunks arm-worthy too: the parked
      // utterance must flush without requiring more speech.
      if (!hasSpeech && !this.vadPreRollHasSpeech) {
        return;
      }
      if (!this.canArmNextUtterance(utterance)) {
        // Speech in the release→turn-start window: hold it in the pre-roll
        // ring so it flushes into the next utterance once it arms.
        this.pushVadPreRoll(chunk, hasSpeech);
        return;
      }
      // Sets currentUtterance synchronously; the transcriber resolves async
      // while this chunk lands in the new utterance's pending buffer.
      void this.armUtterance();
      utterance = this.currentUtterance;
      if (!utterance || utterance.released || utterance.completed) {
        return;
      }
    }

    for (const preRollChunk of this.takeVadPreRoll()) {
      await this.routeVadAudio(utterance, preRollChunk);
    }
    await this.routeVadAudio(utterance, chunk);
  }

  private async routeVadAudio(
    utterance: UtteranceCycle,
    chunk: Buffer,
  ): Promise<void> {
    this.collectUserAudio(utterance, chunk);
    if (this.vadSpeechStartPending) {
      this.vadSpeechStartPending = false;
      this.markSpeechStart(utterance);
    }
    if (utterance.phase === "pending") {
      this.bufferPendingUtteranceAudio(utterance, chunk);
      return;
    }
    await this.forwardAudioToTranscriber(utterance, chunk);
  }

  // A released utterance's transcription pipeline still reads
  // currentUtterance; replacing it is only safe once its assistant turn has
  // started (or the cycle fully finalized). Speech in the short
  // release→turn-start window waits in the pre-roll ring.
  private canArmNextUtterance(utterance: UtteranceCycle): boolean {
    return utterance.completed || utterance.assistantTurnStarted;
  }

  private pushVadPreRoll(chunk: Buffer, hasSpeech: boolean): void {
    // A full ring never lets idle silence evict parked speech.
    if (
      !hasSpeech &&
      this.vadPreRollHasSpeech &&
      this.vadPreRollChunks.length >= SERVER_VAD_PRE_ROLL_MAX_CHUNKS
    ) {
      return;
    }
    if (hasSpeech) {
      this.vadPreRollHasSpeech = true;
    }
    this.vadPreRollChunks.push(Buffer.from(chunk));
    while (this.vadPreRollChunks.length > SERVER_VAD_PRE_ROLL_MAX_CHUNKS) {
      this.vadPreRollChunks.shift();
    }
  }

  private takeVadPreRoll(): Buffer[] {
    this.vadPreRollHasSpeech = false;
    return this.vadPreRollChunks.splice(0);
  }

  // Arm-time flush: parked release-window audio joins the new cycle's
  // pending buffer so a completed parked utterance needs no further speech.
  private flushVadPreRollIntoPending(utterance: UtteranceCycle): void {
    for (const chunk of this.takeVadPreRoll()) {
      this.collectUserAudio(utterance, chunk);
      this.bufferPendingUtteranceAudio(utterance, chunk);
    }
  }

  private bufferPendingUtteranceAudio(
    utterance: UtteranceCycle,
    chunk: Buffer,
  ): void {
    utterance.pendingAudioChunks.push(Buffer.from(chunk));
    utterance.pendingAudioBytes += chunk.byteLength;
    while (
      utterance.pendingAudioBytes > this.maxPendingAudioBytes &&
      utterance.pendingAudioChunks.length > 1
    ) {
      const dropped = utterance.pendingAudioChunks.shift();
      utterance.pendingAudioBytes -= dropped?.byteLength ?? 0;
    }
  }

  private async forwardAudioToTranscriber(
    utterance: UtteranceCycle,
    chunk: Buffer,
  ): Promise<void> {
    try {
      utterance.transcriber?.sendAudio(
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
      await this.finalizePendingUtterance(utterance, "audio_error");
    }
  }

  private async flushPendingUtteranceAudio(
    utterance: UtteranceCycle,
  ): Promise<void> {
    const chunks = utterance.pendingAudioChunks.splice(0);
    utterance.pendingAudioBytes = 0;
    for (const chunk of chunks) {
      await this.forwardAudioToTranscriber(utterance, chunk);
    }
  }

  // VAD speech onset. Contract: speech_started always goes out (the client
  // flushes tail playback immediately); barge-in then cancels the active
  // turn only once its first tts_audio chunk was forwarded — speech during
  // a pre-TTS "thinking" turn never kills the unspoken reply.
  private handleVadSpeechStart(): void {
    if (this.isClosed || this.state === "failed") {
      return;
    }

    void this.sendFrame({ type: "speech_started" });
    this.vadSpeechStartPending = true;

    const turn = this.activeAssistantTurn;
    if (turn && !turn.finalized && turn.ttsAudioStarted) {
      this.bargeIn(turn);
    }
  }

  private bargeIn(turn: ActiveAssistantTurn): void {
    // Abort synchronously so no tts_audio frame can follow turn_cancelled,
    // and settle the cancelled turn's metrics so the next utterance's marks
    // do not collide with it in the collector.
    turn.abortController.abort();
    this.metrics.markBargeIn(turn.turnId);
    void (async () => {
      await this.finishMetricsTurn(
        turn.utterance,
        "cancelled",
        "barge_in",
        turn.turnId,
      );
      await this.sendFrame({ type: "turn_cancelled", turnId: turn.turnId });
      await this.cancelAssistantTurn("barge_in");
    })().catch(() => {});
  }

  // VAD closed the utterance — the analog of ptt_release: emit
  // utterance_end, then run the standard release path.
  private handleVadUtteranceEnd(reason: "silence" | "max-duration"): void {
    void (async () => {
      if (this.isClosed || this.state === "failed") {
        return;
      }
      this.vadSpeechStartPending = false;
      const utterance = this.currentUtterance;
      if (!utterance || utterance.released || utterance.completed) {
        // The ended turn's speech sits parked in the pre-roll ring (the
        // spent cycle still owns currentUtterance); record the boundary so
        // beginUtterance replays it once the parked speech flushes.
        if (this.vadPreRollHasSpeech) {
          this.vadPendingTurnEnd = reason;
        }
        return;
      }
      await this.sendFrame({ type: "utterance_end", reason });
      await this.releaseUtterance();
    })().catch(() => {});
  }

  // In server_vad mode a client ptt_release still works as a manual
  // override: force the detector's utterance boundary so the release runs
  // the same utterance_end path; without an open detector turn, fall back
  // to a plain release.
  private async releaseFromClient(): Promise<void> {
    if (this.turnDetector?.isActive) {
      this.turnDetector.forceEnd();
      await this.drainOutboundFrames();
      return;
    }
    await this.releaseUtterance();
  }

  private async releaseUtterance(): Promise<void> {
    const utterance = this.currentUtterance;
    if (!utterance || this.isClosed || this.state === "failed") {
      return;
    }

    if (utterance.phase === "transcriber_closed") {
      utterance.released = true;
      this.markUtteranceReleased(utterance);
      await this.startAssistantTurnIfReady();
      await this.drainOutboundFrames();
      return;
    }

    if (utterance.released) {
      return;
    }

    utterance.released = true;
    this.markUtteranceReleased(utterance);

    if (utterance.phase === "pending") {
      // The transcriber is still starting; beginUtterance completes the release.
      return;
    }

    await this.stopUtteranceForRelease(utterance);
  }

  private async stopUtteranceForRelease(
    utterance: UtteranceCycle,
  ): Promise<void> {
    utterance.phase = "released";
    try {
      utterance.transcriber?.stop();
    } catch (err) {
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice transcription could not be stopped: ${errorMessage(
          err,
        )}`,
      });
      utterance.phase = "transcriber_closed";
    }
    await this.startAssistantTurnIfReady();
    await this.drainOutboundFrames();
  }

  private async handleTranscriberEvent(
    utterance: UtteranceCycle,
    event: SttStreamServerEvent,
  ): Promise<void> {
    if (
      this.currentUtterance !== utterance ||
      this.isClosed ||
      this.state === "failed" ||
      this.state === "interrupted"
    ) {
      return;
    }

    switch (event.type) {
      case "partial":
        this.markFirstPartial(utterance);
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final": {
        const transcript = event.text.trim();
        if (transcript.length > 0) {
          utterance.finalTranscriptSegments.push(transcript);
        }
        this.markFinalTranscript(utterance);
        await this.sendFrame({ type: "stt_final", text: event.text });
        await this.startAssistantTurnIfReady();
        return;
      }
      case "error": {
        // Providers emit `error` mid-stream and may keep streaming; `closed`
        // / `final` still drive turn lifecycle. Only transient categories are
        // recoverable — auth/rate-limit/invalid-audio will not self-heal, so
        // hands-free clients must surface them instead of suppressing them.
        const recoverable =
          event.category === "timeout" || event.category === "provider-error";
        await this.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.InvalidField,
          message: event.message,
          ...(recoverable ? { recoverable: true } : {}),
        });
        return;
      }
      case "closed":
        utterance.phase = "transcriber_closed";
        utterance.transcriber = null;
        // The provider closed an unreleased hands-free cycle with nothing
        // captured (e.g. idle timeout): retire it so the next speech chunk
        // lazily arms a fresh utterance instead of dropping audio on the
        // null transcriber.
        if (
          this.turnDetector &&
          !utterance.released &&
          !utterance.completed &&
          utterance.finalTranscriptSegments.length === 0
        ) {
          await this.finalizePendingUtterance(utterance, "transcriber_closed");
          return;
        }
        await this.startAssistantTurnIfReady();
        return;
    }
  }

  private async interrupt(): Promise<void> {
    if (this.isClosed || this.state === "failed") {
      return;
    }

    this.state = "interrupted";
    // A client interrupt also discards speech parked in the pre-roll ring.
    this.takeVadPreRoll();
    this.vadPendingTurnEnd = null;
    const utterance = this.currentUtterance;
    if (utterance) {
      stopTranscriberBestEffort(utterance.transcriber);
      utterance.transcriber = null;
      // In server_vad mode the current utterance may be the lazily armed
      // next cycle, distinct from the in-flight turn's — finalize it too so
      // the post-turn re-arm can replace it.
      const turn = this.activeAssistantTurn;
      if (turn && turn.utterance !== utterance) {
        await this.finalizePendingUtterance(utterance, "interrupt");
      }
    }
    await this.cancelAssistantTurn("interrupt");
    await this.drainOutboundFrames();
  }

  private async startAssistantTurnIfReady(): Promise<void> {
    const utterance = this.currentUtterance;
    if (
      !utterance ||
      !utterance.released ||
      utterance.assistantTurnStarted ||
      this.isClosed ||
      this.state === "failed"
    ) {
      return;
    }
    // One assistant turn at a time: a server_vad utterance that closes while
    // the previous turn is still speaking waits; rearmAfterTurn retries it.
    if (this.activeAssistantTurn) {
      return;
    }
    if (utterance.phase !== "transcriber_closed") {
      return;
    }
    if (!this.startVoiceTurn) {
      return;
    }

    const content = utterance.finalTranscriptSegments.join(" ").trim();
    if (content.length === 0) {
      utterance.assistantTurnStarted = true;
      if (this.turnDetector) {
        // Hands-free clients moved to "transcribing" on utterance_end; tell
        // them the utterance was dropped so they return to listening. Sent
        // before the finalization awaits so a newer utterance armed in the
        // meantime cannot be blipped by a stale discard.
        await this.sendFrame({ type: "utterance_discarded" });
      }
      await this.finalizePendingUtterance(utterance, "empty_transcript");
      this.scheduleRearmAfterTurn();
      return;
    }

    utterance.assistantTurnStarted = true;
    const token = Symbol("live-voice-assistant-turn");
    const turnId = this.ensureTurnId(utterance);
    this.startMetricsTurnIfNeeded(utterance, turnId);
    const abortController = new AbortController();
    this.activeAssistantTurn = {
      token,
      turnId,
      utterance,
      abortController,
      handle: null,
      assistantCompleted: false,
      ttsDone: false,
      ttsAudioStarted: false,
      finalized: false,
      ttsBuffer: "",
      ttsSegmentEnqueued: false,
      ttsQueue: Promise.resolve(),
      assistantMessageId: null,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
    };

    await this.sendFrame({ type: "thinking", turnId });
    if (!this.isActiveAssistantTurn(token)) {
      return;
    }

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
            if (!this.isForwardingAssistantText(token)) {
              return;
            }
            this.markFirstAssistantDelta(utterance, turnId);
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
              // A barged-in turn finalizes through cancelAssistantTurn.
              activeTurn.abortController.signal.aborted ||
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
            if (activeTurn?.token !== token) {
              return;
            }
            activeTurn.utterance.userMessageId = messageId;
          },
          persisted_assistant_message_id: (messageId) => {
            const activeTurn = this.activeAssistantTurn;
            if (activeTurn?.token !== token) {
              return;
            }
            activeTurn.assistantMessageId = messageId;
          },
        },
        onError: (message) => {
          const activeTurn = this.activeAssistantTurn;
          if (
            !this.isActiveAssistantTurn(token) ||
            activeTurn?.assistantCompleted
          ) {
            return;
          }
          void (async () => {
            await this.sendFrame({
              type: "error",
              code: LiveVoiceProtocolErrorCode.InvalidField,
              message,
            });
            const currentTurn = this.activeAssistantTurn;
            if (currentTurn?.token !== token) {
              return;
            }
            await this.finalizeAssistantTurn(currentTurn, "cancelled", "error");
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
      if (!this.isActiveAssistantTurn(token)) {
        return;
      }

      this.activeAssistantTurn = null;
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice assistant turn could not be started: ${errorMessage(
          err,
        )}`,
      });
      await this.finalizePendingUtterance(utterance, "assistant_start_error");
      this.scheduleRearmAfterTurn();
    }
  }

  private async cancelAssistantTurn(reason: string): Promise<void> {
    const turn = this.activeAssistantTurn;
    this.activeAssistantTurn = null;
    if (turn) {
      turn.abortController.abort();
      turn.handle?.abort();
      if (!turn.finalized) {
        await this.finalizeAssistantTurn(turn, "cancelled", reason);
        return;
      }
    }

    // In server_vad mode currentUtterance may already be the next cycle
    // (e.g. barge-in speech); only finalize it when it belongs to the
    // cancelled turn or no turn was active (close/interrupt paths).
    const utterance = this.currentUtterance;
    if (utterance && (!turn || turn.utterance === utterance)) {
      await this.finalizePendingUtterance(utterance, reason);
    }
    this.scheduleRearmAfterTurn();
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
    if (!this.streamTtsAudio || text.length === 0) {
      return;
    }

    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || activeTurn.assistantCompleted) {
      return;
    }

    activeTurn.ttsBuffer += text;
    this.flushTtsBuffer(token, false);
  }

  private completeTtsForTurn(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) {
      return;
    }

    this.flushTtsBuffer(token, true);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(async () => {
        const currentTurn = this.activeAssistantTurn;
        if (currentTurn?.token !== token || currentTurn.ttsDone) {
          return;
        }
        // Barge-in can abort while this continuation is queued; the turn
        // then finalizes as cancelled through cancelAssistantTurn.
        if (currentTurn.abortController.signal.aborted) {
          return;
        }

        currentTurn.ttsDone = true;
        await this.finalizeAssistantTurn(
          currentTurn,
          "completed",
          "completed",
          {
            clearActive: false,
            rearm: false,
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

        // Re-arm only after the terminal tts_done frame so a slow or failing
        // next transcriber cannot block or precede turn completion. A
        // cancelled turn re-arms through cancelAssistantTurn instead.
        if (!currentTurn.abortController.signal.aborted) {
          this.scheduleRearmAfterTurn();
        }
      });
  }

  private flushTtsBuffer(token: symbol, force: boolean): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) {
      return;
    }

    if (!this.streamTtsAudio) {
      activeTurn.ttsBuffer = "";
      return;
    }

    const { segments, remainder } = extractSpeakableSegments(
      activeTurn.ttsBuffer,
      force,
      // Eager until the first segment is enqueued: the opening clause flushes
      // early so speech onset does not wait for a full sentence.
      { eager: !activeTurn.ttsSegmentEnqueued },
    );
    activeTurn.ttsBuffer = remainder;

    for (const segment of segments) {
      // Sanitized per segment (not per delta) so markdown spanning deltas is
      // stripped; assistant_text_delta frames keep the raw text.
      const speakable = sanitizeForTts(segment).trim();
      if (speakable.length === 0) {
        continue;
      }
      this.enqueueTtsSegment(token, speakable);
    }
  }

  private enqueueTtsSegment(token: symbol, segment: string): void {
    const activeTurn = this.activeAssistantTurn;
    const streamTtsAudio = this.streamTtsAudio;
    if (activeTurn?.token !== token || !streamTtsAudio) {
      return;
    }

    activeTurn.ttsSegmentEnqueued = true;
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
              if (!this.isForwardingTts(token)) {
                return;
              }
              const activeTurn = this.activeAssistantTurn;
              if (activeTurn?.token !== token) {
                return;
              }
              activeTurn.assistantAudioChunks.push(
                Buffer.from(chunk.dataBase64, "base64"),
              );
              activeTurn.assistantAudioMimeType = chunk.contentType;
              activeTurn.assistantAudioSampleRate = chunk.sampleRate;
              ttsAudioFrames = ttsAudioFrames.then(async () => {
                const sent = await this.sendFrame(
                  {
                    type: "tts_audio",
                    mimeType: chunk.contentType,
                    sampleRate: chunk.sampleRate,
                    dataBase64: chunk.dataBase64,
                  },
                  () => this.isForwardingTts(token),
                );
                // Arm the barge-in gate only once a tts_audio frame was
                // actually written — a backed-up outbound queue must not
                // let speech cancel a still-unspoken reply. Token match
                // keeps a stale turn's late send from arming a newer turn.
                if (!sent) {
                  return;
                }
                const turnAfterSend = this.activeAssistantTurn;
                if (
                  turnAfterSend?.token !== token ||
                  turnAfterSend.ttsAudioStarted
                ) {
                  return;
                }
                turnAfterSend.ttsAudioStarted = true;
                this.metrics.markFirstTtsAudio(turnAfterSend.turnId);
              });
            },
          });
          await ttsAudioFrames;
        } catch (err) {
          if (!this.isForwardingTts(token)) {
            return;
          }
          // Per-segment failure: the turn (and session) continue, so the
          // error is recoverable for the client.
          await this.sendFrame(
            {
              type: "error",
              code: LiveVoiceProtocolErrorCode.InvalidField,
              message: `Live voice TTS failed: ${errorMessage(err)}`,
              recoverable: true,
            },
            () => this.isForwardingTts(token),
          );
        }
      });
  }

  private collectUserAudio(utterance: UtteranceCycle, chunk: Buffer): void {
    utterance.userAudioChunks.push(Buffer.from(chunk));
    this.markUtteranceMetric(utterance, "firstAudioAtMs", (turnId) =>
      this.metrics.markFirstAudio(turnId),
    );
  }

  private markSpeechStart(utterance: UtteranceCycle): void {
    this.markUtteranceMetric(utterance, "speechStartAtMs", (turnId) =>
      this.metrics.markSpeechStart(turnId),
    );
  }

  // Manual mode stamps the PTT release; server_vad stamps the utterance-end
  // boundary instead (utteranceEndToFinalTranscript plays the sttMs role).
  private markUtteranceReleased(utterance: UtteranceCycle): void {
    if (this.turnDetector) {
      this.markUtteranceMetric(utterance, "utteranceEndAtMs", (turnId) =>
        this.metrics.markUtteranceEnd(turnId),
      );
      return;
    }
    const turnId = this.ensureTurnId(utterance);
    if (!this.startMetricsTurnIfNeeded(utterance, turnId)) {
      return;
    }
    this.metrics.markPushToTalkRelease(turnId);
  }

  private markFirstPartial(utterance: UtteranceCycle): void {
    this.markUtteranceMetric(utterance, "firstPartialAtMs", (turnId) =>
      this.metrics.markFirstPartial(turnId),
    );
  }

  private markFinalTranscript(utterance: UtteranceCycle): void {
    this.markUtteranceMetric(utterance, "finalTranscriptAtMs", (turnId) =>
      this.metrics.markFinalTranscript(turnId),
    );
  }

  // Records the mark on the utterance's metrics turn, or — while a previous
  // cycle's still-open turn blocks the collector — stashes the timestamp on
  // the utterance (first timestamp wins) so startMetricsTurnIfNeeded can
  // seed it when this cycle's turn starts.
  private markUtteranceMetric(
    utterance: UtteranceCycle,
    field: keyof StashedMetricsMarks,
    mark: (turnId: string) => void,
  ): void {
    const turnId = this.ensureTurnId(utterance);
    if (this.startMetricsTurnIfNeeded(utterance, turnId)) {
      mark(turnId);
      return;
    }
    if (utterance.metricsTurnFinished) {
      return;
    }
    if (utterance.stashedMetricsMarks[field] === null) {
      utterance.stashedMetricsMarks[field] = this.metricsClock();
    }
  }

  private markFirstAssistantDelta(
    utterance: UtteranceCycle,
    turnId: string,
  ): void {
    if (!this.startMetricsTurnIfNeeded(utterance, turnId)) {
      return;
    }
    this.metrics.markFirstAssistantDelta(turnId);
  }

  private ensureTurnId(utterance: UtteranceCycle): string {
    if (!utterance.turnId) {
      utterance.turnId = this.createTurnId();
    }
    return utterance.turnId;
  }

  // Returns whether marks may be recorded for this utterance's metrics turn.
  private startMetricsTurnIfNeeded(
    utterance: UtteranceCycle,
    turnId: string,
  ): boolean {
    if (utterance.metricsTurnFinished) {
      return false;
    }
    if (utterance.metricsTurnStarted) {
      return true;
    }
    if (this.hasBlockingMetricsTurn(utterance)) {
      return false;
    }
    this.metrics.startTurn(turnId, toSeedMarks(utterance.stashedMetricsMarks));
    utterance.metricsTurnStarted = true;
    return true;
  }

  // The collector tracks one turn at a time; while the previous cycle's
  // metrics turn is still open (server_vad overlap), the next utterance's
  // marks wait rather than superseding the in-flight turn.
  private hasBlockingMetricsTurn(utterance: UtteranceCycle): boolean {
    const turn = this.activeAssistantTurn;
    return (
      turn !== null &&
      turn.utterance !== utterance &&
      turn.utterance.metricsTurnStarted &&
      !turn.utterance.metricsTurnFinished
    );
  }

  private async finalizePendingUtterance(
    utterance: UtteranceCycle,
    reason: string,
  ): Promise<void> {
    utterance.completed = true;
    const turnId = utterance.turnId;
    if (!turnId) {
      return;
    }

    await this.archiveBufferedAudio({
      turnId,
      userMessageId: utterance.userMessageId,
      assistantMessageId: null,
      userAudioChunks: utterance.userAudioChunks,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
    });
    await this.finishMetricsTurn(utterance, "cancelled", reason, turnId);
  }

  private async finalizeAssistantTurn(
    turn: ActiveAssistantTurn,
    status: "completed" | "cancelled",
    reason = "completed",
    options: { clearActive?: boolean; rearm?: boolean } = {},
  ): Promise<void> {
    if (turn.finalized) {
      return;
    }

    turn.finalized = true;
    turn.utterance.completed = true;
    await this.archiveBufferedAudio({
      turnId: turn.turnId,
      userMessageId: turn.utterance.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      userAudioChunks: turn.utterance.userAudioChunks,
      assistantAudioChunks: turn.assistantAudioChunks,
      assistantAudioMimeType: turn.assistantAudioMimeType,
      ...(turn.assistantAudioSampleRate !== undefined
        ? { assistantAudioSampleRate: turn.assistantAudioSampleRate }
        : {}),
    });
    await this.finishMetricsTurn(turn.utterance, status, reason, turn.turnId);

    if (
      (options.clearActive ?? true) &&
      this.activeAssistantTurn?.token === turn.token &&
      turn.handle
    ) {
      this.activeAssistantTurn = null;
    }

    if (options.rearm ?? true) {
      this.scheduleRearmAfterTurn();
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
    if (!archiveAudio) {
      return;
    }

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
    utterance: UtteranceCycle,
    status: "completed" | "cancelled",
    reason: string,
    turnId: string,
  ): Promise<void> {
    if (!utterance.metricsTurnStarted || utterance.metricsTurnFinished) {
      return;
    }

    if (status === "completed") {
      this.metrics.completeTurn(turnId);
    } else {
      this.metrics.cancelTurn(reason, turnId);
    }
    utterance.metricsTurnFinished = true;

    if (!this.emitMetrics) {
      return;
    }
    await this.emitMetricsFrame(
      status === "completed" ? "turn_completed" : "turn_cancelled",
      turnId,
    );
  }

  private async emitSessionEndMetrics(): Promise<void> {
    if (!this.emitMetrics || this.sessionEndMetricsEmitted) {
      return;
    }

    this.sessionEndMetricsEmitted = true;
    await this.emitMetricsFrame("session_ended");
  }

  private async emitMetricsFrame(
    event: LiveVoiceMetricsEvent,
    turnId = this.currentUtterance?.turnId ?? this.context.sessionId,
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

  private async failStartup(
    message: string,
    code: LiveVoiceProtocolErrorCode = LiveVoiceProtocolErrorCode.InvalidField,
  ): Promise<never> {
    this.state = "failed";
    await this.sendFrame({
      type: "error",
      code,
      message,
    });
    throw new LiveVoiceSessionStartupError(message);
  }

  private async sendAudioAfterReleaseError(): Promise<void> {
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidAudioPayload,
      message: "Live voice audio received after push-to-talk release.",
    });
  }

  // Resolves true only if the frame passed shouldSend and was written.
  private async sendFrame(
    frame: LiveVoiceServerFramePayload,
    shouldSend: () => boolean = () => true,
  ): Promise<boolean> {
    let sent = false;
    this.outboundFrames = this.outboundFrames
      .catch(() => {})
      .then(async () => {
        if (!shouldSend()) {
          return;
        }
        await this.context.sendFrame(frame);
        sent = true;
      })
      .catch(() => {
        // Transport failures are handled by the WebSocket/session owner.
      });

    await this.outboundFrames;
    return sent;
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
  // Workspace-tunable server-VAD thresholds. The `liveVoice.vad` schema
  // defaults match the code defaults (800 energy / 800 ms silence / 30 s max
  // turn), so an unset config leaves behavior unchanged.
  const vadConfig = getConfig().liveVoice.vad;
  return new LiveVoiceSession(context, {
    ...options,
    turnDetectorConfig: options.turnDetectorConfig ?? {
      silenceThresholdMs: vadConfig.silenceThresholdMs,
      maxTurnDurationMs: vadConfig.maxTurnDurationMs,
    },
    speechEnergyThreshold:
      options.speechEnergyThreshold ?? vadConfig.speechEnergyThreshold,
    resolveCredentialReadiness:
      options.resolveCredentialReadiness === undefined
        ? defaultResolveLiveVoiceCredentialReadiness
        : options.resolveCredentialReadiness,
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

async function defaultResolveLiveVoiceCredentialReadiness(): Promise<LiveVoiceCredentialReadiness> {
  const { resolveLiveVoiceCredentialReadiness } =
    await import("./live-voice-credential-preflight.js");
  return resolveLiveVoiceCredentialReadiness();
}

async function defaultStartVoiceTurn(
  options: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  // On the first turn of a brand-new chat the client's conversation id has no
  // persisted `conversations` row yet — the live-voice session adopts the id
  // from its start frame rather than minting one through the conversation-key
  // store the text-send path uses. Without the row, the user-message persist
  // inside `startVoiceTurn` trips `FOREIGN KEY constraint failed`. Ensure it
  // exists (idempotent) before persisting. Lives in the production wiring, not
  // the session state machine, so session unit tests stay DB-free.
  const createdConversation = ensureConversationExists(options.conversationId);
  if (createdConversation) {
    // The row was created outside the normal send-message route, which is where
    // sibling clients/sidebars learn about a new conversation. Emit the same
    // "created" list invalidation that route does so they see the new voice
    // conversation without waiting for a reload.
    publishConversationListAndMetadataChanged(
      "created",
      options.conversationId,
    );
  }
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

function toSeedMarks(stashed: StashedMetricsMarks): LiveVoiceTurnSeedMarks {
  return {
    ...(stashed.firstAudioAtMs !== null
      ? { firstAudioAtMs: stashed.firstAudioAtMs }
      : {}),
    ...(stashed.firstPartialAtMs !== null
      ? { firstPartialAtMs: stashed.firstPartialAtMs }
      : {}),
    ...(stashed.speechStartAtMs !== null
      ? { speechStartAtMs: stashed.speechStartAtMs }
      : {}),
    ...(stashed.utteranceEndAtMs !== null
      ? { utteranceEndAtMs: stashed.utteranceEndAtMs }
      : {}),
    ...(stashed.finalTranscriptAtMs !== null
      ? { finalTranscriptAtMs: stashed.finalTranscriptAtMs }
      : {}),
  };
}

function takeBufferedAudio(chunks: Buffer[]): Buffer | null {
  if (chunks.length === 0) {
    return null;
  }

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
  if (!transcriber) {
    return;
  }

  try {
    transcriber.stop();
  } catch {
    // Best effort cleanup during failed startup or session close.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
