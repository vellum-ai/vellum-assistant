/**
 * Composition root for a full-duplex `/v1/live-voice` session.
 *
 * The session wires three collaborators together and owns nothing about
 * turn-taking itself:
 *
 * - {@link LiveVoiceIngest} — inbound PCM16 audio: energy VAD, turn
 *   segmentation, and streaming/batch STT. The client mic streams
 *   continuously; audio is accepted in every non-closed state.
 * - `CallController` (via the in-app `VoiceControllerProfile`) — turn
 *   state (`idle|processing|speaking`), barge-in gating, control markers
 *   (`[END_CALL]`), and the conversation pipeline via the voice bridge.
 * - {@link LiveVoiceCallTransport} — the controller's token stream,
 *   segmented streaming TTS, and `tts_audio`/`tts_done` frame emission.
 *
 * The session itself owns the socket-facing concerns: outbound frame
 * serialization (one promise chain feeding the manager's sequencer),
 * per-turn audio archiving, per-turn latency metrics, and the mapping
 * from ingest/controller events to protocol frames.
 *
 * Assistant text deltas are tapped at the transport token input (the
 * controller-facing transport wrapper below) rather than via bridge
 * callbacks: by that point the controller has already stripped control
 * markers and sanitized the text, so the `assistant_text_delta` frames
 * match exactly what is synthesized for TTS.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type { CallTransport } from "../calls/call-transport.js";
import type {
  VoiceSessionSnapshot,
  VoiceSessionSource,
} from "../calls/voice-session-source.js";
import { getConfig } from "../config/loader.js";
import { errorMessage } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type {
  LiveVoiceAudioArchiveResult,
  LiveVoiceAudioArchiveRole,
} from "./live-voice-archive.js";
import type { LiveVoiceCredentialReadiness } from "./live-voice-credential-preflight.js";
import {
  LiveVoiceIngest,
  type LiveVoiceIngestCallbacks,
  type LiveVoiceIngestConfig,
} from "./live-voice-ingest.js";
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
import {
  LiveVoiceCallTransport,
  type LiveVoiceCallTransportDeps,
} from "./live-voice-transport.js";
import type {
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "./live-voice-tts.js";
import {
  type LiveVoiceClientFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
  type LiveVoiceSessionMode,
} from "./protocol.js";

const log = getLogger("live-voice-session");

// ---------------------------------------------------------------------------
// Injectable collaborator surface
// ---------------------------------------------------------------------------

export type LiveVoiceTtsStreamer = (
  options: LiveVoiceTtsOptions,
) => Promise<LiveVoiceTtsResult>;

/** Ingest surface the session drives (production: {@link LiveVoiceIngest}). */
export interface LiveVoiceSessionIngest {
  start(): void;
  pushAudio(chunk: Buffer): void;
  forceTurnEnd(): void;
  stop(): void;
  dispose(): void;
}

export type LiveVoiceIngestFactory = (
  config: LiveVoiceIngestConfig,
  callbacks: LiveVoiceIngestCallbacks,
) => LiveVoiceSessionIngest;

/**
 * Transport surface the session drives. Extends the controller-facing
 * `CallTransport` with the per-turn assistant-audio drain used for
 * archiving and the TTS-queue drain awaited before a server-initiated
 * close (production: {@link LiveVoiceCallTransport}).
 */
export interface LiveVoiceSessionTransport extends CallTransport {
  collectAssistantAudio(): Buffer[];
  waitForTtsDrain(): Promise<void>;
}

export type LiveVoiceTransportFactory = (
  deps: LiveVoiceCallTransportDeps,
) => LiveVoiceSessionTransport;

/** Controller surface the session drives (production: `CallController`). */
export interface LiveVoiceSessionController {
  handleCallerUtterance(transcript: string): Promise<void>;
  handleBargeIn(onAccepted?: () => void): boolean;
  /**
   * Hard interrupt: aborts the in-flight run in any controller state
   * (unlike {@link handleBargeIn}, which gates on `speaking`).
   */
  handleInterrupt(): void;
  getState(): "idle" | "processing" | "speaking";
  destroy(): void;
}

export interface LiveVoiceSessionControllerOptions {
  /** The live-voice session id, used as the controller's callSessionId. */
  callSessionId: string;
  /** Controller-facing transport (the session's delta-tapping wrapper). */
  transport: CallTransport;
  /** In-app session source (no call_sessions row backs these sessions). */
  sessionSource: VoiceSessionSource;
  /**
   * Persisted-message-id hooks the controller profile forwards into each
   * voice turn; the session uses them to link per-turn audio archives to
   * the conversation messages.
   */
  onPersistedUserMessageId: (messageId: string) => void;
  onPersistedAssistantMessageId: (messageId: string) => void;
}

export type LiveVoiceControllerFactory = (
  options: LiveVoiceSessionControllerOptions,
) => LiveVoiceSessionController | Promise<LiveVoiceSessionController>;

export type LiveVoiceCredentialPreflight =
  () => Promise<LiveVoiceCredentialReadiness>;

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
  createIngest?: LiveVoiceIngestFactory;
  createTransport?: LiveVoiceTransportFactory;
  createController?: LiveVoiceControllerFactory;
  credentialPreflight?: LiveVoiceCredentialPreflight;
  archiveAudio?: LiveVoiceSessionAudioArchiver | null;
  emitMetrics?: boolean;
  metricsClock?: LiveVoiceMetricsClock;
  createTurnId?: () => string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type LiveVoiceSessionState = "open" | "closing" | "closed";

/**
 * One user-utterance → assistant-reply exchange. Created lazily when user
 * audio (or a transcript) arrives, flipped to `responding` when the final
 * transcript is dispatched to the controller, and finalized exactly once
 * (archive + metrics) on `tts_done`, barge-in, supersession, or close.
 */
interface SessionTurn {
  turnId: string;
  phase: "listening" | "responding";
  userAudioChunks: Buffer[];
  /** Running byte total of {@link userAudioChunks}, for the capture cap. */
  userAudioBytes: number;
  assistantAudioMimeType: string;
  assistantAudioSampleRate?: number;
  /**
   * Persisted conversation message ids for this exchange, reported by the
   * voice bridge (via the in-app profile hooks) once the pipeline persists
   * each message. Null until reported; archives fall back to unlinked
   * storage when a turn finalizes before the id arrives.
   */
  userMessageId: string | null;
  assistantMessageId: string | null;
  finalized: boolean;
}

/** How long a server-initiated end waits for queued TTS (the goodbye). */
const SERVER_END_TTS_DRAIN_TIMEOUT_MS = 5_000;

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly createIngest: LiveVoiceIngestFactory;
  private readonly createTransport: LiveVoiceTransportFactory;
  private readonly createController: LiveVoiceControllerFactory;
  private readonly credentialPreflight: LiveVoiceCredentialPreflight;
  private readonly archiveAudio: LiveVoiceSessionAudioArchiver | null;
  private readonly emitMetrics: boolean;
  private readonly metrics: LiveVoiceMetricsCollector;
  private readonly createTurnId: () => string;
  private readonly conversationId: string;

  private state: LiveVoiceSessionState = "open";
  private started = false;
  private ingest: LiveVoiceSessionIngest | null = null;
  private transport: LiveVoiceSessionTransport | null = null;
  private controller: LiveVoiceSessionController | null = null;
  private currentTurn: SessionTurn | null = null;
  /**
   * Per-turn user-audio capture cap in bytes (one VAD max-turn worth of
   * PCM), so an idle open-mic stream cannot grow a turn buffer unbounded.
   */
  private userAudioByteCap = Number.POSITIVE_INFINITY;
  /** Id of the most recent turn that reached the assistant phase. */
  private lastAssistantTurnId: string | null = null;
  /**
   * The turn whose transcript was most recently dispatched to the
   * controller. Persisted-message-id callbacks target this turn (not
   * whatever `currentTurn` happens to be when the pipeline reports the
   * id) so a callback that lands after a barge-in retired the turn is
   * dropped instead of stamping a successor turn.
   */
  private dispatchedTurn: SessionTurn | null = null;
  private outboundFrames: Promise<void> = Promise.resolve();
  private sessionEndMetricsEmitted = false;
  /** Guards the async server-initiated end flow against re-entry. */
  private serverEndStarted = false;

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.createIngest = options.createIngest ?? defaultCreateIngest;
    this.createTransport = options.createTransport ?? defaultCreateTransport;
    this.createController = options.createController ?? defaultCreateController;
    this.credentialPreflight =
      options.credentialPreflight ?? defaultCredentialPreflight;
    this.archiveAudio =
      options.archiveAudio === undefined
        ? defaultArchiveLiveVoiceAudio
        : options.archiveAudio;
    this.emitMetrics = options.emitMetrics ?? true;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
    this.metrics = new LiveVoiceMetricsCollector({
      sessionId: context.sessionId,
      conversationId: this.conversationId,
      ...(options.metricsClock ? { clock: options.metricsClock } : {}),
    });
  }

  async start(): Promise<void> {
    if (this.state !== "open" || this.started) {
      return;
    }
    this.started = true;

    let readiness: LiveVoiceCredentialReadiness;
    try {
      readiness = await this.credentialPreflight();
    } catch (err) {
      await this.failStartup(
        `Live voice could not verify provider credentials: ${errorMessage(err)}`,
        LiveVoiceProtocolErrorCode.CredentialsMissing,
      );
      return;
    }
    if (this.state !== "open") {
      return;
    }
    if (readiness.status === "not-ready") {
      await this.failStartup(
        readiness.userMessage,
        LiveVoiceProtocolErrorCode.CredentialsMissing,
      );
      return;
    }

    try {
      const liveVoiceConfig = getConfig().liveVoice;
      const mode: LiveVoiceSessionMode =
        this.context.startFrame.mode ?? liveVoiceConfig.mode;
      const { sampleRate } = this.context.startFrame.audio;
      this.userAudioByteCap =
        sampleRate * 2 * (liveVoiceConfig.vad.maxTurnDurationMs / 1000);

      const transport = this.createTransport({
        sendFrame: (payload) => this.sendTransportFrame(payload),
        streamTtsAudio: defaultStreamLiveVoiceTtsAudio,
        sampleRate,
        turnId: () =>
          this.currentTurn?.turnId ??
          this.lastAssistantTurnId ??
          this.context.sessionId,
        onSessionEnd: (reason) => this.handleControllerSessionEnd(reason),
        onTtsFailure: () => this.handleTtsFailure(),
      });
      this.transport = transport;

      this.controller = await this.createController({
        callSessionId: this.context.sessionId,
        transport: this.wrapTransportForController(transport),
        sessionSource: this.createSessionSource(),
        onPersistedUserMessageId: (messageId) =>
          this.handlePersistedMessageId("user", messageId),
        onPersistedAssistantMessageId: (messageId) =>
          this.handlePersistedMessageId("assistant", messageId),
      });
      if (this.state !== "open") {
        this.controller.destroy();
        this.controller = null;
        return;
      }

      this.ingest = this.createIngest(
        {
          sampleRate,
          mode,
          vad: liveVoiceConfig.vad,
        },
        this.createIngestCallbacks(),
      );
      this.ingest.start();
    } catch (err) {
      this.teardownCollaborators();
      await this.failStartup(
        `Live voice session could not be started: ${errorMessage(err)}`,
        LiveVoiceProtocolErrorCode.InvalidField,
      );
      return;
    }

    this.metrics.markReady();
    await this.sendFrame({
      type: "ready",
      sessionId: this.context.sessionId,
      conversationId: this.conversationId,
    });
  }

  async handleClientFrame(frame: LiveVoiceClientFrame): Promise<void> {
    if (this.state !== "open") {
      return;
    }

    switch (frame.type) {
      case "audio":
        this.handleAudio(Buffer.from(frame.dataBase64, "base64"));
        await this.drainOutboundFrames();
        return;
      case "ptt_release":
        // Manual end-of-turn: authoritative in PTT, a hint in open-mic.
        // No-ops in the ingest when the VAD never saw speech.
        if (this.currentTurn?.phase === "listening") {
          this.metrics.markPushToTalkRelease(this.currentTurn.turnId);
        }
        this.ingest?.forceTurnEnd();
        await this.drainOutboundFrames();
        return;
      case "interrupt":
        // Manual barge-in override: same path as server-VAD speech onset.
        // Ignored unless the assistant is actually speaking.
        this.tryBargeIn();
        await this.drainOutboundFrames();
        return;
      case "end":
        return;
      case "start":
        return;
    }
  }

  async handleBinaryAudio(chunk: Uint8Array): Promise<void> {
    if (this.state !== "open") {
      return;
    }
    this.handleAudio(Buffer.from(chunk));
    await this.drainOutboundFrames();
  }

  async close(_reason: LiveVoiceSessionCloseReason): Promise<void> {
    if (this.state !== "open") {
      return;
    }
    this.state = "closing";

    this.teardownCollaborators();

    const turn = this.currentTurn;
    if (turn) {
      await this.finalizeTurn(turn, "cancelled", "session_closed");
    }
    await this.emitSessionEndMetrics();
    this.state = "closed";
    await this.drainOutboundFrames();
    // Release the owner last so the manager slot (and the socket) is only
    // freed once the session has fully unwound.
    this.context.onSessionEnded?.();
  }

  // ── Inbound audio ────────────────────────────────────────────────────

  private handleAudio(chunk: Buffer): void {
    const ingest = this.ingest;
    if (!ingest) {
      return;
    }

    // Push before capturing: a speech onset detected inside pushAudio can
    // finalize the current (assistant) turn via barge-in, so the onset
    // chunk itself is captured into the *new* turn below.
    ingest.pushAudio(chunk);

    if (this.state !== "open") {
      return;
    }
    let turn = this.currentTurn;
    if (turn?.phase === "responding") {
      // Assistant is replying — the audio feeds the VAD (barge-in
      // detection) only. Capture resumes when barge-in or tts_done
      // opens the next turn.
      return;
    }
    turn ??= this.beginTurn();
    turn.userAudioChunks.push(chunk);
    turn.userAudioBytes += chunk.byteLength;
    while (
      turn.userAudioBytes > this.userAudioByteCap &&
      turn.userAudioChunks.length > 1
    ) {
      turn.userAudioBytes -= turn.userAudioChunks.shift()?.byteLength ?? 0;
    }
    if (turn.userAudioChunks.length === 1) {
      this.metrics.markFirstAudio(turn.turnId);
    }
  }

  // ── Ingest events ────────────────────────────────────────────────────

  private createIngestCallbacks(): LiveVoiceIngestCallbacks {
    return {
      onSpeechStart: () => {
        if (this.state !== "open") {
          return;
        }
        // Barge-in while the controller speaks, or while a responding
        // turn's synthesis tail is still playing after the controller
        // already went idle (tryBargeIn handles both).
        if (
          this.controller?.getState() === "speaking" ||
          this.currentTurn?.phase === "responding"
        ) {
          this.tryBargeIn();
          return;
        }
        // New speech onset while listening: drop inter-turn silence that
        // accumulated in the capture buffer (mirrors the ingest's own
        // turn-start buffer clear) so archives start at the utterance.
        const turn = this.currentTurn;
        if (turn?.phase === "listening") {
          turn.userAudioChunks.length = 0;
          turn.userAudioBytes = 0;
        }
      },
      onPartial: (text) => {
        if (this.state !== "open") {
          return;
        }
        const turn = this.currentTurn;
        if (turn?.phase === "listening") {
          this.metrics.markFirstPartial(turn.turnId);
        }
        void this.sendFrame({ type: "stt_partial", text });
      },
      onTranscriptFinal: (text) => {
        this.handleTranscriptFinal(text);
      },
      onTurnBoundary: () => {
        if (this.state !== "open") {
          return;
        }
        void this.sendFrame({ type: "turn_boundary" });
      },
      onError: (category, message) => {
        if (this.state !== "open") {
          return;
        }
        log.warn({ category }, `Live voice transcription error: ${message}`);
        const turn = this.currentTurn;
        // "unconfigured" means no transcriber can be resolved at all —
        // every future turn would fail the same way — so it is
        // session-fatal regardless of turn state. It fires from a turn's
        // transcription attempt, i.e. normally WITH a listening turn in
        // flight; checking the turn-scoped branch first would swallow the
        // fatality into an endless per-utterance cancellation loop.
        // Retire the in-flight turn (so the client's turn state machine
        // settles), then send the fatal error frame.
        if (category === "unconfigured") {
          if (turn?.phase === "listening") {
            this.cancelTurnWithNotice(
              turn,
              LiveVoiceProtocolErrorCode.SttFailed,
            );
          }
          void this.sendFrame({
            type: "error",
            code: LiveVoiceProtocolErrorCode.SttFailed,
            message: `Live voice transcription error (${category}): ${message}`,
          });
          return;
        }
        // Other categories are transient (the ingest keeps running or
        // falls back to batch STT) and turn-scoped whenever a user turn
        // is in flight: retire that turn with a machine reason so the
        // client resumes listening instead of treating the session as
        // dead. With no turn in flight there is nothing client-visible
        // to do.
        if (turn?.phase === "listening") {
          this.cancelTurnWithNotice(turn, LiveVoiceProtocolErrorCode.SttFailed);
        }
      },
    };
  }

  private handleTranscriptFinal(text: string): void {
    if (this.state !== "open" || !this.controller) {
      return;
    }

    void this.sendFrame({ type: "stt_final", text });

    const content = text.trim();
    let turn = this.currentTurn;
    if (content.length === 0) {
      // Nothing to dispatch. A listening turn that transcribed to nothing
      // is retired — with a turn_cancelled notice so the client resumes
      // listening instead of waiting for a response that never starts. A
      // responding turn is left alone (the empty final came from residual
      // noise, not a competing utterance).
      if (turn?.phase === "listening") {
        this.cancelTurnWithNotice(turn, "empty_transcript");
      }
      return;
    }

    if (turn?.phase === "responding") {
      // The user finished a new utterance while the assistant was still
      // responding (barge-in that never crossed the speaking gate, or a
      // fast follow-up). handleCallerUtterance aborts the in-flight
      // generation; retire the superseded turn first.
      void this.finalizeTurn(turn, "cancelled", "superseded");
      turn = null;
    }

    turn ??= this.beginTurn();
    this.metrics.markFinalTranscript(turn.turnId);
    turn.phase = "responding";
    this.lastAssistantTurnId = turn.turnId;
    void this.sendFrame({ type: "thinking", turnId: turn.turnId });

    const controller = this.controller;
    const dispatchedTurn = turn;
    this.dispatchedTurn = dispatchedTurn;
    void controller.handleCallerUtterance(content).catch((err) => {
      if (this.state !== "open") {
        return;
      }
      log.warn(
        { turnId: dispatchedTurn.turnId },
        `Live voice assistant turn failed: ${errorMessage(err)}`,
      );
      // The failure is scoped to this turn: retire it so the client
      // resumes listening instead of waiting on a dead turn.
      if (!dispatchedTurn.finalized) {
        this.cancelTurnWithNotice(
          dispatchedTurn,
          LiveVoiceProtocolErrorCode.TurnFailed,
        );
      }
    });
  }

  /**
   * Retire a turn that will never produce an assistant response and tell
   * the client so it resumes listening (the `archived`/`metrics` frames
   * alone do not advance the client's state machine).
   */
  private cancelTurnWithNotice(turn: SessionTurn, reason: string): void {
    void this.sendFrame({ type: "turn_cancelled", reason });
    void this.finalizeTurn(turn, "cancelled", reason);
  }

  // ── Barge-in ─────────────────────────────────────────────────────────

  /**
   * Attempt to interrupt the assistant.
   *
   * Controller path: accepted while the controller is `speaking`; the
   * controller flushes the transport's pending text/synthesis itself (via
   * discardPendingText) inside handleInterrupt. `onAccepted` runs before
   * that flush, so the `interrupted` frame and the turn's cancellation are
   * ordered ahead of any frames the flush suppresses.
   *
   * Session path: the controller flips `idle` when *generation* ends, but
   * the synthesized tail can still be playing (tts_done not yet emitted).
   * An interrupt in that window is handled at the session layer — flush
   * the transport's remaining synthesis, emit `interrupted`, and retire
   * the turn — without touching the controller's (shared, phone-critical)
   * turn lifecycle.
   */
  private tryBargeIn(): boolean {
    const controller = this.controller;
    if (!controller) {
      return false;
    }

    const turn = this.currentTurn;
    const accepted = controller.handleBargeIn(() => {
      const interruptedTurnId =
        turn?.turnId ?? this.lastAssistantTurnId ?? this.context.sessionId;
      void this.sendFrame({ type: "interrupted", turnId: interruptedTurnId });
      if (turn && turn.phase === "responding") {
        void this.finalizeTurn(turn, "cancelled", "barge_in");
      }
    });
    if (accepted) {
      return true;
    }

    if (
      controller.getState() === "idle" &&
      turn?.phase === "responding" &&
      !turn.finalized
    ) {
      this.transport?.discardPendingText?.();
      void this.sendFrame({ type: "interrupted", turnId: turn.turnId });
      void this.finalizeTurn(turn, "cancelled", "barge_in");
      return true;
    }

    return false;
  }

  /**
   * The transport reported a failed TTS synthesis job. TTS failures are
   * turn-scoped: retire the affected assistant turn with a `tts_failed`
   * cancellation so the client resumes listening, aborting the in-flight
   * generation/synthesis the same way a barge-in does so straggler audio
   * cannot follow the cancellation notice. A failure with no live
   * assistant turn (the turn already completed or was barged in) needs no
   * client-visible reaction.
   */
  private handleTtsFailure(): void {
    if (this.state !== "open") {
      return;
    }
    const turn = this.currentTurn;
    if (turn?.phase !== "responding" || turn.finalized) {
      return;
    }

    const cancelTurn = () =>
      this.cancelTurnWithNotice(turn, LiveVoiceProtocolErrorCode.TtsFailed);
    if (this.controller?.handleBargeIn(cancelTurn)) {
      return;
    }
    // The speaking-gated barge-in was rejected: the controller is either
    // still `processing` (the failed job was the turn's first synthesis —
    // the generation is still running with no audio out) or already
    // `idle` (only the synthesis tail was live). Order the cancellation
    // notice first, as the accepted path does, then hard-abort the run:
    // handleInterrupt works in any state and bumps the run version so no
    // assistant_text_delta/tts_audio from this run can follow the
    // turn_cancelled notice (with no audio started it emits no
    // end-of-turn marker either).
    cancelTurn();
    this.controller?.handleInterrupt();
    this.transport?.discardPendingText?.();
  }

  // ── Assistant output ─────────────────────────────────────────────────

  /**
   * Controller-facing transport wrapper: taps the token stream so each
   * (already marker-stripped, TTS-sanitized) token is forwarded to the
   * client as an `assistant_text_delta` frame in addition to reaching
   * the real transport for TTS synthesis.
   */
  private wrapTransportForController(
    transport: LiveVoiceSessionTransport,
  ): CallTransport {
    return {
      sendTextToken: (token, last) => {
        this.handleAssistantToken(token);
        transport.sendTextToken(token, last);
      },
      sendPlayUrl: (url) => transport.sendPlayUrl(url),
      endSession: (reason) => transport.endSession(reason),
      setAudioStartCallback: (cb) => transport.setAudioStartCallback?.(cb),
      discardPendingText: () => transport.discardPendingText?.(),
    };
  }

  /**
   * The voice bridge persisted a conversation message for the in-flight
   * exchange. Recorded on the turn that was dispatched to the controller
   * — not whatever turn is current when the pipeline reports the id — so
   * a late callback can never stamp a successor turn. Ids for a turn that
   * already finalized (barge-in, supersession) are dropped — that turn's
   * audio was archived unlinked.
   */
  private handlePersistedMessageId(
    role: LiveVoiceAudioArchiveRole,
    messageId: string,
  ): void {
    const turn = this.dispatchedTurn;
    if (!turn || turn.finalized) {
      return;
    }
    if (role === "user") {
      turn.userMessageId = messageId;
    } else {
      turn.assistantMessageId = messageId;
    }
  }

  private handleAssistantToken(token: string): void {
    if (token.length === 0 || this.state !== "open") {
      return;
    }
    const turn = this.currentTurn;
    if (turn?.phase === "responding") {
      this.metrics.markFirstAssistantDelta(turn.turnId);
    }
    void this.sendFrame({ type: "assistant_text_delta", text: token });
  }

  /**
   * Outbound sink for the transport's frames. `tts_audio` is annotated
   * into the current turn (archive metadata + first-audio metric);
   * `tts_done` completes the turn — a `tts_done` whose turn is already
   * finalized (the controller emits one while unwinding a barge-in) is
   * dropped so an aborted turn's end-of-turn marker never reaches the
   * client or completes the next turn.
   */
  private sendTransportFrame(
    payload: LiveVoiceServerFramePayload,
  ): Promise<void> {
    if (payload.type === "tts_audio") {
      const turn = this.currentTurn;
      if (turn?.phase === "responding") {
        turn.assistantAudioMimeType = payload.mimeType;
        turn.assistantAudioSampleRate = payload.sampleRate;
        this.metrics.markFirstTtsAudio(turn.turnId);
      }
      return this.sendFrame(payload);
    }

    if (payload.type === "tts_done") {
      const turn = this.currentTurn;
      if (
        !turn ||
        turn.phase !== "responding" ||
        turn.turnId !== payload.turnId
      ) {
        return Promise.resolve();
      }
      const sendPromise = this.sendFrame(payload);
      void this.finalizeTurn(turn, "completed", "completed");
      return sendPromise;
    }

    return this.sendFrame(payload);
  }

  /**
   * [END_CALL] / max-duration: the controller asked to end the session.
   * The goodbye is typically still in the transport's TTS queue at this
   * point, so drain it (bounded — a hung provider must not block close),
   * tell the client the session is over, then close. Closing eagerly would
   * destroy the controller, whose teardown discards the queued goodbye.
   */
  private handleControllerSessionEnd(reason?: string): void {
    if (this.state !== "open" || this.serverEndStarted) {
      return;
    }
    this.serverEndStarted = true;

    void (async () => {
      const drained = this.transport?.waitForTtsDrain();
      if (drained) {
        await Promise.race([
          drained,
          new Promise<void>((resolve) =>
            setTimeout(resolve, SERVER_END_TTS_DRAIN_TIMEOUT_MS),
          ),
        ]);
      }
      if (this.state !== "open") {
        return;
      }
      await this.sendFrame({
        type: "session_ended",
        reason: reason ?? "session_ended",
      });
      await this.close("client_end");
    })();
  }

  // ── Turn lifecycle ───────────────────────────────────────────────────

  private beginTurn(): SessionTurn {
    // Drop idle-period assistant audio (e.g. the silence nudge) so it is
    // never archived under this turn's id.
    this.transport?.collectAssistantAudio();

    const turn: SessionTurn = {
      turnId: this.createTurnId(),
      phase: "listening",
      userAudioChunks: [],
      userAudioBytes: 0,
      assistantAudioMimeType: "audio/pcm",
      userMessageId: null,
      assistantMessageId: null,
      finalized: false,
    };
    this.currentTurn = turn;
    this.metrics.startTurn(turn.turnId);
    return turn;
  }

  /**
   * Finalize a turn exactly once: settle its metrics synchronously (so a
   * successor turn can start immediately without racing the collector),
   * snapshot both audio buffers, then archive and emit the `archived` +
   * `metrics` frames asynchronously on the outbound chain.
   */
  private finalizeTurn(
    turn: SessionTurn,
    status: "completed" | "cancelled",
    reason: string,
  ): Promise<void> {
    if (turn.finalized) {
      return Promise.resolve();
    }
    turn.finalized = true;
    if (this.currentTurn === turn) {
      this.currentTurn = null;
    }

    if (status === "completed") {
      this.metrics.completeTurn(turn.turnId);
    } else {
      this.metrics.cancelTurn(reason, turn.turnId);
    }

    // Snapshot audio now: draining the transport here (not later) is the
    // stale-turn guard — audio synthesized for this turn can never be
    // attributed to a successor turn's archive.
    const userAudioChunks = turn.userAudioChunks;
    const assistantAudioChunks = this.transport?.collectAssistantAudio() ?? [];

    return (async () => {
      await this.archiveBufferedAudio({
        turnId: turn.turnId,
        userAudioChunks,
        assistantAudioChunks,
        assistantAudioMimeType: turn.assistantAudioMimeType,
        userMessageId: turn.userMessageId,
        assistantMessageId: turn.assistantMessageId,
        ...(turn.assistantAudioSampleRate !== undefined
          ? { assistantAudioSampleRate: turn.assistantAudioSampleRate }
          : {}),
      });
      if (this.emitMetrics) {
        await this.emitMetricsFrame(
          status === "completed" ? "turn_completed" : "turn_cancelled",
          turn.turnId,
        );
      }
    })();
  }

  // ── Archiving ────────────────────────────────────────────────────────

  private async archiveBufferedAudio(input: {
    turnId: string;
    userAudioChunks: Buffer[];
    assistantAudioChunks: Buffer[];
    assistantAudioMimeType: string;
    assistantAudioSampleRate?: number;
    userMessageId: string | null;
    assistantMessageId: string | null;
  }): Promise<void> {
    const userAudio = takeBufferedAudio(input.userAudioChunks);
    if (userAudio) {
      await this.archiveBufferedRoleAudio({
        turnId: input.turnId,
        role: "user",
        mimeType: this.context.startFrame.audio.mimeType,
        sampleRate: this.context.startFrame.audio.sampleRate,
        audio: userAudio,
        messageId: input.userMessageId,
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
        mimeType: input.assistantAudioMimeType,
        sampleRate,
        audio: assistantAudio,
        messageId: input.assistantMessageId,
      });
    }
  }

  private async archiveBufferedRoleAudio(input: {
    turnId: string;
    role: LiveVoiceAudioArchiveRole;
    mimeType: string;
    sampleRate: number;
    audio: Buffer;
    /** Persisted message to link to; null archives unlinked (but stored). */
    messageId: string | null;
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

  // ── Metrics frames ───────────────────────────────────────────────────

  private async emitSessionEndMetrics(): Promise<void> {
    if (!this.emitMetrics || this.sessionEndMetricsEmitted) {
      return;
    }

    this.sessionEndMetricsEmitted = true;
    await this.emitMetricsFrame(
      "session_ended",
      this.lastAssistantTurnId ?? this.context.sessionId,
    );
  }

  private async emitMetricsFrame(
    event: LiveVoiceMetricsEvent,
    turnId: string,
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

  // ── Startup failure / teardown ───────────────────────────────────────

  private async failStartup(
    message: string,
    code: LiveVoiceProtocolErrorCode,
  ): Promise<never> {
    this.state = "closed";
    await this.sendFrame({ type: "error", code, message });
    await this.drainOutboundFrames();
    throw new LiveVoiceSessionStartupError(message);
  }

  private teardownCollaborators(): void {
    const ingest = this.ingest;
    this.ingest = null;
    if (ingest) {
      try {
        ingest.stop();
      } catch {
        // Best-effort deliberate stop; dispose below clears state anyway.
      }
      ingest.dispose();
    }

    const controller = this.controller;
    this.controller = null;
    if (controller) {
      try {
        controller.destroy();
      } catch {
        // Controller teardown failures must not block session close.
      }
    }
  }

  // ── Outbound frame serialization ─────────────────────────────────────

  private async sendFrame(frame: LiveVoiceServerFramePayload): Promise<void> {
    this.outboundFrames = this.outboundFrames
      .catch(() => {})
      .then(async () => {
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

  // ── Session source ───────────────────────────────────────────────────

  private createSessionSource(): VoiceSessionSource {
    const startedAt = Date.now();
    return {
      conversationId: this.conversationId,
      // The user launched the session themselves — no disclosure.
      skipDisclosure: true,
      getSnapshot: (): VoiceSessionSnapshot => ({
        // Terminal once closing so the controller's end paths (END_CALL,
        // max duration) short-circuit instead of re-finalizing.
        status: this.state === "open" ? "in_progress" : "completed",
        conversationId: this.conversationId,
        initiatedFromConversationId: null,
        startedAt,
        toNumber: "",
      }),
    };
  }
}

export function createLiveVoiceSession(
  context: LiveVoiceSessionFactoryContext,
  options: LiveVoiceSessionOptions = {},
): LiveVoiceSession {
  return new LiveVoiceSession(context, options);
}

// ---------------------------------------------------------------------------
// Production defaults (heavy dependencies loaded lazily)
// ---------------------------------------------------------------------------

function defaultCreateIngest(
  config: LiveVoiceIngestConfig,
  callbacks: LiveVoiceIngestCallbacks,
): LiveVoiceSessionIngest {
  return new LiveVoiceIngest(config, callbacks);
}

function defaultCreateTransport(
  deps: LiveVoiceCallTransportDeps,
): LiveVoiceSessionTransport {
  return new LiveVoiceCallTransport(deps);
}

async function defaultCreateController(
  options: LiveVoiceSessionControllerOptions,
): Promise<LiveVoiceSessionController> {
  const [{ CallController }, { createInAppVoiceControllerProfile }] =
    await Promise.all([
      import("../calls/call-controller.js"),
      import("../calls/voice-session-source.js"),
    ]);
  // task: null → inbound semantics; the session opens listening (no
  // startInitialGreeting) — in-app users speak first.
  return new CallController(options.callSessionId, options.transport, null, {
    sessionSource: options.sessionSource,
    profile: createInAppVoiceControllerProfile({
      onPersistedUserMessageId: options.onPersistedUserMessageId,
      onPersistedAssistantMessageId: options.onPersistedAssistantMessageId,
    }),
  });
}

async function defaultCredentialPreflight(): Promise<LiveVoiceCredentialReadiness> {
  const { resolveLiveVoiceCredentialReadiness } =
    await import("./live-voice-credential-preflight.js");
  return resolveLiveVoiceCredentialReadiness();
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
