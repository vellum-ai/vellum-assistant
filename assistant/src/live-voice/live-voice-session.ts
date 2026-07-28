import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  MediaTurnDetector,
  type TurnDetectorConfig,
} from "../calls/media-turn-detector.js";
import { sanitizeForTts } from "../calls/tts-text-sanitizer.js";
import {
  isIncompleteControlMarkerTail,
  MINIMIZE_ROOM_MARKER,
  stripInternalSpeechMarkers,
} from "../calls/voice-control-protocol.js";
import type {
  VoiceTurnHandle,
  VoiceTurnOptions,
} from "../calls/voice-session-bridge.js";
import {
  getConversationTurnTeardown,
  resolveProcessingWaitMs,
  VOICE_NO_SETUP_FLOWS_RULE,
  waitForPriorTurnTeardown,
} from "../calls/voice-session-bridge.js";
import {
  capEscalationBridge,
  classifyFrontDoorLeading,
  ESCALATE_VERDICT_TOKEN,
  ESCALATION_CONTINUATION_CONTENT,
  FALLBACK_ESCALATION_BRIDGE,
  isEscalationBridgeComplete,
  MIN_SPOKEN_BRIDGE_CHARS,
  type VoiceRoutingLeg,
} from "../calls/voice-triage-escalate.js";
import { getConfig } from "../config/loader.js";
import {
  type LiveVoiceFrontModelConfig,
  LiveVoiceFrontModelConfigSchema,
} from "../config/schemas/live-voice.js";
import { ABORT_WATCHDOG_MS } from "../daemon/abort-watchdog.js";
import { isRefusedInReadOnlyPass } from "../daemon/conversation-tool-setup.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { isInstalledStaticSkillLoad } from "../permissions/checker.js";
import { ensureConversationExists } from "../persistence/conversation-crud.js";
import {
  listProviderIds,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { publishConversationListAndMetadataChanged } from "../runtime/sync/resource-sync-events.js";
import { detectPcm16SpeechActivity } from "../stt/speech-energy.js";
import type {
  StreamingTranscriber,
  SttStreamServerErrorEvent,
  SttStreamServerEvent,
} from "../stt/types.js";
import { getSubagentManager } from "../subagent/index.js";
import { getToolOwner } from "../tools/registry.js";
import { extractSpeakableSegments } from "../tts/speakable-segments.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  createVoiceFrontDecider,
  type VoiceFrontDecider,
  type VoiceProgressTextInput,
} from "./front-decision.js";
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
  type LiveVoiceSpokenAckKind,
  type LiveVoiceTurnSeedMarks,
  type VoiceEndpointAction,
} from "./live-voice-metrics.js";
import {
  type LiveVoiceSession as LiveVoiceSessionContract,
  type LiveVoiceSessionCloseReason,
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionStartupError,
} from "./live-voice-session-manager.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "./live-voice-tts.js";
import { pickProgressPhrase } from "./progress-phrases.js";
import {
  type LiveVoiceClientFrame,
  type LiveVoiceClientUpdateConfigFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

const log = getLogger("live-voice-session");

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
// Bounded wait for the shared transcriber's finalize flush; on expiry the
// assistant turn proceeds with the transcript collected so far. This is the
// strict upper bound on the release→turn-start tail in persistent mode (the
// provider keeps its own, longer, finalize fallback).
const FINALIZE_GRACE_MS = 1_000;
// Consecutive speech (ms) required before speech during assistant playback
// flushes it (speech_started) and cancels the turn, so a cough, a filler word,
// or the assistant's own TTS bleeding through imperfect browser echo
// cancellation cannot kill a reply mid-sentence. Mirrors the
// liveVoice.vad.bargeInMinSpeechMs schema default; 0 disables the guard for
// instant barge-in.
const DEFAULT_BARGE_IN_MIN_SPEECH_MS = 250;
// Mirrors MediaTurnDetector's DEFAULT_SILENCE_THRESHOLD_MS: the session
// tracks the effective trailing-silence threshold (the detector keeps its own
// copy private) so the endpoint decider can report the pause length.
const DEFAULT_SILENCE_THRESHOLD_MS = 800;
// Longest continuous sub-threshold gap the sustained-speech barge-in run
// tolerates without resetting. A gap this short is a syllable boundary, or the
// choppy energy the browser's half-duplex echo canceller produces while the
// assistant is still playing (it ducks the user's near-end voice, so post-AEC
// user speech arrives as intermittent above-gate chunks) — so the run keeps
// accumulating across it and a barge-in during playback still lands. Only a
// longer continuous silence (a real end of speech, or an isolated cough) resets
// the run.
const BARGE_IN_GAP_TOLERANCE_MS = 200;
// Ceiling on cumulative sub-threshold time across a whole barge-in run, as a
// multiple of bargeInMinSpeechMs. Per-gap tolerance alone lets sparse isolated
// blips (e.g. a 10 ms echo spike every 200 ms) each clear the consecutive-gap
// timer while retaining prior speech, so they would sum to the guard over
// several seconds and fire a barge-in with no sustained user speech. Capping the
// run's total tolerated silence imposes a minimum above-gate duty cycle
// (1 / (1 + ratio) ≈ 20%): once the run is mostly silence it resets, so genuine
// choppy speech still lands but periodic noise cannot accumulate into one.
const BARGE_IN_MAX_TOLERATED_SILENCE_RATIO = 4;
// At most this many TTS segment jobs are open (provider stream started,
// frames not yet fully emitted) per turn: the emitting job plus one
// prefetching job. The prefetch buffers its chunks in memory until promoted;
// a segment is at most ~180 chars of speech (~10 s of 24 kHz mono PCM
// ≈ 480 KB), so one buffered segment is an acceptable bound.
const TTS_MAX_OPEN_SYNTHESIS_JOBS = 2;
// Audible silence required before a finished background continuation's result
// is spoken into a live call. Long enough that the announcement lands in a real
// lull rather than on the heels of the turn that just ended; short enough that
// the user is not left wondering whether the work survived.
const CONTINUATION_ANNOUNCE_SILENCE_MS = 1_500;
// How many times a pending announcement re-arms itself against a client
// playback tail that outlasted its timer. Each re-arm waits out the whole
// remaining tail, so one covers a reply of any length; the rest cover a fresh
// reply's audio landing between two checks. Beyond the cap the announcement
// falls back to the stash rather than chasing a call that keeps talking.
const CONTINUATION_ANNOUNCE_MAX_DRAIN_REARMS = 3;
// `content` of an announcement turn. The answer never rides here — it goes in
// the model-facing control prompt (buildLiveDeliveryNote), so the only thing
// persisted on the user side is this marker, and it persists hidden.
export const CONTINUATION_DELIVERY_CONTENT =
  "(background work finished — deliver it now)";

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

// Runs an interrupted live-voice turn to completion on a background subagent.
// The run itself is silent (no parent notification); it RESOLVES with the
// continuation's final answer text, and the session decides where that goes —
// the next turn the user starts, an announcement into audible silence, or the
// conversation once the call has ended. Aborts when `signal` fires (rejecting).
// Injected for testability; the factory wires the real SubagentManager-backed
// impl.
export type LiveVoiceBackgroundContinuationSpawner = (args: {
  parentConversationId: string;
  objective: string;
  label: string;
  signal: AbortSignal;
}) => Promise<string>;

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
  /**
   * Sustained speech (ms) required before speech during assistant playback
   * interrupts it (barge-in); 0 disables the guard. The production factory
   * seeds this from `liveVoice.vad.bargeInMinSpeechMs` config when unset;
   * defaults to `DEFAULT_BARGE_IN_MIN_SPEECH_MS`.
   */
  bargeInMinSpeechMs?: number;
  /**
   * Overrides the bounded wait for the shared transcriber's finalize
   * flush in persistent mode (test hook). Defaults to `FINALIZE_GRACE_MS`.
   */
  finalizeGraceMs?: number;
  /**
   * Front-model presence tuning (semantic endpointing + spoken acks). The
   * production factory seeds this from `liveVoice.frontModel` config when
   * unset; absent fields fall back to the schema defaults (the constructor
   * schema-parses the partial into a complete config).
   */
  frontModelConfig?: Partial<LiveVoiceFrontModelConfig>;
  /**
   * Front-model phrasing service: spoken acks and progress narration. The
   * production factory constructs it from `liveVoice.frontModel` config when
   * unset; `null` disables front-model LLM calls, so no ack is ever spoken
   * and narration falls back to its static phrases.
   */
  frontDecider?: VoiceFrontDecider | null;
  /**
   * Spawns the background continuation for a barged-in turn. The factory wires
   * the real SubagentManager-backed implementation; tests inject a stub.
   */
  spawnBackgroundContinuation?: LiveVoiceBackgroundContinuationSpawner;
  /**
   * Returns the pending teardown promise for a conversation's most recent
   * turn. The barge-in path awaits it before forking the background
   * continuation so the fork snapshots history only after the interrupted
   * turn's completed tool calls have settled in. The factory wires the
   * bridge's `getConversationTurnTeardown`; tests inject a controllable
   * promise to exercise the ordering.
   */
  getTurnTeardown?: (conversationId: string) => Promise<void> | undefined;
  /**
   * Overrides the bounded wait for the interrupted turn's teardown before the
   * background continuation forks (test hook). Defaults to the bridge's
   * teardown budget (`resolveProcessingWaitMs`).
   */
  detachTeardownSettleTimeoutMs?: number;
  /**
   * Overrides the audible silence a finished continuation waits out before its
   * result is announced into a live, idle call (test hook). Defaults to
   * `CONTINUATION_ANNOUNCE_SILENCE_MS`.
   */
  continuationAnnounceSilenceMs?: number;
}

type LiveVoiceUtterancePhase =
  | "pending"
  | "streaming"
  | "released"
  // The cycle's transcript is complete and the assistant turn may start.
  // In per-cycle mode the transcriber socket has closed; in persistent
  // (shared-transcriber) mode the stream stays open — the finalize flush
  // (or its grace timeout) completed instead.
  | "transcriber_closed";

// One capture→transcribe→turn cycle. A session runs many of these back to
// back: each cycle owns its transcript, audio buffers, and metrics-turn
// flags so consecutive turns stay isolated. The transcriber is per-cycle in
// manual mode and a session-shared instance in persistent server-VAD mode.
interface UtteranceCycle {
  phase: LiveVoiceUtterancePhase;
  released: boolean;
  assistantTurnStarted: boolean;
  // The whole cycle (turn included) finalized; the record can no longer
  // accept audio and the session may re-arm over it.
  completed: boolean;
  // A `Finalize` request for this cycle went out on the shared stream, so
  // one `finalized` signal is owed to it. At most one queued cycle has
  // this set at a time — see pumpFinalizeQueue.
  finalizeRequested: boolean;
  transcriber: StreamingTranscriber | null;
  // Manual (push-to-talk) capture routed at least one chunk into this cycle.
  // It is the only evidence the user is mid-utterance before STT emits
  // anything: the pending buffers empty out as soon as the transcriber is
  // streaming, and the archival buffer only fills when audio archiving is on.
  // server_vad has the turn detector for the same question, and never sets
  // this — its ingress is handleServerVadAudio.
  manualAudioCaptured: boolean;
  pendingAudioChunks: Buffer[];
  pendingAudioBytes: number;
  finalTranscriptSegments: string[];
  // Latest non-final STT partial trailing the finals, fed to the semantic
  // endpoint decider. Cleared when a final commits it.
  latestPartialText: string | null;
  // Consecutive semantic-endpointing "hold" extensions this utterance has
  // consumed, bounded by `endpointMaxExtensions`.
  endpointExtensionCount: number;
  // The transcript the most recent hold verdict judged (unified front-door).
  // A final segment arriving during the extension window that extends this
  // text replays the boundary immediately — the hold was judged on stale
  // text, so waiting out the extension only adds silence.
  heldSpeculativeContent: string | null;
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

// One TTS segment flowing through the turn's synthesis pipeline. Synthesis
// may run ahead of the emission slot (prefetch), but frames only reach the
// client in job-list order.
interface TtsSegmentJob {
  readonly text: string;
  // The provider stream was started (the job holds an open-job slot).
  started: boolean;
  // Emission finished; the slot is free for the next queued segment.
  settled: boolean;
  // The job owns the emission slot: provider chunks forward to the client
  // live instead of buffering.
  emitting: boolean;
  // Chunks received while prefetching, flushed in order on promotion.
  // Dropped with the turn on cancellation.
  bufferedChunks: LiveVoiceTtsAudioChunk[];
  // Settles when the provider stream ends; rejects on synthesis failure.
  synthesis: Promise<void> | null;
  // Ordered tts_audio frame writes for this job.
  frames: Promise<void>;
}

// One tool operation observed on a turn, fed by the bridge's structured tool
// callbacks. `completedAtMs`/`isError`/`resultPreview` land with tool_result.
interface TurnProgressOp {
  toolName: string;
  toolUseId?: string;
  startedAtMs: number;
  completedAtMs?: number;
  isError?: boolean;
  resultPreview?: string;
}

// Per-turn tool-activity log and narration cadence state for spoken progress
// updates (liveVoice.frontModel.progress).
interface TurnProgressState {
  // Tool operations this turn, in start order.
  ops: TurnProgressOp[];
  // Ops accumulated toward the next ops-triggered narration. Counted once per
  // op, on start (not completion), so a burst of slow tools still trips the
  // threshold while they run.
  opsSinceNarration: number;
  // Bumped by every observable change to the turn's tool activity — an op
  // starting or finishing. The idle trigger compares it against
  // `narratedEpoch` so a tick with nothing new to report stays silent.
  stateEpoch: number;
  // The `stateEpoch` the last spoken narration described: the activity the
  // user has already been told about.
  narratedEpoch: number;
  // Narrations actually spoken this turn — the metrics count and the
  // decider's 1-based updateIndex. Rate, not count, bounds narration:
  // idleIntervalMs/minGapMs cap the cadence and the session duration cap
  // bounds the turn.
  updatesSpoken: number;
  // When the last spoken floor-holder (ack or narration) enqueued — gates the
  // progress.minGapMs spacing guard. Null until something speaks.
  lastFloorHolderAtMs: number | null;
  // When the turn's last TTS segment finished emitting (turn launch until
  // anything speaks). Together with the session-level playback-tail estimate
  // this anchors the dead-air countdown: idle time is measured from when the
  // user last heard something, not from when the turn started.
  lastAudibleAtMs: number;
  // Self-re-arming dead-air narration timer; null once cleared or fired.
  idleTimer: ReturnType<typeof setTimeout> | null;
  // A narration generation is awaiting the decider; serializes narrations.
  narrationInFlight: boolean;
}

// Newest incomplete op, optionally restricted to a tool name (the
// tool_result fallback match when no toolUseId correlates).
function findLastIncompleteOp(
  ops: TurnProgressOp[],
  toolName?: string,
): TurnProgressOp | undefined {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (
      op.completedAtMs === undefined &&
      (toolName === undefined || op.toolName === toolName)
    ) {
      return op;
    }
  }
  return undefined;
}

interface ActiveAssistantTurn {
  token: symbol;
  turnId: string;
  utterance: UtteranceCycle;
  abortController: AbortController;
  handle: VoiceTurnHandle | null;
  // When the turn launched, for narration's turnElapsedMs.
  launchedAtMs: number;
  progress: TurnProgressState;
  assistantCompleted: boolean;
  ttsDone: boolean;
  // Latched when the leg's stream contains MINIMIZE_ROOM_MARKER; consumed
  // once at TTS drain, where the minimize_room frame goes out after tts_done.
  minimizeRequested: boolean;
  // A tts_audio frame actually went out to the client — latches on the first
  // forwarded chunk so the firstTtsAudio metric is marked exactly once per turn.
  ttsAudioStarted: boolean;
  finalized: boolean;
  // Unified front-door speculative dispatch: the leg is in flight but its
  // leading verdict (hold vs commit) has not arrived. The thinking
  // frame, ack timer, and progress timer are deferred to commit; a hold
  // verdict discards the leg and rolls back its persisted user message.
  speculativePending: boolean;
  // vadSpeechGeneration at dispatch — a mismatch at verdict time means
  // speech resumed mid-flight, so the leg is discarded, never committed.
  speculativeGeneration: number;
  // The dispatched (pre-finalize) transcript, kept until the final
  // transcript lands so divergence can be logged (see
  // startAssistantTurnIfReady). Null once checked or for normal turns.
  speculativeContent: string | null;
  speculativeDispatchedAtMs: number;
  // Whether this speculative leg may hold: true only on an utterance's FIRST
  // dispatch. An extension replay already held once — a second silence means
  // the caller is done, so the replay leg is not taught the hold token and
  // its leading tokens can only escalate or answer.
  speculativeHoldAllowed: boolean;
  // Verdict-deadline fail-open: if a speculative leg produces no verdict
  // within the endpoint budget, the turn commits anyway (thinking frame +
  // ack timer arm) so a provider TTFT tail is bounded dead air instead of
  // unbounded structural silence. Null once fired, cleared, or committed.
  verdictDeadlineTimer: ReturnType<typeof setTimeout> | null;
  // The turn was discarded before its bridge handle resolved (speech can
  // resume while startVoiceTurn is still persisting). The handle's arrival
  // must complete the rollback via discard(), not a plain abort — otherwise
  // the discarded pause's user row leaks into history.
  discardRequested: boolean;
  // Accumulates leg deltas until the verdict resolves (whitespace-only
  // prefixes carry no verdict).
  speculativeBuffer: string;
  // When this turn started from a barge-in, the interrupted request's
  // transcript. Appended to the turn's control prompt (both legs) so the model
  // merges it with this turn's utterance instead of treating that utterance as
  // a fresh follow-up. Null for an ordinary (non-barge-in) turn.
  interruptedRequest: string | null;
  // The completed background continuation's answer, folded into this turn's
  // control prompt as context so the model can deliver or reference it in reply
  // to the user's own utterance. Null when no continuation result is pending.
  continuationResult: string | null;
  // Set only on an announcement turn: the interrupted request and the
  // continuation's answer, which the turn exists solely to deliver. The turn has
  // no user utterance behind it — `content` is CONTINUATION_DELIVERY_CONTENT and
  // the answer rides the control prompt (buildLiveDeliveryNote).
  continuationDelivery: ContinuationDelivery | null;
  // Set when a barge-in handed the interrupted work to a background subagent:
  // that request's transcript, so the model can tell the user the work is
  // still running instead of appearing to have dropped it.
  handedOffRequest: string | null;
  // The queued announcement this turn consumed alongside `continuationResult`
  // — the two are routes for one answer, so launching consumes both. Held here
  // so a rolled-back speculative dispatch can re-arm it (see
  // restorePendingTurnContext). Null on the announcement turn itself, which
  // owns its delivery outright.
  consumedAnnouncement: ContinuationDelivery | null;
  // `detachStopGeneration` at the moment this turn consumed the pending
  // context. A bump since then means a stop/interrupt/supersede deliberately
  // dropped the continuation, so a rollback must not resurrect it.
  pendingContextStopGeneration: number;
  // The agent run started a definitive tool use this turn — tool use implies
  // a guaranteed-slow turn, so acknowledgment logic can key off this.
  toolUseStarted: boolean;
  // The model's first streamed delta reached this session — the spoken-ack
  // timer is moot once real output is flowing.
  firstDeltaSeen: boolean;
  // Counts assistant text deltas seen this turn. A narration generation
  // captures it at launch and discards its result if it moved: text the model
  // produced mid-generation makes the narration stale, and proves the model
  // is alive — which is exactly what narration exists to paper over.
  deltaEpoch: number;
  // A spoken ack was enqueued this turn. Every ack trigger shares this
  // one-per-turn budget so a slow turn never stacks fillers.
  ackSpoken: boolean;
  // An ack generation is awaiting the decider. While true, the ack has not
  // yet stamped `lastFloorHolderAtMs`, so narration must treat it as a
  // floor-holder-in-waiting and stand down —
  // otherwise a progress phrase could land back-to-back with the ack.
  ackGenerationPending: boolean;
  // Pending slow-first-delta ack timer; null once cleared or fired.
  ackTimer: ReturnType<typeof setTimeout> | null;
  // Triage-and-escalate (Voice Mode): the front-door leg gave the escalate
  // verdict and the strong "escalated" leg has taken over this same turn.
  // Guards the
  // front-door leg's trailing completion from finalizing the turn, and makes
  // the hand-off idempotent.
  escalationHandedOff: boolean;
  ttsBuffer: string;
  // A non-empty speakable segment reached the TTS queue — gates the eager
  // first-segment flush that trades clause quality for speech onset.
  ttsSegmentEnqueued: boolean;
  // Ordered TTS segment jobs for the turn; synthesis runs ahead of emission
  // by at most one job (TTS_MAX_OPEN_SYNTHESIS_JOBS).
  ttsJobs: TtsSegmentJob[];
  // Serial emission chain: one job's frames fully precede the next's, and
  // the tts_done finale runs only after every job has drained.
  ttsQueue: Promise<void>;
  assistantMessageId: string | null;
  assistantAudioChunks: Buffer[];
  assistantAudioMimeType: string;
  assistantAudioSampleRate?: number;
}

/**
 * Control-marker hygiene for one model leg's delta stream, shared by the
 * front-door answer stage and the default/escalated leg. The returned flush
 * forwards the stripped (stripInternalSpeechMarkers) prefix of `raw` that has
 * not been emitted yet and cannot contain a still-streaming control marker:
 * the flush stops at the first "[" whose tail is an incomplete marker
 * (isIncompleteControlMarkerTail) and holds from there until a later delta
 * completes or disproves it; `force` (leg completion) emits the held tail so
 * real text that merely resembles a marker prefix is not dropped. The scan
 * runs forward from the emitted boundary — not from the last "[" — so
 * brackets INSIDE a streaming marker body (a JSON array or "]"-bearing string
 * in ASK_GUARDIAN_APPROVAL) can neither mask the marker's start nor pass as
 * its terminator. As a side effect the force flush latches the turn's
 * `minimizeRequested` when the completed stream ENDS with
 * MINIMIZE_ROOM_MARKER — terminal position only, matching the prompt's
 * "end the reply with it" contract, so a reply whose CONTENT happens to
 * contain "[-1]" (an array literal, a temperature) never minimizes the
 * room. The marker itself is stripped wherever it appears (the shared
 * marker-strip convention), so the latch is the only observable.
 */
function createControlMarkerHoldback(
  turn: ActiveAssistantTurn,
  emit: (chunk: string) => void,
): (raw: string, opts?: { force?: boolean }) => void {
  let emitted = 0;
  return (raw, opts) => {
    if (
      opts?.force === true &&
      !turn.minimizeRequested &&
      raw.trimEnd().endsWith(MINIMIZE_ROOM_MARKER)
    ) {
      turn.minimizeRequested = true;
    }
    let safeEnd = raw.length;
    if (opts?.force !== true) {
      for (
        let i = raw.indexOf("[", emitted);
        i !== -1;
        i = raw.indexOf("[", i + 1)
      ) {
        if (isIncompleteControlMarkerTail(raw.slice(i))) {
          safeEnd = i;
          break;
        }
      }
    }
    if (safeEnd > emitted) {
      emit(stripInternalSpeechMarkers(raw.slice(emitted, safeEnd)));
      emitted = safeEnd;
    }
  };
}

// Base control prompt for every live-voice turn. When a turn starts from a
// barge-in, the interruption merge note is appended to it (see
// buildInterruptionMergeNote) so the model reconciles the interrupted request
// with the new utterance.
const LIVE_VOICE_CONTROL_PROMPT_BASE =
  "You are speaking in a local live voice session. Keep replies brief and conversational. You cannot display cards, forms, or any on-screen UI during the call — convey everything in speech. ";

// MINIMIZE_ROOM_MARKER teaching, appended for the legs that can actually put
// something on screen — the main leg and the escalated leg. The front-door
// (fast) leg never receives it: that leg is toolless, so it has nothing to
// show, and its decision rule promises that apart from a leading verdict
// token every character is spoken verbatim — teaching it the marker would
// contradict that rule and could only produce spurious minimizes.
//
// The teaching deliberately keeps the no-interactive-UI rule intact
// (live-voice turns are non-interactive, JARVIS-1291): the marker does not
// render UI — it asks the client to reveal the screen the call overlay
// covers. The gate in createControlMarkerHoldback strips it from speech, and
// completeTtsForTurn sends the minimize_room frame only after the reply's
// TTS drains, so "end your reply with it" is the whole contract the model
// needs.
//
// The narration guidance is load-bearing: without it, the base prompt's
// convey-everything-in-speech rule reads to the model as "the user can never
// see the screen", and it minimizes the room while telling the user it has
// no way to show them anything ("check it from the app later").
const LIVE_VOICE_MINIMIZE_MARKER_TEACHING =
  "The call renders as a full-screen overlay covering the app. If this reply created or changed something on screen worth looking at (an app, a page, a document), you may end the reply with the marker [-1]: after you finish speaking, the overlay minimizes so the user can see the screen while the call continues. The user is in the app and sees what you made the moment the overlay minimizes, so when you end with the marker, speak as if you are showing it to them right now (for example, close with something like: take a look) — never say you cannot show it, that you cannot display it because this is a voice call, or that they should check it later. Use it at most once per reply, only when there is genuinely something new to show, never speak the marker aloud or mention it, and never emit any other bracketed marker. ";

// System-level guidance appended to a barge-in turn's control prompt so the
// model treats the new utterance as a continuation of the request it was cut
// off answering, rather than a fresh follow-up. Reaches the model only; it is
// not a user message and never renders as a transcript bubble.
function buildInterruptionMergeNote(interruptedRequest: string): string {
  return `The user interrupted your previous, unfinished reply. Their earlier request was: "${interruptedRequest}". Treat their current message as a continuation of that request and address both together, or stay silent if they only want you to stop.`;
}

// System-level guidance appended to the NEXT turn's control prompt after a
// background continuation finished the reply the user interrupted. Folds the
// completed answer in as context so the model can deliver or reference it in
// its reply to whatever the user just said — this turn answers the user, so the
// result is offered only if it fits. Reaches the model only; it is not a user
// message and never renders as a transcript bubble.
function buildResurfaceContextNote(continuationResult: string): string {
  return `Earlier the user interrupted you, and in the background you finished the reply they cut off. What you worked out was: "${continuationResult}". If their current message relates to it, use it to answer; otherwise you may briefly offer it or leave it aside, and do not repeat it verbatim if it no longer fits.`;
}

// Appended to the turn that follows a barge-in whose interrupted work was
// handed to a background subagent. Without this the assistant simply stops
// talking about the request it was mid-way through, and the user has no way to
// know the work survived — it reads as dropped. The model decides whether to
// mention it, because only it can tell "keep working on that" (the foreground
// turn continues the same work, so announcing a background copy would be
// confusing) from a genuine topic change (where "I'm still working on that in
// the background" is exactly what the user needs to hear).
function buildHandoffAnnouncementNote(handedOffRequest: string): string {
  return `You handed your unfinished work on "${handedOffRequest}" to a background task, which is still running. If the user has moved to a different topic, briefly let them know you are still working on it in the background before answering them. If they are asking you to continue that same work, just continue and do not mention the background task.`;
}

// Names the interrupted request inside a delivery prompt. A barge-in can fire
// before any transcript landed, so the request may be empty.
function describeInterruptedRequest(request: string): string {
  return request.length > 0
    ? `their earlier request ("${request}")`
    : "their earlier request";
}

// A finished background continuation waiting to be delivered: the request it
// took over and the answer it produced.
interface ContinuationDelivery {
  request: string;
  answer: string;
}

// Appended to an announcement turn's control prompt: the turn the session
// starts on its own when a background continuation finishes while the call is
// live and nobody is speaking. There is no user utterance behind it, so this
// note is the whole instruction and the answer rides here rather than in the
// turn's `content`. Reaches the model only; it is not a user message and never
// renders as a transcript bubble.
function buildLiveDeliveryNote(request: string, answer: string): string {
  const what = describeInterruptedRequest(request);
  return `The user interrupted you earlier, and in the background you finished ${what}. The call is still live and nobody is speaking, so tell them briefly that it is done and give them the result. Do not re-run any tool calls; the work is already complete, and do not repeat it verbatim if it no longer fits. What you produced was:\n\n${answer}`;
}

// Assemble a leg's model-facing control prompt: the base live-voice rules,
// the [-1] minimize teaching (withheld from the front-door leg — see
// LIVE_VOICE_MINIMIZE_MARKER_TEACHING), the shared no-setup-flows rule, plus
// any pending barge-in merge context, completed-continuation context, and/or
// the announcement instruction. A turn can carry several (a barge-in follow-up
// that also has a continuation result waiting); the notes are model-only and
// never render as user bubbles.
function buildVoiceControlPrompt(
  turn: ActiveAssistantTurn,
  leg: { frontDoor?: boolean },
): string {
  let prompt =
    LIVE_VOICE_CONTROL_PROMPT_BASE +
    (leg.frontDoor === true ? "" : LIVE_VOICE_MINIMIZE_MARKER_TEACHING) +
    VOICE_NO_SETUP_FLOWS_RULE;
  if (turn.interruptedRequest) {
    prompt = `${prompt}\n\n${buildInterruptionMergeNote(turn.interruptedRequest)}`;
  }
  if (turn.continuationResult) {
    prompt = `${prompt}\n\n${buildResurfaceContextNote(turn.continuationResult)}`;
  }
  if (turn.handedOffRequest) {
    prompt = `${prompt}\n\n${buildHandoffAnnouncementNote(turn.handedOffRequest)}`;
  }
  if (turn.continuationDelivery) {
    prompt = `${prompt}\n\n${buildLiveDeliveryNote(
      turn.continuationDelivery.request,
      turn.continuationDelivery.answer,
    )}`;
  }
  return prompt;
}

// Delivered into the conversation when a continuation finishes AFTER the voice
// session ended. There is no next voice turn to fold into, so this lands as a
// normal turn in the thread — where the user actually goes looking for the
// work. Framed as a system-style report rather than a user request so the
// reply reads as "here is what I finished", not a fresh instruction.
function buildClosedSessionDeliveryPrompt(
  interruptedRequest: string,
  answer: string,
): string {
  const what = describeInterruptedRequest(interruptedRequest);
  return `[Background work finished] The voice call ended before the completed result for ${what} could be delivered. Tell the user briefly that it is done and give them the result. Do not re-run any tool calls; the work is already complete. What you produced was:\n\n${answer}`;
}

// A fresh cycle: nothing captured, nothing released, no metrics turn open.
function createUtteranceCycle(): UtteranceCycle {
  return {
    phase: "pending",
    released: false,
    assistantTurnStarted: false,
    completed: false,
    finalizeRequested: false,
    transcriber: null,
    manualAudioCaptured: false,
    pendingAudioChunks: [],
    pendingAudioBytes: 0,
    finalTranscriptSegments: [],
    latestPartialText: null,
    endpointExtensionCount: 0,
    heldSpeculativeContent: null,
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
}

// Carrier cycle for an assistant-initiated turn: the turn machinery is
// utterance-shaped (metrics marks, audio archival, turn ids all hang off a
// cycle), but an announcement has no capture behind it. The record starts fully
// released with an empty transcript so nothing routes audio into it, and it is
// never installed as `currentUtterance` — that field belongs to the VAD cycle.
function createSyntheticUtterance(): UtteranceCycle {
  return {
    ...createUtteranceCycle(),
    phase: "transcriber_closed",
    released: true,
  };
}

// Objective handed to the background subagent that continues a barged-in turn.
// The subagent forks the live conversation, so it already sees the interrupted
// turn's completed tool calls in history and resumes from there. The request
// text is embedded so the continuation still knows what to finish even in the
// pre-persist window where the interrupted user message has not yet landed in
// the forked history.
function buildDuplexContinuationObjective(interruptedRequest: string): string {
  const base =
    "You were in the middle of responding to the user's most recent request when they interrupted you. Finish that response now. Do not repeat any tool calls whose results are already present in the conversation. You are running unattended in the background: permission policy may auto-deny higher-risk actions with no one to approve them. If an action you need is denied, do not retry it; finish what you can and say plainly what remains, so the user can trigger it on their next turn.";
  return interruptedRequest.length > 0
    ? `${base} Their request was: "${interruptedRequest}".`
    : base;
}

// Built-ins beyond the strict read-only allowlist that cannot contend with a
// background continuation's writes, whatever their input: they touch no
// workspace, host, or extension state. `web_fetch` sits on the core
// SIDE_EFFECT_TOOLS list because an UNATTENDED run firing off external requests
// is a permission concern — a different question from this gate's, which is
// only "can these two writers corrupt the same local state?". A network read
// cannot, so it does not contend.
//
// `skill_load` is exempt per-invocation rather than by name. Re-entering an
// already-installed static skill is the first call of nearly every barge-in
// follow-up, and killing the continuation there would defeat the feature at the
// moment it matters most — but a load that auto-installs a missing skill or
// renders an inline command expansion writes local state and executes shell, so
// it contends like anything else.
const FOREGROUND_NON_CONTENDING_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
]);

// Foreground-wins classification: does this foreground tool start force the
// running continuations to be aborted? The question is LOCAL-STATE
// CONTENTION ("could these two writers corrupt the same workspace, host, or
// extension state?"), NOT permission — this gate never affects what a tool is
// allowed to do. Fail closed anyway: anything that is not a provably
// non-contending BUILT-IN contends, because skill/plugin/MCP/workspace tools
// carry no "writes local state" metadata and some of them (app_*, document_*)
// very much do. `skill_execute` always contends: it is a dispatcher whose
// resolved inner tool can mutate.
function foregroundToolContendsWithContinuation(
  toolName: string,
  input?: Record<string, unknown>,
): boolean {
  if (toolName === "skill_execute") {
    return true;
  }
  const ownerKind = getToolOwner(toolName)?.kind;
  if (ownerKind === "default") {
    if (FOREGROUND_NON_CONTENDING_TOOLS.has(toolName)) {
      return false;
    }
    // Last, and behind the name checks above: `isInstalledStaticSkillLoad`
    // re-reads the skill catalog from disk, so only a `skill_load` pays for it.
    // Absent input fails closed — an unknown target could be an auto-install.
    if (toolName === "skill_load") {
      return (
        input === undefined || !isInstalledStaticSkillLoad(toolName, input)
      );
    }
  }
  return isRefusedInReadOnlyPass(toolName, ownerKind);
}

// Upper bound on how long a barge-in waits for the interrupted turn's teardown
// to settle before giving up on the continuation. The teardown settles once the
// aborted turn's agent loop reaches its `finally`, which can wait out BOTH the
// abort-unwind watchdog and the turn-boundary commit — so bound the wait by the
// same budget the bridge uses to wait for a prior turn's teardown
// (resolveProcessingWaitMs). That lets a legitimately slow abort+commit still
// fork, while a genuinely wedged teardown times out — and on timeout the fork is
// SKIPPED (not run against stale history); see detachInterruptedTurn.
function defaultDetachTeardownSettleTimeoutMs(): number {
  return resolveProcessingWaitMs(
    getConfig().workspaceGit?.turnCommitMaxWaitMs ?? 4000,
    ABORT_WATCHDOG_MS,
  );
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly resolveCredentialReadiness: LiveVoiceCredentialReadinessResolver | null;
  private readonly startVoiceTurn: LiveVoiceTurnStarter | null;
  private readonly streamTtsAudio: LiveVoiceTtsStreamer | null;
  private readonly archiveAudio: LiveVoiceSessionAudioArchiver | null;
  private readonly spawnBackgroundContinuation: LiveVoiceBackgroundContinuationSpawner | null;
  // Reads the interrupted turn's teardown promise so the barge-in path can wait
  // for it to settle before forking the continuation.
  private readonly getTurnTeardown:
    | ((conversationId: string) => Promise<void> | undefined)
    | null;
  private readonly detachTeardownSettleTimeoutMs: number;
  private readonly continuationAnnounceSilenceMs: number;
  // Abort handles for background continuations started when a barge-in detached
  // an interrupted turn. Each controller is registered synchronously before
  // its spawn, so interrupt()/close() abort a continuation even if a stop lands
  // while it is still spawning.
  private readonly detachControllers = new Set<AbortController>();
  // Bumped whenever detached runs are invalidated: a stop (interrupt/close),
  // a newer barge-in superseding them, or a foreground-wins abort. A barge-in
  // captures this (after its own bump) before its async teardown; if it has
  // changed by the time the detach would spawn, an invalidation landed during
  // the gap and the continuation is not started.
  private detachStopGeneration = 0;
  // Bumped SYNCHRONOUSLY at each barge-in (in barge order), before the async
  // detach runs. Only the latest-started detach (detachSeq === detachSequence)
  // may populate the pending result, so once a newer barge-in starts, an older
  // continuation completing (before OR after it) can't surface a stale answer.
  private detachSequence = 0;
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
  // Mutable so a mid-session `update_config` frame can retune "interrupt
  // sensitivity" live (see applyConfigUpdate).
  private bargeInMinSpeechMs: number;
  // Sustained-speech barge-in guard, armed at speech onset while the
  // assistant turn is audibly speaking: above-gate speech-chunk duration
  // accumulates until it reaches bargeInMinSpeechMs, then the deferred
  // speech_started + barge-in fire (at most once per onset). Brief sub-threshold
  // gaps are tolerated (see BARGE_IN_GAP_TOLERANCE_MS); the run resets on a
  // single longer continuous silence, or once cumulative tolerated silence
  // exceeds the duty-cycle ceiling (see BARGE_IN_MAX_TOLERATED_SILENCE_RATIO).
  // The detector's utterance end discards the guard.
  private pendingBargeIn: {
    // Null when guarding only the post-tts_done drain window (the turn is
    // already finalized but the client is still playing its tail).
    turn: ActiveAssistantTurn | null;
    speechMs: number;
    // Consecutive sub-threshold (non-speech) time since the last speech chunk;
    // resets speechMs once it exceeds BARGE_IN_GAP_TOLERANCE_MS.
    silenceMs: number;
    // Cumulative sub-threshold time over the whole run (not reset by speech
    // chunks); resets speechMs once it exceeds the duty-cycle ceiling so sparse
    // periodic blips cannot sum into a barge-in.
    toleratedSilenceMs: number;
  } | null = null;
  // Estimated wall-clock ms until the client finishes draining the
  // assistant audio sent so far. The server clears the turn right after
  // tts_done while the client keeps playing the buffered tail — the
  // sustained-speech guard must also cover that window or a noise blip
  // clips the reply's last words. Advanced per sent tts_audio frame from
  // the chunk's PCM duration; zeroed whenever the client flushes playback
  // (speech_started, turn_cancelled, interrupt, close).
  private assistantPlaybackTailUntilMs = 0;
  // Set when barge-in cancels an in-flight turn: the interrupted request's
  // transcript, carried into the next turn so the model merges the two.
  // Consumed (and cleared) when that turn launches; cleared if the barge-in
  // utterance is discarded, so it can never attach to a later, unrelated turn.
  private pendingInterruptedRequest: string | null = null;
  // Set when a background continuation finishes the reply a barge-in cut off:
  // its final answer, folded into the next turn the user starts as context.
  // Consumed (and cleared) when that turn launches; cleared on a hard stop
  // (abortDetachedRuns) so a stale result never surfaces later, and cleared by
  // an announcement that delivers the same answer itself — an announcement the
  // user cuts short hands it straight back.
  private pendingContinuationResult: string | null = null;
  // The same finished continuation, queued for an announcement turn: the
  // session speaks the result on its own once the call has been quiet for
  // `continuationAnnounceSilenceMs`. This and `pendingContinuationResult` are
  // armed together and are two routes for ONE answer — whichever fires first
  // clears the other, so the user hears it exactly once. An announcement whose
  // turn fails to start, or whose turn a barge-in cuts short, hands the answer
  // back to the stash, so a lost delivery costs the announcement, not the
  // answer.
  private pendingAnnouncement: ContinuationDelivery | null = null;
  private announcementTimer: ReturnType<typeof setTimeout> | null = null;
  // Set when a continuation actually spawns: the request it took over, so the
  // NEXT turn can tell the user the work is still running. Consumed by that
  // turn; cleared when the continuation finishes (by then the result note
  // takes over and "still running" would be stale).
  private pendingHandoffRequest: string | null = null;
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
  // Persistent mode: server-VAD sessions with a finalize-capable provider
  // keep one streaming transcriber for the whole session. Utterance release
  // flushes via finalizeUtterance() instead of tearing the stream down, and
  // re-arm reuses this instance synchronously. Null in manual mode, for
  // providers without finalizeUtterance, and after an unexpected stream
  // close (the next arm resolves a fresh transcriber).
  private sharedTranscriber: StreamingTranscriber | null = null;
  /**
   * FIFO of released cycles awaiting finalize settlement on the shared
   * stream, oldest first. Flush finals and `finalized` signals carry no
   * request identity, so at most one `Finalize` request is in flight at a
   * time (the head's, marked `finalizeRequested` — see pumpFinalizeQueue):
   * the head owns the next flush/`finalized`. The transcriber drops a
   * fallback-settled request's stale flush until the next `Finalize` goes
   * out; one landing after that surfaces as the new head's flush, bounded
   * by the dispatched-turn drop-guard in the `final` handler.
   */
  private finalizeQueue: UtteranceCycle[] = [];
  private finalizeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The cycle whose grace timer is armed (only the newest release has one). */
  private finalizeGraceCycle: UtteranceCycle | null = null;
  private readonly finalizeGraceMs: number;
  // Rotates through the progress fallback phrases across the session's turns.
  private progressPhraseCounter = 0;
  // Front-model service: phrases spoken acks and progress narration; null
  // disables both (the turn then holds the floor with silence).
  private readonly frontDecider: VoiceFrontDecider | null;
  // Complete front-model tunables: the constructor schema-parses the partial
  // option once, so every field carries its `liveVoice.frontModel` schema
  // default when unset.
  private readonly frontModelConfig: LiveVoiceFrontModelConfig;
  // Effective trailing-silence threshold, mirroring the detector's private
  // copy (constructor seed + update_config), reported to the endpoint decider.
  private silenceThresholdMs: number;
  // Pending replay of a held silence turn-end. The detector cannot extend an
  // in-flight countdown (setSilenceThresholdMs applies only from the next
  // arm), so this timer IS the extension mechanism: on expiry it replays
  // handleVadUtteranceEnd("silence") iff the held utterance is still current
  // and speech has not resumed.
  private endpointExtensionTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every VAD speech onset so an endpoint decision that resolves
  // after speech resumed defers to the detector's fresh boundary instead of
  // releasing an utterance the user is still adding to.
  private vadSpeechGeneration = 0;
  // Latched by releaseFromClient just before it forces the detector's
  // turn-end. The forced boundary shares the "silence" reason with genuine
  // VAD silences (the reason is wire-visible, so it stays "silence"), but an
  // explicit client release must never be second-guessed by the semantic-
  // endpointing decider. forceEnd fires its turn-end callback synchronously,
  // so the very next handleVadUtteranceEnd consumes the latch.
  private manualReleaseForced = false;

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
    this.spawnBackgroundContinuation =
      options.spawnBackgroundContinuation ?? null;
    this.getTurnTeardown = options.getTurnTeardown ?? null;
    this.detachTeardownSettleTimeoutMs =
      options.detachTeardownSettleTimeoutMs ??
      defaultDetachTeardownSettleTimeoutMs();
    this.continuationAnnounceSilenceMs =
      options.continuationAnnounceSilenceMs ?? CONTINUATION_ANNOUNCE_SILENCE_MS;
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
    // Precedence for the two sensitivity knobs: per-session start-frame
    // override (the client's user setting) > daemon `liveVoice.vad` config
    // (seeded into `options` by the factory) > in-code default.
    this.bargeInMinSpeechMs =
      context.startFrame.bargeInMinSpeechMs ??
      options.bargeInMinSpeechMs ??
      DEFAULT_BARGE_IN_MIN_SPEECH_MS;
    this.finalizeGraceMs = options.finalizeGraceMs ?? FINALIZE_GRACE_MS;
    this.frontDecider = options.frontDecider ?? null;
    this.frontModelConfig = LiveVoiceFrontModelConfigSchema.parse(
      options.frontModelConfig ?? {},
    );
    const turnDetectorConfig: TurnDetectorConfig = {
      ...(options.turnDetectorConfig ?? {}),
      ...(context.startFrame.silenceThresholdMs !== undefined
        ? { silenceThresholdMs: context.startFrame.silenceThresholdMs }
        : {}),
    };
    this.silenceThresholdMs =
      turnDetectorConfig.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
    this.turnDetector =
      context.startFrame.turnDetection === "server_vad"
        ? new MediaTurnDetector(turnDetectorConfig, {
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

    // The session may have been closed while the preflight was awaited.
    if (this.isClosed) {
      return;
    }

    // Ready goes out as soon as the preflight passes so the client's mic
    // acquisition overlaps the STT provider handshake. The session is active
    // immediately: audio arriving before the first utterance arms buffers
    // through the pending/pre-roll paths and flushes on arm. An arm failure
    // surfaces as a non-recoverable error frame instead of a start rejection.
    this.state = "active";
    void this.armUtterance().catch(() => {});
    this.metrics.markReady();
    await this.sendFrame({
      type: "ready",
      sessionId: this.context.sessionId,
      conversationId: this.conversationId,
      turnDetection: this.turnDetector ? "server_vad" : "manual",
    });
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
      case "update_config":
        this.applyConfigUpdate(frame);
        return;
    }
  }

  /**
   * Apply a mid-session `update_config` frame: retune the live turn detector's
   * pause ("pause before reply") and/or the barge-in guard ("interrupt
   * sensitivity") without reconnecting. Each field is optional and independent;
   * changes take effect from the next utterance. A no-op on manual (non-
   * server_vad) sessions, which have no turn detector.
   */
  private applyConfigUpdate(frame: LiveVoiceClientUpdateConfigFrame): void {
    if (frame.silenceThresholdMs !== undefined) {
      this.turnDetector?.setSilenceThresholdMs(frame.silenceThresholdMs);
      this.silenceThresholdMs = frame.silenceThresholdMs;
    }
    if (frame.bargeInMinSpeechMs !== undefined) {
      this.bargeInMinSpeechMs = frame.bargeInMinSpeechMs;
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
    this.clearEndpointExtensionTimer();
    // There is no longer anyone on the call to speak to, so a queued
    // announcement cannot be spoken — but the answer behind it is finished
    // work the user asked for, so it takes the same conversation route a
    // continuation finishing after this point takes. Then the queue is
    // cleared: the announcement is dead either way.
    await this.deliverPendingContinuationToConversation();
    this.clearContinuationAnnouncement();
    this.stopSessionTranscriber();
    // Detached continuations outlive the call. A deliberate `interrupt()`
    // aborts them; ending the session leaves them running. With no next voice
    // turn to fold into, a continuation that finishes after this point delivers
    // into the conversation instead (see detachInterruptedTurn).
    await this.cancelAssistantTurn("session_closed");
    if (shouldEmitSessionEndMetrics) {
      await this.emitSessionEndMetrics();
    }
    await this.drainOutboundFrames();
  }

  // Creates the next utterance record and arms a streaming transcriber for
  // it: the session-shared instance when persistent mode is active (a
  // synchronous re-arm), otherwise a freshly resolved one. Called once at
  // session start (without blocking the ready frame) and, in server_vad
  // mode, again after every finalized turn (per-utterance phase tracks the
  // cycle).
  private async beginUtterance(): Promise<UtteranceStartResult> {
    const utterance = createUtteranceCycle();
    this.currentUtterance = utterance;
    // Speech parked while the previous cycle wound down belongs to this
    // cycle: buffer it before the transcriber arms, and capture the detector
    // turn-end that already fired for it (if any) to replay below.
    this.flushVadPreRollIntoPending(utterance);
    const replayTurnEnd = this.vadPendingTurnEnd;
    this.vadPendingTurnEnd = null;

    const shared = this.sharedTranscriber;
    if (shared) {
      // Persistent re-arm: the shared stream is already open, so the cycle
      // goes straight to streaming with no resolve/start round-trip.
      utterance.transcriber = shared;
      return await this.activateUtterance(utterance, replayTurnEnd);
    }

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
      if (
        this.turnDetector &&
        typeof transcriber.finalizeUtterance === "function"
      ) {
        // Adopt persistent mode: this stream serves the whole session, so
        // its events route by cycle ownership instead of binding to this
        // one cycle.
        this.sharedTranscriber = transcriber;
        await transcriber.start((event) => {
          void this.handleSharedTranscriberEvent(transcriber, event);
        });
      } else {
        await transcriber.start((event) => {
          void this.handleTranscriberEvent(utterance, event);
        });
      }

      if (this.isUtteranceStale(utterance)) {
        this.releaseSharedTranscriber(transcriber);
        stopTranscriberBestEffort(transcriber);
        utterance.transcriber = null;
        return { status: "stale" };
      }

      return await this.activateUtterance(utterance, replayTurnEnd);
    } catch (err) {
      this.releaseSharedTranscriber(utterance.transcriber);
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

  // Transitions an armed cycle to streaming: flush buffered audio, complete
  // a release that landed while the cycle was pending, and replay a parked
  // detector boundary.
  private async activateUtterance(
    utterance: UtteranceCycle,
    replayTurnEnd: "silence" | "max-duration" | null,
  ): Promise<UtteranceStartResult> {
    utterance.phase = "streaming";
    this.state = "active";
    await this.flushPendingUtteranceAudio(utterance);
    if (utterance.released) {
      await this.stopUtteranceForRelease(utterance);
    } else if (replayTurnEnd) {
      // The parked utterance completed during the window (detector already
      // idle): replay its boundary so it turns without more speech. Parked
      // replays deliberately bypass semantic endpointing — the boundary was
      // already accepted in a previous cycle, so it is not re-judged here.
      await this.sendFrame({ type: "utterance_end", reason: replayTurnEnd });
      await this.releaseUtterance();
    }
    return { status: "started" };
  }

  private releaseSharedTranscriber(
    transcriber: StreamingTranscriber | null,
  ): void {
    if (transcriber && this.sharedTranscriber === transcriber) {
      this.sharedTranscriber = null;
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
    this.clearEndpointExtensionTimer();
    await this.sendFrame({
      type: "error",
      code:
        result.status === "unavailable"
          ? LiveVoiceProtocolErrorCode.CredentialsUnavailable
          : LiveVoiceProtocolErrorCode.InvalidField,
      message: result.message,
    });
    // The manager only observes failures thrown from start(); an arm that
    // fails after the early `ready` must release the session slot itself,
    // or the next start frame on this (or a reconnecting) socket gets
    // `busy` until the client tears the WebSocket down.
    await this.context.releaseAfterFailure?.();
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

    // The chunk belongs to an utterance the user is still holding the button
    // for, whether or not the transcriber has produced any text for it yet.
    utterance.manualAudioCaptured = true;
    this.collectUserAudio(utterance, chunk);
    if (utterance.phase === "pending") {
      // The transcriber is still arming (session start overlaps the STT
      // handshake with client mic startup); buffer until it flushes on arm.
      this.bufferPendingUtteranceAudio(utterance, chunk);
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
    this.trackBargeInGuard(hasSpeech, chunk);

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

  // VAD speech onset. Contract: speech_started tells the client to flush
  // tail playback immediately; barge-in then cancels any in-flight,
  // non-finalized turn — including a pre-TTS "thinking" turn whose reply is
  // still being generated, so a user can cut in before the assistant starts
  // talking (JARVIS-1266). Speaking over a thinking or audibly speaking turn
  // is deferred behind the same sustained-speech guard, so a cough or noise
  // blip cannot kill an unspoken reply or clip a spoken one; sustained speech
  // aborts the turn. Onset while listening keeps the instant speech_started
  // (turn-taking latency is untouched).
  private handleVadSpeechStart(): void {
    if (this.isClosed || this.state === "failed") {
      return;
    }

    this.vadSpeechStartPending = true;
    // Speech resumed: an endpoint decision still in flight is stale (the
    // generation bump defers it), and a pending hold replay is moot — the
    // utterance keeps accumulating and the detector fires a fresh turn-end.
    this.vadSpeechGeneration += 1;
    this.clearEndpointExtensionTimer();

    // Speech resumed while a speculative leg was awaiting its verdict: the
    // pause was mid-thought after all. Discard silently (no frames were ever
    // sent for it) and let the utterance keep accumulating — this is the
    // hold outcome decided by the caller's own voice instead of the model.
    const speculative = this.activeAssistantTurn;
    if (speculative?.speculativePending) {
      this.discardSpeculativeTurn(speculative, "speech_resumed");
    }

    const turn = this.activeAssistantTurn;
    // Any in-flight, non-finalized turn is interruptible, whether it is still
    // "thinking" (pre-TTS) or audibly speaking, so a user can cut in before the
    // assistant starts talking.
    const bargeableTurn = turn && !turn.finalized ? turn : null;
    // The client can still be draining audible playback after tts_done
    // (the turn is already cleared server-side) — that tail deserves the
    // same guard, or a noise blip clips the reply's last words.
    const drainingPlayback = Date.now() < this.assistantPlaybackTailUntilMs;

    if ((bargeableTurn || drainingPlayback) && this.bargeInMinSpeechMs > 0) {
      // Onset audio keeps flowing into the cycle/pre-roll while the guard
      // accumulates (trackBargeInGuard), so no speech is lost either way.
      this.pendingBargeIn = {
        turn: bargeableTurn,
        speechMs: 0,
        silenceMs: 0,
        toleratedSilenceMs: 0,
      };
      return;
    }

    this.pendingBargeIn = null;
    this.assistantPlaybackTailUntilMs = 0;
    void this.sendFrame({ type: "speech_started" });
    if (bargeableTurn) {
      this.bargeIn(bargeableTurn);
    }
  }

  // Advances the sustained-speech barge-in guard by one server-VAD chunk:
  // above-gate speech accumulates toward bargeInMinSpeechMs while brief
  // sub-threshold gaps are tolerated (a single continuous silence longer than
  // BARGE_IN_GAP_TOLERANCE_MS, or cumulative tolerated silence past the
  // duty-cycle ceiling, zeroes the run), and once met the deferred
  // speech_started + barge-in fire.
  private trackBargeInGuard(hasSpeech: boolean, chunk: Buffer): void {
    const guard = this.pendingBargeIn;
    if (!guard) {
      return;
    }
    const chunkMs = pcm16DurationMs(
      chunk.byteLength,
      this.context.startFrame.audio.sampleRate,
    );
    if (!hasSpeech) {
      guard.silenceMs += chunkMs;
      guard.toleratedSilenceMs += chunkMs;
      // Strictly greater on the per-gap check: a gap of exactly
      // BARGE_IN_GAP_TOLERANCE_MS is still tolerated. The web client batches PCM
      // into 50 ms frames, so a run of ducked frames lands on the boundary
      // exactly (e.g. four frames = 200 ms). The run also resets once its total
      // tolerated silence outweighs the speech by the duty-cycle ceiling, so
      // sparse periodic blips can never sum to the guard.
      if (
        guard.silenceMs > BARGE_IN_GAP_TOLERANCE_MS ||
        guard.toleratedSilenceMs >
          this.bargeInMinSpeechMs * BARGE_IN_MAX_TOLERATED_SILENCE_RATIO
      ) {
        guard.speechMs = 0;
        guard.silenceMs = 0;
        guard.toleratedSilenceMs = 0;
      }
      return;
    }
    guard.silenceMs = 0;
    guard.speechMs += chunkMs;
    if (guard.speechMs < this.bargeInMinSpeechMs) {
      return;
    }
    this.pendingBargeIn = null;
    this.assistantPlaybackTailUntilMs = 0;
    void this.sendFrame({ type: "speech_started" });
    const { turn } = guard;
    if (turn && turn === this.activeAssistantTurn && !turn.finalized) {
      this.bargeIn(turn);
    }
  }

  private bargeIn(turn: ActiveAssistantTurn): void {
    // Abort synchronously so no tts_audio frame can follow turn_cancelled,
    // and settle the cancelled turn's metrics so the next utterance's marks
    // do not collide with it in the collector. turn_cancelled flushes
    // client playback, so the drain estimate resets with it.
    this.assistantPlaybackTailUntilMs = 0;
    // Carry the interrupted request into the next turn so it merges with the
    // barge-in utterance rather than being answered as a fresh follow-up.
    const interruptedRequest = turn.utterance.finalTranscriptSegments
      .join(" ")
      .trim();
    this.pendingInterruptedRequest =
      interruptedRequest.length > 0 ? interruptedRequest : null;
    // A fresh interruption supersedes every earlier detached run, not just its
    // stashed result: abort still-running continuations (and skip pending
    // detaches) before this barge-in's own continuation can launch, so two
    // full-ability background writers never share the workspace. The stashed
    // result is dropped with them so the barge-in follow-up (or any later)
    // turn can't consume an older answer before this barge-in's own
    // continuation completes. This barge-in's detach snapshots the stop
    // generation AFTER this bump (below), so it is unaffected. The abort is
    // signal-level, with the same accepted residual as the foreground-wins
    // gate (see the tool_use_start handler): a tool call already executing in
    // the superseded run is not awaited. The replacement's detach still waits
    // out the interrupted TURN's teardown before forking, which bounds the
    // overlap to that one abandoned call.
    this.abortDetachedRuns({ reason: "superseded_by_new_barge_in" });
    // An announcement turn is the one interruption with nothing to continue:
    // the work is already finished, which is why detachInterruptedTurn skips it
    // as `announcement_turn`. The analog of "the interrupted work survives" is
    // therefore the stash — the answer goes back into it so the user's next real
    // turn still carries it, and the announcement (cut short, at best partly
    // spoken) is not the delivery it was supposed to be. The restore sits after
    // the abort above, which clears the stash, so nothing in this sequence
    // re-drops it. Only a barge-in restores: interrupt/close/a superseding new
    // continuation are resets the user asked for, and their answer stays gone.
    if (turn.continuationDelivery !== null) {
      this.pendingContinuationResult = turn.continuationDelivery.answer;
    }
    // Order this barge-in among concurrent detaches SYNCHRONOUSLY, in barge
    // order — the actual detach runs after an async teardown chain, and those
    // chains can interleave, so bumping there could assign sequences out of
    // order and let an older continuation re-stash. A higher sequence here
    // immediately invalidates every earlier still-running continuation.
    const detachSeq = ++this.detachSequence;
    this.clearFillerTimers(turn);
    // Tagged reason: provider catch-sites classify untagged caller aborts as
    // retryable transport failures (ERROR log + futile retry against the
    // aborted signal). This signal reaches the brain leg and any in-flight
    // ack generation.
    turn.abortController.abort(
      createAbortReason("voice_session_aborted", "live-voice-barge-in"),
    );
    this.metrics.markBargeIn(turn.turnId);
    // Capture the interrupted turn's teardown promise synchronously, before the
    // barge-in utterance's own startVoiceTurn overwrites the bridge's
    // per-conversation entry (that utterance is not transcribed yet, so its turn
    // has not started — this read is race-free). The detach awaits it so the
    // fork snapshots history only after this turn's completed tool calls have
    // settled in (see detachInterruptedTurn).
    const teardownWait = this.getTurnTeardown?.(this.conversationId);
    // Snapshot the stop generation before the async teardown: a stop that lands
    // during it must cancel the pending detach (checked in detachInterruptedTurn).
    const stopGeneration = this.detachStopGeneration;
    log.debug(
      {
        turnId: turn.turnId,
        detachSeq,
        // The two facts that decide whether a continuation is even eligible.
        assistantCompleted: turn.assistantCompleted,
        hasTeardownWait: teardownWait !== undefined,
      },
      "Voice barge-in cancelled a turn",
    );
    void (async () => {
      await this.finishMetricsTurn(
        turn.utterance,
        "cancelled",
        "barge_in",
        turn.turnId,
      );
      await this.sendFrame({ type: "turn_cancelled", turnId: turn.turnId });
      await this.cancelAssistantTurn("barge_in");
      // Keep the interrupted turn's work alive on a background subagent; the
      // detach waits for its teardown to settle the partial into history before
      // forking.
      this.detachInterruptedTurn(turn, stopGeneration, teardownWait, detachSeq);
    })().catch(() => {});
  }

  // Keep a barged-in turn's work alive by continuing it on a background
  // subagent instead of discarding it.
  // Waits for the interrupted turn's bridge teardown (captured at barge-in) to
  // settle before forking, so its partial — including any completed tool calls —
  // is already in the conversation the subagent forks from and a side-effecting
  // continuation cannot repeat a call the interrupted turn already ran.
  // The continuation runs with full subagent abilities under the standard
  // non-interactive permission policy; if a foreground turn starts its own
  // side-effecting tool, the foreground-wins abort in the tool_use_start
  // handler kills the continuation before the two can race on the workspace.
  // The run itself makes no sound; its result reaches the user through the next
  // turn they start, an announcement into audible silence, or the conversation
  // once the call ends. A later stop/interrupt aborts it.
  private detachInterruptedTurn(
    turn: ActiveAssistantTurn,
    stopGeneration: number,
    teardownWait: Promise<void> | undefined,
    detachSeq: number,
  ): void {
    const spawn = this.spawnBackgroundContinuation;
    // Every skip is logged with its reason — the handoff is silent by design,
    // so without this a dropped continuation is indistinguishable from a
    // never-attempted one (tail with: grep -i "voice duplex").
    if (!spawn) {
      log.debug(
        { turnId: turn.turnId, skipReason: "no_spawner" },
        "Voice duplex continuation skipped",
      );
      return;
    }
    const skipReason = this.isClosed
      ? "session_closed"
      : // Barging in over an announcement means the user is answering it, not
        // asking for it to be finished in the background — there is no pending
        // request behind an announcement turn to continue. Its answer is
        // already finished, so bargeIn returns it to the stash instead.
        turn.continuationDelivery !== null
        ? "announcement_turn"
        : // The model already finished generating (barge-in during TTS playback
          // of a complete reply): there is nothing to continue, so a
          // continuation would just re-do a finished answer.
          turn.assistantCompleted
          ? "assistant_already_completed"
          : // A stop (interrupt/close) or a superseding invalidation landed
            // during the barge-in teardown: honor it.
            this.detachStopGeneration !== stopGeneration
            ? "invalidated_during_barge_teardown"
            : null;
    if (skipReason !== null) {
      log.info(
        { turnId: turn.turnId, skipReason },
        "Voice duplex continuation skipped",
      );
      return;
    }
    // Embed the interrupted request in the objective so the continuation knows
    // what to finish even if the forked history predates the user message being
    // persisted (barge-in can fire while the turn is still acquiring the lock).
    const interruptedRequest = turn.utterance.finalTranscriptSegments
      .join(" ")
      .trim();
    // Register the abort handle synchronously so a stop that lands while the
    // continuation is still spawning still aborts it (abortDetachedRuns fires
    // controller.abort(), which the spawn's signal wiring honors).
    const controller = new AbortController();
    this.detachControllers.add(controller);
    const detachStartedAtMs = Date.now();
    void (async () => {
      try {
        // Wait for the interrupted turn's teardown to settle its partial into
        // conversation history before the fork snapshots it. This is
        // turn-scoped — it waits for THIS turn only (captured at barge-in), not
        // the conversation's overall idle state, so the interrupting turn's own
        // work still proceeds in parallel (conversation.waitForIdle would block
        // on it and defeat the background handoff).
        if (teardownWait) {
          let settled = false;
          try {
            settled = await waitForPriorTurnTeardown(
              teardownWait,
              this.detachTeardownSettleTimeoutMs,
              controller.signal,
            );
          } catch {
            // Aborted mid-wait (stop/interrupt); handled by the skip below.
          }
          // Fork only once the teardown has settled. On timeout (false) or
          // abort (throw) we cannot guarantee the fork would see the interrupted
          // turn's completed tool calls, so skip the continuation rather than
          // snapshot stale history and risk repeating a side effect — the bridge
          // refuses the next turn on an unsettled teardown for the same reason.
          // The continuation is best-effort, so a rare dropped one is the safe
          // trade.
          if (!settled) {
            log.info(
              {
                turnId: turn.turnId,
                skipReason: controller.signal.aborted
                  ? "invalidated_during_teardown_wait"
                  : "teardown_settle_timeout",
                waitedMs: Date.now() - detachStartedAtMs,
                timeoutMs: this.detachTeardownSettleTimeoutMs,
              },
              "Voice duplex continuation skipped",
            );
            return;
          }
        }
        // A closed session is NOT a reason to skip: the work outlives the
        // call, and its result is delivered into the conversation below.
        // Only an explicit invalidation (stop/interrupt/supersede) stops it.
        if (controller.signal.aborted) {
          log.info(
            {
              turnId: turn.turnId,
              skipReason: "invalidated_before_spawn",
              waitedMs: Date.now() - detachStartedAtMs,
            },
            "Voice duplex continuation skipped",
          );
          return;
        }
        log.debug(
          {
            turnId: turn.turnId,
            teardownWaitMs: Date.now() - detachStartedAtMs,
            interruptedRequest,
          },
          "Voice duplex continuation starting",
        );
        // The next turn tells the user this is still running. Set before the
        // await so a follow-up turn launching during the run picks it up.
        this.pendingHandoffRequest =
          interruptedRequest.length > 0 ? interruptedRequest : null;
        const resultText = await spawn({
          parentConversationId: this.conversationId,
          objective: buildDuplexContinuationObjective(interruptedRequest),
          label: `voice-continue-${turn.turnId}`,
          signal: controller.signal,
        });
        // Route the completed continuation's answer. Re-check the stop guards
        // after the await: an interrupt/close during the run must suppress it.
        // Only the latest-started detach may populate the result, so once a
        // newer barge-in has started, an older continuation completing (before
        // or after it, empty or not) can't surface a stale answer. Only
        // non-empty text is actually surfaced.
        this.pendingHandoffRequest = null;
        const answer = resultText.trim();
        const notInvalidated =
          !controller.signal.aborted &&
          this.detachStopGeneration === stopGeneration &&
          detachSeq === this.detachSequence;
        // Two destinations, decided by whether a next voice turn still exists.
        // Live session: stash for the next turn the user starts, AND queue an
        // announcement that speaks it into audible silence if the user says
        // nothing — the two are routes for one answer and cancel each other,
        // so it is delivered exactly once. Session closed: there is no next
        // turn and nobody to speak to, so deliver into the conversation — the
        // thread is exactly where the user goes looking for the work.
        const deliverToConversation =
          notInvalidated && this.isClosed && answer.length > 0;
        if (notInvalidated && !this.isClosed) {
          this.pendingContinuationResult = answer.length > 0 ? answer : null;
          if (answer.length > 0) {
            this.pendingAnnouncement = { request: interruptedRequest, answer };
            this.scheduleContinuationAnnouncement();
          }
        }
        if (deliverToConversation) {
          const { injectMessageIntoParent } =
            await import("../subagent/notify.js");
          injectMessageIntoParent(
            this.conversationId,
            buildClosedSessionDeliveryPrompt(interruptedRequest, answer),
          );
        }
        log.info(
          {
            turnId: turn.turnId,
            ranMs: Date.now() - detachStartedAtMs,
            resultChars: answer.length,
            // Where the answer went. "stashed" = queued for the next voice
            // turn and for an announcement into silence, whichever comes first
            // (the announcement logs "announced" when it wins);
            // "conversation" = the call had ended, so it was delivered into the
            // thread; "dropped" = a stop/interrupt or a newer barge-in landed
            // while it ran.
            resultDestination: !notInvalidated
              ? "dropped"
              : answer.length === 0
                ? "empty"
                : this.isClosed
                  ? "conversation"
                  : "stashed",
          },
          "Voice duplex continuation finished",
        );
      } catch (err) {
        // A stop/interrupt aborts via the signal; that rejection is expected.
        if (controller.signal.aborted) {
          log.debug(
            { turnId: turn.turnId, ranMs: Date.now() - detachStartedAtMs },
            "Voice duplex continuation aborted mid-run",
          );
        } else {
          log.warn(
            { err, turnId: turn.turnId, ranMs: Date.now() - detachStartedAtMs },
            "Voice duplex handoff continuation failed",
          );
        }
      } finally {
        this.detachControllers.delete(controller);
      }
    })();
  }

  // Abort every background continuation this session started and drop its
  // handle. Called on a hard stop (client interrupt / session close), when a
  // newer barge-in supersedes the detached runs, and on a foreground-wins
  // abort; the continuation's own `.finally` removes it from the set too.
  // `keepPendingResult` is the foreground-wins variant: the foreground turn is
  // claiming the workspace, so running continuations must die (and pending
  // detaches must be skipped), but an already-completed continuation's stashed
  // answer stays — it cannot race anything, and the next turn's "use only if
  // relevant" framing makes a stale one harmless.
  private abortDetachedRuns(opts?: {
    keepPendingResult?: boolean;
    // Why the runs are being invalidated, for the log line below. Every
    // caller passes one: an unexplained dead continuation is the single
    // hardest thing to debug about this feature.
    reason?: string;
    // The foreground tool whose start tripped the contention gate, if any.
    toolName?: string;
  }): void {
    const aborted = this.detachControllers.size;
    const hadPendingResult = this.pendingContinuationResult !== null;
    if (aborted > 0 || hadPendingResult) {
      log.debug(
        {
          conversationId: this.conversationId,
          reason: opts?.reason ?? "unspecified",
          ...(opts?.toolName ? { toolName: opts.toolName } : {}),
          abortedRuns: aborted,
          droppedPendingResult: hadPendingResult && !opts?.keepPendingResult,
        },
        "Voice duplex continuations invalidated",
      );
    }
    // Bump the generation so a barge-in whose async teardown is still in flight
    // (its detach not yet spawned) sees the stop and skips the continuation.
    this.detachStopGeneration += 1;
    for (const controller of this.detachControllers) {
      controller.abort();
    }
    this.detachControllers.clear();
    // A hard stop also drops any completed continuation's result still waiting
    // to fold into the next turn, so it can't surface after the user reset.
    if (!opts?.keepPendingResult) {
      this.pendingContinuationResult = null;
    }
    // The announcement dies either way: even the foreground-wins variant (which
    // keeps the stash) has a foreground turn claiming the floor, so speaking up
    // on our own is exactly what must not happen.
    this.clearContinuationAnnouncement();
  }

  private clearContinuationAnnouncement(): void {
    this.pendingAnnouncement = null;
    if (this.announcementTimer) {
      clearTimeout(this.announcementTimer);
      this.announcementTimer = null;
    }
  }

  /**
   * Hang-up delivery for a continuation that already finished: the call is
   * ending, so neither route that was armed for its answer can still run — the
   * announcement has nobody to speak to and the stash has no next voice turn to
   * fold into. Deliver it into the conversation instead, exactly as a
   * continuation finishing after the close does, because that thread is where
   * the user goes looking for the work ("barge in, hear the answer, close the
   * room, go look for the result").
   *
   * Best-effort and consume-once: the fields are emptied whether or not the
   * injection lands, so a close cannot deliver twice.
   */
  private async deliverPendingContinuationToConversation(): Promise<void> {
    const activeTurn = this.activeAssistantTurn;
    const activeAnnouncement = activeTurn?.continuationDelivery ?? null;
    const announcement = this.pendingAnnouncement ?? activeAnnouncement;
    const answer = announcement?.answer ?? this.pendingContinuationResult;
    const request = announcement?.request ?? "";
    this.pendingAnnouncement = null;
    this.pendingContinuationResult = null;
    if (activeTurn !== null) {
      activeTurn.continuationDelivery = null;
    }
    if (answer === null || answer.length === 0) {
      return;
    }
    try {
      const { injectMessageIntoParent } = await import("../subagent/notify.js");
      injectMessageIntoParent(
        this.conversationId,
        buildClosedSessionDeliveryPrompt(request, answer),
      );
      log.info(
        {
          conversationId: this.conversationId,
          resultChars: answer.length,
          resultDestination: "conversation",
        },
        "Voice duplex continuation delivered on session close",
      );
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "Voice duplex continuation delivery on session close failed",
      );
    }
  }

  /**
   * Live-voice is non-interactive (JARVIS-1291) and the session never starts a
   * turn on its own — with one narrow exception, this: a background
   * continuation the user asked for has finished, the call is still live, and
   * nobody is speaking. Arms the silence timer that decides whether that
   * exception applies. Re-arming resets the wait, so a run of arms collapses
   * into one announcement.
   *
   * The silence the timer waits out starts when the audio the client already
   * has queued runs out, so a continuation finishing at the tail end of a long
   * spoken reply waits for that reply to actually finish playing.
   *
   * `retry` marks the single re-arm a user-speech blocker gets. An active
   * assistant turn keeps the announcement queued without polling; releasing
   * the turn re-arms the timer against the actual playback tail.
   */
  private scheduleContinuationAnnouncement(
    retry = false,
    drainRearms = 0,
  ): void {
    if (this.announcementTimer) {
      clearTimeout(this.announcementTimer);
    }
    // Queued client-side audio is the previous reply still being audible, so
    // the silence window only begins once it has drained.
    const drainMs = Math.max(0, this.assistantPlaybackTailUntilMs - Date.now());
    this.announcementTimer = setTimeout(() => {
      this.announcementTimer = null;
      const blockedBy = this.continuationAnnouncementBlocker();
      if (blockedBy === null) {
        void this.announceContinuation().catch((err: unknown) => {
          log.warn({ err }, "Voice duplex continuation announcement failed");
        });
        return;
      }
      log.debug(
        { conversationId: this.conversationId, blockedBy, retry, drainRearms },
        "Voice duplex continuation announcement deferred",
      );
      // A tail that grew while the timer ran (the reply was still streaming
      // TTS when it was armed) is a wait of known length rather than a busy
      // call, so it re-arms against the new deadline without spending the
      // single retry the busy-call blockers get — otherwise a long reply's
      // playback alone outlasts the budget and the announcement is dropped
      // even though the call goes idle right after. The tail only extends
      // while a turn is active, which blocks earlier, so the re-arms converge;
      // the cap bounds the interleaving where a fresh turn's audio lands
      // between two checks.
      if (
        blockedBy === "playback_draining" &&
        drainRearms < CONTINUATION_ANNOUNCE_MAX_DRAIN_REARMS
      ) {
        this.scheduleContinuationAnnouncement(retry, drainRearms + 1);
        return;
      }
      if (blockedBy === "turn_active") {
        return;
      }
      if (retry || this.pendingAnnouncement === null) {
        this.pendingAnnouncement = null;
        return;
      }
      this.scheduleContinuationAnnouncement(true, drainRearms);
    }, drainMs + this.continuationAnnounceSilenceMs);
  }

  private clearActiveAssistantTurn(token: symbol): void {
    if (this.activeAssistantTurn?.token !== token) {
      return;
    }
    this.activeAssistantTurn = null;
    if (
      this.pendingAnnouncement !== null &&
      !this.isClosed &&
      this.state !== "failed"
    ) {
      this.scheduleContinuationAnnouncement();
    }
  }

  // Why the session must not speak up right now, or null when the call is
  // genuinely idle: live, no turn running, and no user speech anywhere in
  // flight (onset latch, barge-in guard, detector, or a cycle that has already
  // captured something). The server-VAD re-arm keeps an empty cycle armed
  // between turns, so an untouched `currentUtterance` IS the idle state.
  private continuationAnnouncementBlocker(): string | null {
    if (this.pendingAnnouncement === null) {
      return "nothing_pending";
    }
    if (this.isClosed || this.state === "failed" || !this.startVoiceTurn) {
      return "session_unavailable";
    }
    if (this.activeAssistantTurn !== null) {
      return "turn_active";
    }
    // The turn can be cleared server-side (tts_done sent) while the client is
    // still playing the audio it queued: that tail is the previous reply still
    // being audible, so announcing over it is announcing over the assistant.
    if (Date.now() < this.assistantPlaybackTailUntilMs) {
      return "playback_draining";
    }
    if (this.vadSpeechStartPending || this.pendingBargeIn !== null) {
      return "speech_onset";
    }
    if (this.turnDetector?.isActive === true) {
      return "user_speaking";
    }
    const utterance = this.currentUtterance;
    // Every transcript-derived signal here trails the STT provider, so on its
    // own it leaves manual mode blind to a user who is talking right now and
    // has no text yet — hence the captured-audio flag, which manual ingress
    // sets from the first chunk.
    if (
      utterance !== null &&
      !utterance.completed &&
      (utterance.released ||
        utterance.assistantTurnStarted ||
        utterance.manualAudioCaptured ||
        utterance.finalTranscriptSegments.length > 0 ||
        utterance.latestPartialText !== null)
    ) {
      return "utterance_in_flight";
    }
    return null;
  }

  // Speak the finished continuation's result on a turn the session starts
  // itself. The turn rides a synthetic cycle rather than the armed VAD one —
  // `currentUtterance` belongs to the capture loop, and overwriting it would
  // collide with the user's next real utterance.
  private async announceContinuation(): Promise<void> {
    const pending = this.pendingAnnouncement;
    if (!pending) {
      return;
    }
    this.pendingAnnouncement = null;
    // The two routes for one answer are mutually exclusive: while this turn is
    // in flight the stash must not deliver the same answer again. It comes back
    // only if this turn provably never started (below) or a barge-in cuts it
    // short before it delivers (see bargeIn).
    this.pendingContinuationResult = null;
    // Pins the invalidation state this hand-off was decided in: a hard stop
    // landing while the turn starts owns the drop, and must not be undone by
    // the restore below.
    const stopGeneration = this.detachStopGeneration;
    let started: boolean;
    try {
      started = await this.launchAssistantTurn(
        createSyntheticUtterance(),
        CONTINUATION_DELIVERY_CONTENT,
        { continuationDelivery: pending },
      );
    } catch (err) {
      // A throw before the leg's own error handling (an outbound frame write
      // rejecting, say) leaves the same state a false return does: nothing
      // persisted, nothing spoken, and the stash already emptied above. Take
      // the identical fallback rather than letting the answer die with the
      // rejection.
      started = false;
      log.warn(
        { err, conversationId: this.conversationId },
        "Voice duplex continuation announcement threw while starting",
      );
    }
    if (started) {
      log.info(
        {
          conversationId: this.conversationId,
          resultChars: pending.answer.length,
          resultDestination: "announced",
        },
        "Voice duplex continuation announced",
      );
      return;
    }
    // The turn never reached the bridge (the conversation is busy from another
    // surface, or the bridge threw), so nothing was persisted or spoken. Hand
    // the answer back to the stash — the user's next turn is the fallback route
    // that exists for exactly this. A newer continuation's answer already in
    // the stash wins over this older one rather than being overwritten.
    const restashed =
      !this.isClosed &&
      this.detachStopGeneration === stopGeneration &&
      this.pendingContinuationResult === null;
    if (restashed) {
      this.pendingContinuationResult = pending.answer;
    }
    log.warn(
      {
        conversationId: this.conversationId,
        resultChars: pending.answer.length,
        resultDestination: restashed ? "stashed" : "dropped",
      },
      "Voice duplex continuation announcement could not start",
    );
  }

  // VAD closed the utterance — the analog of ptt_release: emit
  // utterance_end, then run the standard release path.
  private handleVadUtteranceEnd(reason: "silence" | "max-duration"): void {
    // Consume the manual-release latch before any async hop: it belongs to
    // exactly this boundary (forceEnd fired this callback synchronously), and
    // it must not leak into a later genuine silence even when the early-exit
    // guards below skip the release.
    const manualRelease = this.manualReleaseForced;
    this.manualReleaseForced = false;
    void (async () => {
      if (this.isClosed || this.state === "failed") {
        return;
      }
      this.vadSpeechStartPending = false;
      // The detector turn is over: an untripped guard was noise, not
      // barge-in — leave playback untouched.
      this.pendingBargeIn = null;
      if (reason === "max-duration") {
        // A max-duration boundary always releases: drop any pending hold
        // replay so it cannot re-fire a boundary this one already owns.
        this.clearEndpointExtensionTimer();
      }
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
      // Semantic endpointing: a silence boundary may be a thinking pause, so
      // the unified front-door leg itself is the endpoint decision. When it
      // launches, the boundary is deferred to the verdict — commit releases
      // the utterance, hold replays the boundary via the extension timer.
      // When speculation is inapplicable (no text, cap reached, a turn
      // already active) fall through and release. Only detector-timer
      // silences qualify; max-duration always releases, and a manual client
      // release (ptt_release forced the boundary) is the user saying "answer
      // now" — never second-guess it.
      if (reason === "silence" && !manualRelease) {
        if (await this.launchSpeculativeAssistantTurn(utterance)) {
          return;
        }
      }
      await this.sendFrame({ type: "utterance_end", reason });
      await this.releaseUtterance();
    })().catch(() => {});
  }

  // Arms the hold-extension replay: after `endpointExtensionMs` of continued
  // silence the deferred silence boundary re-fires (and a fresh front-door
  // leg judges it again, bounded by `endpointMaxExtensions`).
  private armEndpointExtensionTimer(utterance: UtteranceCycle): void {
    this.clearEndpointExtensionTimer();
    this.endpointExtensionTimer = setTimeout(() => {
      this.endpointExtensionTimer = null;
      if (
        this.currentUtterance !== utterance ||
        utterance.released ||
        utterance.completed ||
        // Speech resumed (the detector owns the next boundary). Onset also
        // clears this timer, so this is a belt to that suspender.
        this.turnDetector?.isActive
      ) {
        return;
      }
      this.handleVadUtteranceEnd("silence");
    }, this.frontModelConfig.endpointExtensionMs);
  }

  /**
   * Unified front-door: dispatch the assistant turn speculatively at the
   * silence boundary, judging the transcript accumulated so far — the same
   * text the endpoint decider judges today. In persistent-transcriber mode
   * finals stream continuously (utteranceEnd→finalTranscript measures ~0ms),
   * so this matches the eventual final transcript in practice; divergence is
   * logged in startAssistantTurnIfReady. Returns false when speculation is
   * inapplicable — the boundary then releases exactly as before.
   */
  private async launchSpeculativeAssistantTurn(
    utterance: UtteranceCycle,
  ): Promise<boolean> {
    if (
      utterance.endpointExtensionCount >=
        this.frontModelConfig.endpointMaxExtensions ||
      utterance.assistantTurnStarted ||
      this.activeAssistantTurn !== null ||
      !this.startVoiceTurn
    ) {
      return false;
    }
    const transcriptSoFar = utterance.finalTranscriptSegments.join(" ").trim();
    const content = [transcriptSoFar, utterance.latestPartialText ?? ""]
      .join(" ")
      .trim();
    if (content.length === 0) {
      return false;
    }
    await this.launchAssistantTurn(utterance, content, { speculative: true });
    return true;
  }

  /**
   * Commit a speculative turn: the leg's leading tokens were a real answer
   * (or the escalate verdict), so the deferred boundary work happens now —
   * utterance_end + thinking frames, utterance release (which finalizes the
   * transcriber), and the floor-holding timers. Returns false when the
   * world moved on mid-flight (speech resumed, utterance superseded): the
   * leg is discarded and the caller must swallow the delta.
   */
  private commitSpeculativeTurn(turn: ActiveAssistantTurn): boolean {
    if (!turn.speculativePending) {
      return true;
    }
    const utterance = turn.utterance;
    if (
      turn.speculativeGeneration !== this.vadSpeechGeneration ||
      this.isUtteranceStale(utterance) ||
      utterance.completed
    ) {
      this.discardSpeculativeTurn(turn, "superseded");
      return false;
    }
    // `released` alone is NOT superseded: a manual release during the
    // verdict window (releaseFromClient) means the caller explicitly asked
    // to answer now — the verdict commits into the already-released
    // utterance instead of discarding the only in-flight turn. The manual
    // path already sent utterance_end and released the utterance, so those
    // are skipped; the thinking frame and timers still apply.
    const alreadyReleased = utterance.released;
    turn.speculativePending = false;
    if (turn.verdictDeadlineTimer !== null) {
      clearTimeout(turn.verdictDeadlineTimer);
      turn.verdictDeadlineTimer = null;
    }
    if (!alreadyReleased) {
      void this.sendFrame({ type: "utterance_end", reason: "silence" });
    }
    void this.sendFrame({ type: "thinking", turnId: turn.turnId });
    if (!alreadyReleased) {
      void this.releaseUtterance();
    }
    if (this.streamTtsAudio) {
      this.armAckTimer(turn);
    }
    if (
      this.frontModelConfig.progress.enabled &&
      this.streamTtsAudio &&
      this.frontDecider
    ) {
      this.armProgressIdleTimer(turn);
    }
    return true;
  }

  /**
   * Hold verdict on a speculative turn: the model judged the pause
   * mid-thought. Discard the leg (rolling back its persisted user message)
   * and extend the listening window exactly as a decider hold does — the
   * extension timer replays the silence boundary, which re-speculates.
   */
  private async holdSpeculativeTurn(turn: ActiveAssistantTurn): Promise<void> {
    if (
      this.activeAssistantTurn?.token !== turn.token ||
      !turn.speculativePending
    ) {
      return;
    }
    const utterance = turn.utterance;
    const decisionLatencyMs = Math.max(
      0,
      Date.now() - turn.speculativeDispatchedAtMs,
    );
    this.discardSpeculativeTurn(turn, "hold_verdict");
    if (
      this.isUtteranceStale(utterance) ||
      utterance.completed ||
      turn.speculativeGeneration !== this.vadSpeechGeneration
    ) {
      // Speech resumed or the utterance moved on during the verdict: the
      // discard was the whole job; a fresh boundary owns the release.
      return;
    }
    if (utterance.released) {
      // Manual release during the verdict window: the caller explicitly
      // said they are done, so the hold is moot — but this leg's only
      // output was the hold token, so committing it would answer with
      // nothing. Discard it (done above; assistantTurnStarted is reset)
      // and start a fresh leg on the released utterance instead.
      void this.startAssistantTurnIfReady();
      return;
    }
    this.markEndpointDecision(utterance, "hold", decisionLatencyMs);
    utterance.endpointExtensionCount += 1;
    // Remember what the hold judged: a final segment arriving during the
    // extension that extends this text replays the boundary immediately
    // (see recordFinalTranscript) instead of waiting out the extension.
    utterance.heldSpeculativeContent = turn.speculativeContent;
    this.armEndpointExtensionTimer(utterance);
  }

  /**
   * Abort a speculative leg and roll back everything it touched: the
   * persisted user message (via the handle's discard), the active-turn
   * slot, the pending context it consumed, and the utterance's turn-started
   * latch, so the utterance can be re-dispatched (hold replay) or keep
   * accumulating (speech resumed). Nothing was ever user-visible — no frames
   * were sent for this turn.
   */
  private discardSpeculativeTurn(
    turn: ActiveAssistantTurn,
    reason: string,
  ): void {
    turn.speculativePending = false;
    // The dispatch is being unwound, so the barge-in merge note, the finished
    // continuation's answer, and its queued announcement all go back to the
    // session — the turn that would have delivered them is gone.
    this.restorePendingTurnContext(turn);
    // Latched before the handle check: when the discard beats the bridge
    // handle's resolution (startVoiceTurn still persisting), the handle's
    // arrival in startAssistantLeg completes the rollback via discard().
    turn.discardRequested = true;
    if (this.activeAssistantTurn?.token === turn.token) {
      this.activeAssistantTurn = null;
    }
    this.clearFillerTimers(turn);
    turn.abortController.abort(
      createAbortReason("voice_session_aborted", `live-voice-${reason}`),
    );
    const handle = turn.handle;
    turn.handle = null;
    void handle?.discard?.().catch((err: unknown) => {
      log.warn(
        { err, turnId: turn.turnId, reason },
        "Speculative voice turn discard failed",
      );
    });
    turn.utterance.assistantTurnStarted = false;
    log.info(
      { turnId: turn.turnId, reason },
      "Speculative voice turn discarded",
    );
  }

  private clearEndpointExtensionTimer(): void {
    if (this.endpointExtensionTimer !== null) {
      clearTimeout(this.endpointExtensionTimer);
      this.endpointExtensionTimer = null;
    }
  }

  // In server_vad mode a client ptt_release still works as a manual
  // override: force the detector's utterance boundary so the release runs
  // the same utterance_end path; without an open detector turn, fall back
  // to a plain release.
  private async releaseFromClient(): Promise<void> {
    if (this.turnDetector?.isActive) {
      // Latch first: the forced boundary reports "silence", and this marks
      // it as a manual release the semantic-endpointing decider must not
      // hold (see the manualReleaseForced field doc).
      this.manualReleaseForced = true;
      this.turnDetector.forceEnd();
      await this.drainOutboundFrames();
      return;
    }
    // Server VAD with no active detector turn but a still-open utterance is
    // a held pause (semantic endpointing suppressed the boundary's
    // utterance_end and the detector's turn already ended). The manual
    // release must still emit the frame — the hands-free client only leaves
    // `listening` on `utterance_end` — and drop the pending hold replay it
    // supersedes. Reason stays "silence": the manual-release convention
    // everywhere else (forceEnd) reports the same, and the client ignores
    // the value. Manual mode (no detector) emits no VAD frames — skip.
    const utterance = this.currentUtterance;
    if (
      this.turnDetector &&
      utterance &&
      !utterance.released &&
      !utterance.completed
    ) {
      this.clearEndpointExtensionTimer();
      await this.sendFrame({ type: "utterance_end", reason: "silence" });
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
    const shared = this.sharedTranscriber;
    if (shared && utterance.transcriber === shared) {
      await this.finalizeUtteranceForRelease(utterance);
      return;
    }

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

  // Persistent-mode release: flush the shared stream's buffered audio with
  // finalizeUtterance() instead of tearing the stream down. The assistant
  // turn starts on the `finalized` event; the grace timer bounds a flush
  // that never arrives.
  private async finalizeUtteranceForRelease(
    utterance: UtteranceCycle,
  ): Promise<void> {
    if (
      utterance.phase === "released" ||
      utterance.phase === "transcriber_closed"
    ) {
      return;
    }
    utterance.phase = "released";
    this.finalizeQueue.push(utterance);
    this.armFinalizeGraceTimer(utterance);
    this.pumpFinalizeQueue();
    await this.startAssistantTurnIfReady();
    await this.drainOutboundFrames();
  }

  // Sends at most one `Finalize` request at a time on the shared stream:
  // `finalized` carries no request identity, and a provider answering two
  // overlapping requests with a single flush would desync the FIFO
  // permanently. While a request is outstanding the queue waits; when the
  // head settles, cycles that dispatched (grace-sealed) before their
  // request was ever sent are dropped — no `finalized` will ever answer
  // them, and their buffered tail arrives as ordinary finals — then the
  // next awaiting cycle's request goes out.
  private pumpFinalizeQueue(): void {
    if (this.finalizeQueue.some((cycle) => cycle.finalizeRequested)) {
      return;
    }
    while (true) {
      const head = this.finalizeQueue[0];
      if (!head) {
        return;
      }
      if (head.assistantTurnStarted || head.completed) {
        this.dropFromFinalizeQueue(head);
        continue;
      }
      const shared = this.sharedTranscriber;
      if (!shared) {
        return;
      }
      head.finalizeRequested = true;
      try {
        shared.finalizeUtterance?.();
      } catch (err) {
        log.warn(
          { err },
          "Live voice utterance finalize failed; proceeding with the transcript collected so far",
        );
        this.dropFromFinalizeQueue(head);
        if (head.phase === "released") {
          head.phase = "transcriber_closed";
        }
        continue;
      }
      return;
    }
  }

  private dropFromFinalizeQueue(utterance: UtteranceCycle): void {
    this.finalizeQueue = this.finalizeQueue.filter((c) => c !== utterance);
    if (utterance === this.finalizeGraceCycle) {
      this.clearFinalizeGraceTimer();
    }
  }

  private armFinalizeGraceTimer(utterance: UtteranceCycle): void {
    this.clearFinalizeGraceTimer();
    this.finalizeGraceCycle = utterance;
    this.finalizeGraceTimer = setTimeout(() => {
      this.finalizeGraceTimer = null;
      this.finalizeGraceCycle = null;
      void this.handleFinalizeGraceTimeout(utterance).catch(() => {});
    }, this.finalizeGraceMs);
  }

  private clearFinalizeGraceTimer(): void {
    if (this.finalizeGraceTimer !== null) {
      clearTimeout(this.finalizeGraceTimer);
      this.finalizeGraceTimer = null;
    }
    this.finalizeGraceCycle = null;
  }

  // The finalize flush never arrived: proceed with the segments collected
  // so far. The cycle stays in the finalize queue so its late flush is
  // still attributed to (and dropped for) it instead of polluting a newer
  // cycle's request.
  private async handleFinalizeGraceTimeout(
    utterance: UtteranceCycle,
  ): Promise<void> {
    if (
      !this.finalizeQueue.includes(utterance) ||
      this.isClosed ||
      this.state === "failed" ||
      this.state === "interrupted"
    ) {
      return;
    }
    log.warn(
      "Live voice finalize flush timed out; starting the turn with the transcript collected so far",
    );
    utterance.phase = "transcriber_closed";
    await this.startAssistantTurnIfReady();
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
        utterance.latestPartialText = event.text;
        this.markFirstPartial(utterance);
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final":
        await this.recordFinalTranscript(utterance, event.text);
        return;
      case "finalized":
        // Per-cycle transcribers are torn down with stop(); the finalize
        // completion signal has no cycle to advance here.
        return;
      case "error":
        await this.sendTranscriberErrorFrame(event);
        return;
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

  // The cycle that should receive new (non-flush) transcript events: the
  // oldest queued finalize request whose turn has not dispatched, falling
  // back to the current cycle once every queued request has dispatched.
  private pendingTranscriptCycle(): UtteranceCycle | null {
    return (
      this.finalizeQueue.find(
        (cycle) => !cycle.assistantTurnStarted && !cycle.completed,
      ) ?? this.currentUtterance
    );
  }

  // Persistent-mode event routing. One shared stream serves many cycles, so
  // events route dynamically: the cycle awaiting its finalize flush owns
  // the audio being flushed; otherwise the current cycle does. Flush events
  // for a transcript that already dispatched its assistant turn are dropped
  // — a dispatched transcript is never mutated.
  private async handleSharedTranscriberEvent(
    transcriber: StreamingTranscriber,
    event: SttStreamServerEvent,
  ): Promise<void> {
    if (
      this.sharedTranscriber !== transcriber ||
      this.isClosed ||
      this.state === "failed" ||
      this.state === "interrupted"
    ) {
      return;
    }

    switch (event.type) {
      case "partial": {
        // Partials belong to the oldest cycle still awaiting its
        // transcript; after every queued request has dispatched, they
        // belong to the user's next utterance on the current cycle.
        const target = this.pendingTranscriptCycle();
        if (!target || target.assistantTurnStarted || target.completed) {
          return;
        }
        target.latestPartialText = event.text;
        this.markFirstPartial(target);
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      }
      case "final": {
        if (event.fromFinalize) {
          // A finalize flush commits audio buffered before its finalize
          // request. The provider answers requests in order, so the flush
          // belongs to the OLDEST outstanding request — never to a newer
          // cycle's request and never to new speech. After a grace-timeout
          // dispatch the owning transcript is sealed, so a late flush is
          // dropped rather than mutating a dispatched turn or polluting a
          // newer cycle.
          const owner = this.finalizeQueue[0];
          if (owner && !owner.assistantTurnStarted && !owner.completed) {
            await this.recordFinalTranscript(owner, event.text);
          } else {
            log.warn(
              "Dropping a late finalize flush segment: its assistant turn already dispatched",
            );
          }
          return;
        }
        // Ordinary finals: new speech for the oldest still-pending cycle,
        // or the current one once every queued request has dispatched.
        const target = this.pendingTranscriptCycle();
        if (!target || target.assistantTurnStarted || target.completed) {
          log.warn(
            "Dropping a late final transcript segment: its assistant turn already dispatched",
          );
          return;
        }
        await this.recordFinalTranscript(target, event.text);
        return;
      }
      case "finalized": {
        // Completes the head's outstanding finalize request, whether or
        // not its flush final arrived (the provider may omit an empty
        // flush; its own fallback still emits `finalized`).
        const owner = this.finalizeQueue.shift() ?? null;
        if (owner && owner === this.finalizeGraceCycle) {
          this.clearFinalizeGraceTimer();
        }
        if (owner && owner.phase === "released") {
          // In persistent mode "transcriber_closed" means the cycle's
          // transcript is complete — the shared stream stays open.
          owner.phase = "transcriber_closed";
        }
        // The request slot is free again: send the next awaiting cycle's.
        this.pumpFinalizeQueue();
        if (!owner) {
          return;
        }
        await this.startAssistantTurnIfReady();
        return;
      }
      case "error":
        await this.sendTranscriberErrorFrame(event);
        return;
      case "closed": {
        // The shared stream closed under the session: fall back to the
        // per-cycle path — the next arm resolves a fresh transcriber.
        this.sharedTranscriber = null;
        this.clearFinalizeGraceTimer();
        const drained = this.finalizeQueue;
        this.finalizeQueue = [];
        for (const finalizing of drained) {
          if (finalizing.transcriber === transcriber) {
            finalizing.transcriber = null;
          }
          if (finalizing.phase === "released") {
            finalizing.phase = "transcriber_closed";
          }
        }
        const current = this.currentUtterance;
        if (
          current &&
          !drained.includes(current) &&
          current.transcriber === transcriber
        ) {
          current.transcriber = null;
          current.phase = "transcriber_closed";
          // An unreleased cycle with nothing captured: retire it so the
          // next speech chunk lazily arms a fresh utterance.
          if (
            !current.released &&
            !current.completed &&
            current.finalTranscriptSegments.length === 0
          ) {
            await this.finalizePendingUtterance(current, "transcriber_closed");
            return;
          }
        }
        await this.startAssistantTurnIfReady();
        return;
      }
    }
  }

  private async recordFinalTranscript(
    utterance: UtteranceCycle,
    text: string,
  ): Promise<void> {
    const transcript = text.trim();
    if (transcript.length > 0) {
      utterance.finalTranscriptSegments.push(transcript);
    }
    // The final commits (and supersedes) whatever partial was trailing it.
    utterance.latestPartialText = null;
    this.markFinalTranscript(utterance);
    await this.sendFrame({ type: "stt_final", text });
    // Fresh-final fast replay (unified front-door): a hold judged on the
    // pre-finalize partial is stale the moment the finalized transcript
    // extends it — the caller already finished, so waiting out the extension
    // window only adds silence. Replay the silence boundary now. Guards
    // mirror the extension timer's own: still the current utterance, still
    // unreleased, and the detector quiet (speech resuming owns the boundary).
    if (
      this.endpointExtensionTimer !== null &&
      utterance.heldSpeculativeContent !== null &&
      this.currentUtterance === utterance &&
      !utterance.released &&
      !utterance.completed &&
      !this.turnDetector?.isActive
    ) {
      const contentNow = [
        utterance.finalTranscriptSegments.join(" ").trim(),
        utterance.latestPartialText ?? "",
      ]
        .join(" ")
        .trim();
      if (
        contentNow.length > 0 &&
        contentNow !== utterance.heldSpeculativeContent
      ) {
        this.clearEndpointExtensionTimer();
        utterance.heldSpeculativeContent = null;
        this.handleVadUtteranceEnd("silence");
        return;
      }
    }
    await this.startAssistantTurnIfReady();
  }

  // Providers emit `error` mid-stream and may keep streaming; `closed` /
  // `final` still drive turn lifecycle. Only transient categories are
  // recoverable — auth/rate-limit/invalid-audio will not self-heal, so
  // hands-free clients must surface them instead of suppressing them.
  private async sendTranscriberErrorFrame(
    event: SttStreamServerErrorEvent,
  ): Promise<void> {
    const recoverable =
      event.category === "timeout" || event.category === "provider-error";
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidField,
      message: event.message,
      ...(recoverable ? { recoverable: true } : {}),
    });
  }

  private async interrupt(): Promise<void> {
    if (this.isClosed || this.state === "failed") {
      return;
    }

    this.state = "interrupted";
    // A client interrupt also discards speech parked in the pre-roll ring.
    // The client stopped its own playback, so the drain estimate resets.
    this.assistantPlaybackTailUntilMs = 0;
    this.takeVadPreRoll();
    this.vadPendingTurnEnd = null;
    // ...and abandons any semantic-endpointing hold still awaiting replay.
    this.clearEndpointExtensionTimer();
    // A client interrupt is a hard reset: any barge-in merge context waiting for
    // the next turn is now stale (the interrupted utterance may be discarded
    // without ever reaching finalizePendingUtterance).
    this.pendingInterruptedRequest = null;
    // ...and it hard-stops any detached background continuations.
    this.abortDetachedRuns({ reason: "client_interrupt" });
    const utterance = this.currentUtterance;
    this.stopSessionTranscriber();
    if (utterance) {
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

  // Stops whichever streaming transcriber the session holds (shared or
  // per-cycle) and clears the finalize bookkeeping. Used by interrupt() and
  // close(); persistent mode re-establishes itself on the next arm.
  private stopSessionTranscriber(): void {
    this.clearFinalizeGraceTimer();
    this.finalizeQueue = [];
    const shared = this.sharedTranscriber;
    this.sharedTranscriber = null;
    const utterance = this.currentUtterance;
    const transcriber = utterance?.transcriber ?? null;
    if (utterance) {
      utterance.transcriber = null;
    }
    stopTranscriberBestEffort(transcriber);
    if (shared && shared !== transcriber) {
      stopTranscriberBestEffort(shared);
    }
  }

  private async startAssistantTurnIfReady(): Promise<void> {
    const utterance = this.currentUtterance;
    // A committed speculative turn answered the pre-finalize transcript;
    // once the finalized transcript lands, log if they diverged (the finals
    // stream continuously in persistent mode, so divergence should be rare
    // — this measures whether that assumption holds in the field).
    const committed = this.activeAssistantTurn;
    if (
      utterance?.assistantTurnStarted &&
      committed?.speculativeContent != null &&
      !committed.speculativePending &&
      utterance.phase === "transcriber_closed"
    ) {
      const finalContent = utterance.finalTranscriptSegments.join(" ").trim();
      if (
        finalContent.length > 0 &&
        finalContent !== committed.speculativeContent
      ) {
        log.warn(
          {
            turnId: committed.turnId,
            speculative: committed.speculativeContent,
            final: finalContent,
          },
          "Speculative voice turn content diverged from final transcript",
        );
      }
      committed.speculativeContent = null;
    }
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

    await this.launchAssistantTurn(utterance, content);
  }

  /**
   * Take the barge-in merge context, the completed-continuation context, and
   * the handoff note for the turn being launched — each feeds exactly the next
   * launched turn — and cancel the queued announcement, because the turn this
   * context rides delivers the same answer and would otherwise say it twice.
   *
   * Every real user turn consumes here, speculative or not: a speculative
   * dispatch latches `assistantTurnStarted`, so a turn that skipped this would
   * never pick the context up on any later pass. A rolled-back dispatch hands
   * it all back (restorePendingTurnContext).
   */
  private consumePendingTurnContext(): {
    interruptedRequest: string | null;
    continuationResult: string | null;
    handedOffRequest: string | null;
    announcement: ContinuationDelivery | null;
  } {
    const consumed = {
      interruptedRequest: this.pendingInterruptedRequest,
      continuationResult: this.pendingContinuationResult,
      handedOffRequest: this.pendingHandoffRequest,
      announcement: this.pendingAnnouncement,
    };
    this.pendingInterruptedRequest = null;
    this.pendingContinuationResult = null;
    this.pendingHandoffRequest = null;
    this.clearContinuationAnnouncement();
    return consumed;
  }

  /**
   * Hand a turn's consumed pending context back to the session because the
   * turn never happened: a speculative dispatch was discarded or held, or the
   * launch never reached the bridge. Without this a hold verdict would destroy
   * a finished continuation's answer outright — the stash was already emptied
   * and no later turn would ever see it.
   *
   * Restores are conservative. A hard stop (interrupt/close/supersede) bumps
   * `detachStopGeneration`, and that drop is deliberate — never undone here.
   * Anything newer already sitting in a slot wins over the older value being
   * returned to it.
   */
  private restorePendingTurnContext(turn: ActiveAssistantTurn): void {
    const interruptedRequest = turn.interruptedRequest;
    const continuationResult = turn.continuationResult;
    const handedOffRequest = turn.handedOffRequest;
    const announcement = turn.consumedAnnouncement;
    // One restore per turn: the rollback paths overlap (a discarded turn whose
    // leg start also fails), and the second pass must be a no-op.
    turn.interruptedRequest = null;
    turn.continuationResult = null;
    turn.handedOffRequest = null;
    turn.consumedAnnouncement = null;
    if (
      this.isClosed ||
      this.detachStopGeneration !== turn.pendingContextStopGeneration
    ) {
      return;
    }
    if (this.pendingInterruptedRequest === null) {
      this.pendingInterruptedRequest = interruptedRequest;
    }
    if (this.pendingContinuationResult === null) {
      this.pendingContinuationResult = continuationResult;
    }
    // "Still running" is stale the moment a result exists, which is why the
    // detach clears the handoff note when it finishes — don't reinstate it
    // against a continuation that has since completed.
    if (
      this.pendingHandoffRequest === null &&
      this.pendingContinuationResult === null
    ) {
      this.pendingHandoffRequest = handedOffRequest;
    }
    if (announcement !== null && this.pendingAnnouncement === null) {
      this.pendingAnnouncement = announcement;
      this.scheduleContinuationAnnouncement();
    }
  }

  // Build the ActiveAssistantTurn for a released utterance and drive its model
  // leg. Resolves true once the leg has a live turn handle, false when the
  // dispatch never reached the bridge — the signal a caller with a fallback
  // route (announceContinuation) needs, since a failed start is otherwise
  // handled entirely inside startAssistantLeg.
  private async launchAssistantTurn(
    utterance: UtteranceCycle,
    content: string,
    opts?: {
      // Set on an announcement turn: the finished continuation this turn exists
      // to deliver. Its answer goes in the control prompt, not in `content`.
      continuationDelivery?: ContinuationDelivery | null;
      // Unified front-door: dispatch without releasing the utterance. The
      // thinking frame and floor-holding timers are deferred until the leg's
      // leading verdict commits the turn (see commitSpeculativeTurn); a hold
      // verdict rolls everything back instead.
      speculative?: boolean;
    },
  ): Promise<boolean> {
    utterance.assistantTurnStarted = true;
    // The announcement turn IS the delivery of the pending continuation, so it
    // must not also consume the stash — feeding it both would deliver the same
    // answer twice. Every other turn is a real user turn and takes the context.
    const pending =
      opts?.continuationDelivery == null
        ? this.consumePendingTurnContext()
        : null;
    const token = Symbol("live-voice-assistant-turn");
    const turnId = this.ensureTurnId(utterance);
    this.startMetricsTurnIfNeeded(utterance, turnId);
    this.markAssistantDispatch(utterance, turnId);
    const abortController = new AbortController();
    const activeTurn: ActiveAssistantTurn = {
      token,
      turnId,
      utterance,
      abortController,
      handle: null,
      launchedAtMs: Date.now(),
      progress: {
        ops: [],
        opsSinceNarration: 0,
        // Equal epochs at launch: a turn that has done nothing observable yet
        // has nothing to narrate, so the idle trigger waits for tool activity
        // or the maxSilenceMs heartbeat.
        stateEpoch: 0,
        narratedEpoch: 0,
        updatesSpoken: 0,
        lastFloorHolderAtMs: null,
        lastAudibleAtMs: Date.now(),
        idleTimer: null,
        narrationInFlight: false,
      },
      assistantCompleted: false,
      ttsDone: false,
      minimizeRequested: false,
      ttsAudioStarted: false,
      finalized: false,
      speculativePending: opts?.speculative === true,
      speculativeGeneration: this.vadSpeechGeneration,
      speculativeContent: opts?.speculative === true ? content : null,
      speculativeDispatchedAtMs: Date.now(),
      speculativeHoldAllowed:
        opts?.speculative === true && utterance.endpointExtensionCount === 0,
      verdictDeadlineTimer: null,
      discardRequested: false,
      speculativeBuffer: "",
      interruptedRequest: pending?.interruptedRequest ?? null,
      continuationResult: pending?.continuationResult ?? null,
      handedOffRequest: pending?.handedOffRequest ?? null,
      consumedAnnouncement: pending?.announcement ?? null,
      pendingContextStopGeneration: this.detachStopGeneration,
      continuationDelivery: opts?.continuationDelivery ?? null,
      toolUseStarted: false,
      firstDeltaSeen: false,
      deltaEpoch: 0,
      ackSpoken: false,
      ackGenerationPending: false,
      ackTimer: null,
      escalationHandedOff: false,
      ttsBuffer: "",
      ttsSegmentEnqueued: false,
      ttsJobs: [],
      ttsQueue: Promise.resolve(),
      assistantMessageId: null,
      assistantAudioChunks: [],
      assistantAudioMimeType: "audio/pcm",
    };
    this.activeAssistantTurn = activeTurn;

    // A speculative turn defers the thinking frame and both floor-holding
    // timers to commitSpeculativeTurn: until the verdict arrives, the pause
    // may still be mid-thought and nothing must be user-visible.
    if (!opts?.speculative) {
      await this.sendFrame({ type: "thinking", turnId });
      if (!this.isActiveAssistantTurn(token)) {
        this.restorePendingTurnContext(activeTurn);
        return false;
      }
    } else {
      // Verdict-deadline fail-open: the deferred-everything window is only
      // safe while the verdict is fast. If the leg produces no verdict
      // within the endpoint budget (provider TTFT tail), commit anyway so
      // the thinking frame shows and the ack timer arms — bounded dead air
      // instead of unbounded structural silence. A verdict that arrives
      // after the commit still works: escalate hands off normally, and a
      // late hold token is stripped like any stray token (the utterance is
      // already released, so holding is no longer possible).
      activeTurn.verdictDeadlineTimer = setTimeout(() => {
        activeTurn.verdictDeadlineTimer = null;
        if (
          this.activeAssistantTurn?.token !== token ||
          !activeTurn.speculativePending
        ) {
          return;
        }
        log.info(
          {
            turnId,
            budgetMs: this.frontModelConfig.endpointDecisionTimeoutMs,
          },
          "Speculative verdict deadline elapsed; committing turn (fail-open)",
        );
        this.commitSpeculativeTurn(activeTurn);
      }, this.frontModelConfig.endpointDecisionTimeoutMs);
    }

    // Slow-first-delta spoken ack: if the model produces no delta within the
    // budget, a short front-model-phrased sentence holds the floor. Only
    // meaningful on TTS sessions — a text-only session has no audio gap to
    // bridge.
    if (this.streamTtsAudio && !opts?.speculative) {
      this.armAckTimer(activeTurn);
    }

    // Progress narration speaks into the turn's audible dead air on a
    // cadence, wherever in the turn it occurs; without TTS or a decider there
    // is nothing to speak (the idle trigger's static fallback still needs a
    // generation attempt to fall back from).
    if (
      this.frontModelConfig.progress.enabled &&
      this.streamTtsAudio &&
      this.frontDecider &&
      !opts?.speculative
    ) {
      this.armProgressIdleTimer(activeTurn);
    }

    // Front-door leg: a fast model fronts every turn (the `voiceFrontDoor`
    // call site pins it) and may hand off to a quality leg on the escalate
    // verdict.
    const started = await this.startAssistantLeg(activeTurn, {
      content,
      routingLeg: "front-door",
      frontDoor: true,
    });
    if (!started) {
      // Nothing was persisted or spoken, so the context this turn consumed goes
      // back to the session rather than dying with the failed dispatch.
      this.restorePendingTurnContext(activeTurn);
    }
    return started;
  }

  /**
   * Drive one model leg of an assistant turn through the session bridge,
   * streaming its deltas to the live-voice client and TTS. Returns once the
   * leg's turn handle is acquired (or the start fails) — turn completion stays
   * callback-driven via message_complete. The resolved boolean is whether the
   * bridge actually handed back a turn handle: false means the leg never
   * started (no bridge wired, or the start threw and was reported as an error
   * frame), so nothing of this turn was persisted or spoken.
   *
   * A turn runs one leg normally. Under triage-and-escalate the front-door leg
   * (`frontDoor: true`) runs the verdict-first protocol: its leading tokens
   * classify as hold / escalate / answer before anything is spoken. On the
   * escalate verdict the post-verdict stream buffers into the capped bridge
   * and `escalateTurn` starts a second "escalated" leg that shares this same
   * ActiveAssistantTurn. The persisted assistant row is reduced to the capped
   * bridge by the bridge's teardown transcript-hygiene pass; the shared
   * conversation-hub broadcast still streams the raw verdict deltas mid-turn
   * until the turn-end resync (the remaining scope of issue #37850).
   */
  private async startAssistantLeg(
    activeTurn: ActiveAssistantTurn,
    leg: {
      content: string;
      overrideProfile?: string;
      routingLeg?: VoiceRoutingLeg;
      frontDoor?: boolean;
      spokenEscalationBridge?: string;
    },
  ): Promise<boolean> {
    if (!this.startVoiceTurn) {
      return false;
    }
    const { token, utterance, turnId } = activeTurn;

    // `rawText` accumulates this leg's full stream. A front-door leg starts
    // in `deciding` until its leading tokens classify as hold / escalate /
    // answer: an answer flushes through the shared marker holdback, while an
    // escalation buffers the post-verdict stream into `bridgeRaw` until the
    // bridge is complete, then hands off. A default/escalated leg flushes
    // every delta through the same holdback, so a stray control marker from
    // the main model is stripped instead of spoken.
    let rawText = "";
    let frontDoorStage: "deciding" | "answer" | "bridging" | "handedOff" =
      "deciding";
    let bridgeRaw = "";

    const emitLegText = (chunk: string): void => {
      if (chunk.length === 0) {
        return;
      }
      this.markFirstAssistantDelta(utterance, turnId);
      this.markFirstDeltaForAck(activeTurn);
      // Send-time abort gate: a delta queued behind a backed-up outbound
      // frame must not be written once barge-in aborts the turn, or the
      // cancelled reply's text leaks ahead of turn_cancelled. Key off this
      // turn's own abort signal — a normal message_complete finalizes and
      // clears activeAssistantTurn while trailing deltas may still be
      // draining, so an activeAssistantTurn-based guard would drop them.
      // Escalation aborts the front-door handle, not this turn's controller,
      // so legitimate front-door text still sends.
      void this.sendFrame(
        { type: "assistant_text_delta", text: chunk },
        () => !activeTurn.abortController.signal.aborted && !this.isClosed,
      );
      this.bufferAssistantTextForTts(token, chunk);
    };

    const flushLegText = createControlMarkerHoldback(activeTurn, emitLegText);

    // Hand off once enough of the post-verdict stream has arrived to cap
    // the bridge (sentence terminator or hard cap). Until then nothing is
    // spoken — the bridge goes out in one piece at hand-off, so the audio,
    // the persisted row, and the phrase quoted to the escalated leg are all
    // the same capped text.
    const maybeHandOffBridge = (): void => {
      if (!isEscalationBridgeComplete(bridgeRaw)) {
        return;
      }
      frontDoorStage = "handedOff";
      this.escalateTurn(activeTurn, capEscalationBridge(bridgeRaw));
    };

    try {
      const handle = await this.startVoiceTurn({
        conversationId: this.conversationId,
        voiceSessionId: this.context.sessionId,
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
        userMessageInterface: "macos",
        assistantMessageInterface: "macos",
        voiceControlPrompt: buildVoiceControlPrompt(activeTurn, {
          ...(leg.frontDoor !== undefined ? { frontDoor: leg.frontDoor } : {}),
        }),
        content: leg.content,
        isInbound: true,
        launchedAtMs: activeTurn.launchedAtMs,
        signal: activeTurn.abortController.signal,
        // An announcement turn's content is a fixed marker, not user speech:
        // persist it hidden and suppress its echo so nothing renders as a user
        // bubble for a turn the user never started.
        ...(activeTurn.continuationDelivery !== null
          ? { hiddenSyntheticPrompt: true }
          : {}),
        ...(leg.overrideProfile != null
          ? { overrideProfile: leg.overrideProfile }
          : {}),
        ...(leg.routingLeg != null ? { routingLeg: leg.routingLeg } : {}),
        ...(leg.spokenEscalationBridge != null
          ? { spokenEscalationBridge: leg.spokenEscalationBridge }
          : {}),
        // A speculative front-door leg's decision rule includes the hold
        // branch so its leading tokens can be the hold verdict — but only
        // on the utterance's FIRST dispatch. Extension replays (the
        // utterance already held once) and non-speculative legs must never
        // learn the token, or a spoken answer could start with it / a
        // second hold could stack another silent extension.
        ...(activeTurn.speculativePending &&
        activeTurn.speculativeHoldAllowed &&
        leg.frontDoor
          ? { unifiedVerdict: true }
          : {}),
        callbacks: {
          assistant_text_delta: (msg) => {
            if (!this.isForwardingAssistantText(token)) {
              return;
            }
            if (leg.frontDoor) {
              rawText += msg.text;
              if (frontDoorStage === "handedOff") {
                return;
              }
              if (frontDoorStage === "bridging") {
                bridgeRaw += msg.text;
                maybeHandOffBridge();
                return;
              }
              // Verdict-first: the leg's leading tokens decide the turn's
              // fate. Hold discards a speculative turn (mid-thought pause,
              // keep listening); escalate and answer both commit it —
              // utterance release, thinking frame, and timers all happen
              // inside commitSpeculativeTurn. The hold branch is only
              // classifiable while the leg is speculative (its decision
              // rule is the only one that teaches the hold token).
              if (frontDoorStage === "deciding") {
                const verdict = classifyFrontDoorLeading(
                  rawText.trimStart(),
                  activeTurn.speculativePending &&
                    activeTurn.speculativeHoldAllowed,
                );
                if (verdict === "pending") {
                  return;
                }
                if (verdict === "hold") {
                  void this.holdSpeculativeTurn(activeTurn);
                  return;
                }
                if (
                  activeTurn.speculativePending &&
                  !this.commitSpeculativeTurn(activeTurn)
                ) {
                  return;
                }
                if (verdict === "escalate") {
                  frontDoorStage = "bridging";
                  bridgeRaw = rawText
                    .trimStart()
                    .slice(ESCALATE_VERDICT_TOKEN.length);
                  maybeHandOffBridge();
                  return;
                }
                frontDoorStage = "answer";
              }
              flushLegText(rawText);
              return;
            }
            // Defensive: speculative legs are always front-door today, but a
            // non-front-door speculative leg must still fail open to a
            // committed turn on its first delta rather than dangle.
            if (activeTurn.speculativePending) {
              activeTurn.speculativeBuffer += msg.text;
              if (activeTurn.speculativeBuffer.trimStart().length === 0) {
                return;
              }
              if (!this.commitSpeculativeTurn(activeTurn)) {
                return;
              }
            }
            rawText += msg.text;
            flushLegText(rawText);
          },
          message_complete: (msg) => {
            const current = this.activeAssistantTurn;
            if (
              current?.token !== token ||
              current.assistantCompleted ||
              // A barged-in turn finalizes through cancelAssistantTurn.
              current.abortController.signal.aborted ||
              this.isClosed
            ) {
              return;
            }
            // A speculative leg that finished without a single delta (empty
            // output, provider hiccup) carries no verdict — fail open to a
            // committed turn so the utterance releases and finalizes like a
            // normal empty completion instead of dangling un-released.
            if (current.speculativePending) {
              this.commitSpeculativeTurn(current);
            }
            // A front-door leg that stopped mid-bridge (a bare escalate
            // verdict, or a holding phrase with no sentence terminator)
            // hands off now with whatever arrived; the canned fallback
            // covers an empty bridge. A cancellation mid-bridge falls
            // through to normal cancelled finalization instead — a dead
            // turn must not spawn an escalated leg.
            if (
              leg.frontDoor &&
              frontDoorStage === "bridging" &&
              msg.type === "message_complete" &&
              !current.escalationHandedOff
            ) {
              frontDoorStage = "handedOff";
              this.escalateTurn(current, capEscalationBridge(bridgeRaw));
              return;
            }
            // A front-door leg that handed off is finished; the escalated leg
            // drives completion. The front-door leg's own trailing completion
            // (including the generation_cancelled from its abort) is a no-op.
            if (leg.frontDoor && current.escalationHandedOff) {
              return;
            }
            // A held "[…"-tail that never completed a marker is real text —
            // force-flush it before assistantCompleted closes the TTS buffer
            // and completeTtsForTurn signals the drain, so it is spoken and
            // emitted rather than dropped.
            if (!leg.frontDoor && msg.type === "message_complete") {
              flushLegText(rawText, { force: true });
            }
            current.assistantCompleted = true;
            if (msg.type === "generation_cancelled") {
              void this.finalizeAssistantTurn(
                current,
                "cancelled",
                "generation_cancelled",
              );
              return;
            }
            current.assistantMessageId = msg.messageId ?? null;
            current.continuationDelivery = null;
            this.completeTtsForTurn(token);
          },
          persisted_user_message_id: (messageId) => {
            const current = this.activeAssistantTurn;
            // Only the first leg's user row is the real caller utterance; the
            // escalated leg persists a hidden synthetic continuation prompt.
            if (current?.token !== token || leg.routingLeg === "escalated") {
              return;
            }
            current.utterance.userMessageId = messageId;
          },
          persisted_assistant_message_id: (messageId) => {
            const current = this.activeAssistantTurn;
            if (current?.token !== token) {
              return;
            }
            current.assistantMessageId = messageId;
          },
          tool_use_start: (toolName, detail) => {
            const current = this.activeAssistantTurn;
            if (current?.token !== token) {
              return;
            }
            current.toolUseStarted = true;
            // Foreground wins the workspace: the continuation runs with full
            // subagent abilities (it can write files, run commands), so the
            // moment a live turn starts a consequential tool the two could
            // race on the same workspace, host, or extension state. Kill
            // running continuations and skip pending detaches; a continuation
            // only survives while foreground turns stay provably read-only
            // (the topic-change case it exists for). Fail closed: only
            // provably non-contending built-ins keep a continuation alive
            // (see foregroundToolContendsWithContinuation) — a name-based
            // side-effect denylist misses mutators like plugin/MCP/skill
            // tools. Over-aborting only drops a best-effort salvage;
            // under-aborting risks a write race.
            // An already-completed continuation's stashed answer is kept — it
            // cannot race anything.
            //
            // Accepted residual: the abort is signal-level. A tool call
            // already executing inside the continuation is not awaited (the
            // agent loop abandons the in-flight promise on cancellation), so
            // that one call can briefly overlap the foreground tool. Closing
            // it would take a cross-conversation execution lock that the
            // subagent model deliberately does not have — parallel subagents
            // share the workspace with the parent everywhere — and awaiting
            // background teardown here would stall the live call's turn.
            // This gate already makes voice stricter than that baseline; the
            // residual is bounded to one in-flight call at barge-over time.
            if (
              foregroundToolContendsWithContinuation(toolName, detail?.input)
            ) {
              this.abortDetachedRuns({
                keepPendingResult: true,
                reason: "foreground_tool_contends",
                toolName,
              });
            }
            // The op counts toward the narration threshold on start (not
            // completion) so a burst of slow tools still trips the ops
            // trigger while they run.
            current.progress.ops.push({
              toolName,
              ...(detail?.toolUseId !== undefined
                ? { toolUseId: detail.toolUseId }
                : {}),
              startedAtMs: Date.now(),
            });
            current.progress.opsSinceNarration += 1;
            current.progress.stateEpoch += 1;
            log.debug({ turnId, toolName }, "Live voice turn started tool use");
            // Definitive tool use means the turn is guaranteed slow: speak
            // the floor-holding ack now instead of waiting out the
            // first-delta timer (same one-ack-per-turn `ackSpoken` budget).
            // Post-handoff the escalation bridge phrase holds the floor and
            // front-door deltas never set firstDeltaSeen, so the escalated
            // leg's tool starts must not stack another filler on the bridge.
            if (
              this.streamTtsAudio &&
              !current.firstDeltaSeen &&
              !current.ackSpoken &&
              !current.escalationHandedOff
            ) {
              this.clearAckTimer(current);
              this.speakAck(current, "tool_use", toolName);
            }
            this.maybeNarrateProgress(current, "ops");
          },
          tool_result: (event) => {
            const current = this.activeAssistantTurn;
            if (current?.token !== token) {
              return;
            }
            // Match by toolUseId when present; otherwise the last-started
            // incomplete op with the same name (parallel same-name ops
            // resolve newest-first).
            const op =
              (event.toolUseId !== undefined
                ? current.progress.ops.find(
                    (o) => o.toolUseId === event.toolUseId,
                  )
                : undefined) ??
              findLastIncompleteOp(current.progress.ops, event.toolName);
            // A long-running op finishing is the beat the user has been
            // waiting through: it narrates immediately rather than waiting for
            // `opsThreshold` more ops, which on a one-slow-tool turn never
            // arrive. Short ops stay on the ops trigger — narrating every
            // quick lookup is the chatter this cadence exists to avoid.
            let trigger: "ops" | "op_complete" = "ops";
            if (op) {
              op.completedAtMs = Date.now();
              if (event.isError !== undefined) {
                op.isError = event.isError;
              }
              op.resultPreview = event.resultPreview;
              if (
                op.completedAtMs - op.startedAtMs >=
                this.frontModelConfig.progress.longOpMs
              ) {
                trigger = "op_complete";
              }
            }
            current.progress.stateEpoch += 1;
            this.maybeNarrateProgress(current, trigger);
          },
        },
        onError: (message) => {
          const current = this.activeAssistantTurn;
          if (
            !this.isActiveAssistantTurn(token) ||
            current?.assistantCompleted
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

      const current = this.activeAssistantTurn;
      if (current?.token !== token) {
        // A discard that beat this handle's resolution still owes the
        // rollback: a plain abort would leave the discarded pause's user
        // row in history.
        if (activeTurn.discardRequested && handle.discard) {
          void handle.discard().catch((err: unknown) => {
            log.warn(
              { err, turnId: activeTurn.turnId },
              "Late speculative voice turn discard failed",
            );
          });
        } else {
          handle.abort();
        }
        // The bridge ran: the leg's user row was persisted (or explicitly
        // rolled back by the discard above), so this counts as started even
        // though a newer turn owns the session.
        return true;
      }
      if (current.finalized) {
        this.clearActiveAssistantTurn(token);
        return true;
      }
      // The front-door leg may have handed off before its handle resolved;
      // abort it rather than exposing it as the turn's live handle.
      if (leg.frontDoor && current.escalationHandedOff) {
        handle.abort();
        return true;
      }

      current.handle = handle;
      return true;
    } catch (err) {
      if (!this.isActiveAssistantTurn(token)) {
        return false;
      }

      this.clearFillerTimers(activeTurn);
      this.clearActiveAssistantTurn(token);
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice assistant turn could not be started: ${errorMessage(
          err,
        )}`,
      });
      await this.finalizePendingUtterance(utterance, "assistant_start_error");
      this.scheduleRearmAfterTurn();
      return false;
    }
  }

  /**
   * Hand the turn from the front-door leg to the strong "escalated" leg after
   * the escalate verdict. Speaks the capped bridge (the leg's own post-verdict
   * holding phrase, or the canned fallback when that was too short) in one
   * piece and force-flushes it so it plays during the strong-model call, then
   * starts the escalated leg on the same ActiveAssistantTurn. Idempotent.
   */
  private escalateTurn(
    activeTurn: ActiveAssistantTurn,
    cappedBridge: string,
  ): void {
    if (activeTurn.escalationHandedOff || activeTurn.finalized) {
      return;
    }
    activeTurn.escalationHandedOff = true;
    // The escalation bridge below holds the floor, so a pending
    // slow-first-delta ack or progress narration would only stack a second
    // filler on top of it.
    this.clearFillerTimers(activeTurn);
    // Abort the front-door leg so a model that keeps generating past the
    // bridge cap adds no latency before the escalated leg starts.
    activeTurn.handle?.abort();
    activeTurn.handle = null;

    // Speak the bridge so the strong-model call has no dead air. The model's
    // own bridge is real assistant speech (captions + TTS); the canned
    // fallback stays audio-only, matching the persisted-row hygiene (a
    // deleted row for a bridge the model never produced).
    const usesFallbackBridge = cappedBridge.length < MIN_SPOKEN_BRIDGE_CHARS;
    const spokenBridge = usesFallbackBridge
      ? FALLBACK_ESCALATION_BRIDGE
      : cappedBridge;
    if (!usesFallbackBridge) {
      this.markFirstAssistantDelta(activeTurn.utterance, activeTurn.turnId);
      this.markFirstDeltaForAck(activeTurn);
      void this.sendFrame(
        { type: "assistant_text_delta", text: spokenBridge },
        () => !activeTurn.abortController.signal.aborted && !this.isClosed,
      );
    }
    this.bufferAssistantTextForTts(activeTurn.token, `${spokenBridge} `);
    // Force-flush now: on the TTS path an unpunctuated bridge would otherwise
    // sit buffered until a sentence boundary and leave the caller in silence
    // during the escalated model's call.
    this.flushTtsBuffer(activeTurn.token, true);

    // No overrideProfile: the escalated leg runs on the call-site default —
    // the exact profile an un-routed voice turn would use (see
    // voice-triage-escalate.ts). The bridge phrase the caller just heard is
    // handed along so the escalated continuation rule can quote it and ban
    // a re-announcing echo ("Let me check…" twice in a row).
    void this.startAssistantLeg(activeTurn, {
      content: ESCALATION_CONTINUATION_CONTENT,
      routingLeg: "escalated",
      spokenEscalationBridge: spokenBridge,
    });

    // Escalated legs run the slowest work in the system (strong-model
    // thinking + tool loops), and the bridge only covers the first couple of
    // seconds of it — exactly the dead air progress narration exists for.
    // Re-arm the idle narration timer (cleared above with the ack): its
    // audible-silence gating means nothing speaks until the bridge audio has
    // fully drained plus a whole idle interval. Acks stay suppressed
    // post-handoff — the bridge already served that role.
    if (
      this.frontModelConfig.progress.enabled &&
      this.streamTtsAudio &&
      this.frontDecider
    ) {
      this.armProgressIdleTimer(activeTurn);
    }
  }

  private async cancelAssistantTurn(reason: string): Promise<void> {
    const turn = this.activeAssistantTurn;
    this.activeAssistantTurn = null;
    if (turn) {
      this.clearFillerTimers(turn);
      // Tagged for the same reason as the barge-in abort: untagged caller
      // aborts misclassify as retryable transport failures downstream.
      turn.abortController.abort(
        createAbortReason("voice_session_aborted", `live-voice-${reason}`),
      );
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
      activeTurn?.token === token &&
      !activeTurn.finalized &&
      // Barge-in aborts synchronously but finalizes through an async
      // cancelAssistantTurn chain; the abort makes the turn dead at once so a
      // rejected startVoiceTurn or a trailing onError in that window does not
      // treat it as live (and emit a stray error frame or double-finalize).
      !activeTurn.abortController.signal.aborted &&
      !this.isClosed
    );
  }

  private isForwardingAssistantText(token: symbol): boolean {
    const activeTurn = this.activeAssistantTurn;
    return (
      activeTurn?.token === token &&
      !activeTurn.assistantCompleted &&
      !activeTurn.finalized &&
      // Fence a late first assistant_text_delta once barge-in aborts a pre-TTS
      // turn, before its async teardown finalizes — mirrors isForwardingTts so
      // no cancelled-turn text leaks after turn_cancelled.
      !activeTurn.abortController.signal.aborted &&
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

  // Arms the slow-first-delta ack timer for a just-launched turn: on expiry,
  // if no assistant delta has arrived and the turn is still live, one short
  // phrase is spoken to hold the floor.
  private armAckTimer(activeTurn: ActiveAssistantTurn): void {
    const { token } = activeTurn;
    activeTurn.ackTimer = setTimeout(() => {
      activeTurn.ackTimer = null;
      if (
        !this.isActiveAssistantTurn(token) ||
        activeTurn.firstDeltaSeen ||
        activeTurn.ackSpoken
      ) {
        return;
      }
      this.speakAck(activeTurn, "first_delta");
    }, this.frontModelConfig.ackFirstDeltaTimeoutMs);
  }

  private clearAckTimer(turn: ActiveAssistantTurn): void {
    if (turn.ackTimer !== null) {
      clearTimeout(turn.ackTimer);
      turn.ackTimer = null;
    }
  }

  // The model produced real output for this turn: the pending slow-first-delta
  // ack is moot, and any in-flight narration generation is stale (it captures
  // deltaEpoch to notice). The narration idle timer stays armed — the dead air
  // narration exists to fill is almost always MID-turn (between tool phases,
  // during long silent LLM calls after the model's opening words), so it must
  // keep watching after the model speaks and re-trigger once the audio drains
  // and silence stretches again.
  private markFirstDeltaForAck(turn: ActiveAssistantTurn): void {
    turn.firstDeltaSeen = true;
    turn.deltaEpoch += 1;
    this.clearAckTimer(turn);
  }

  // Arms (or re-arms) the dead-air narration timer. The countdown measures
  // audible silence — time since the turn's audio last (estimatedly) reached
  // the user's ears — not time since launch, so it covers mid-turn silences
  // for the whole turn. On expiry with audio still pending, or with the
  // silence not yet a full interval old, it re-arms for the remainder; only a
  // full interval of audible silence reaches the narration gatekeeper. The
  // interval is a polling cadence, not a speaking cadence: most ticks find
  // nothing new to report and stay quiet, so what the user hears follows the
  // turn's tool activity (with `maxSilenceMs` as the heartbeat ceiling).
  private armProgressIdleTimer(
    turn: ActiveAssistantTurn,
    delayMs?: number,
  ): void {
    const { token } = turn;
    this.clearProgressIdleTimer(turn);
    turn.progress.idleTimer = setTimeout(() => {
      turn.progress.idleTimer = null;
      if (!this.isActiveAssistantTurn(token) || turn.assistantCompleted) {
        return;
      }
      if (!this.turnAudioIdle(turn)) {
        // Audio is buffered, queued, or still playing: a fresh silence can
        // only be a full interval old one interval from now.
        this.armProgressIdleTimer(turn);
        return;
      }
      const remaining = this.progressIdleDeadlineMs(turn) - Date.now();
      if (remaining > 0) {
        this.armProgressIdleTimer(turn, remaining);
        return;
      }
      this.maybeNarrateProgress(turn, "idle");
      this.armProgressIdleTimer(turn);
    }, delayMs ?? this.frontModelConfig.progress.idleIntervalMs);
  }

  // Wall-clock instant the current audible silence turns a full interval old.
  private progressIdleDeadlineMs(turn: ActiveAssistantTurn): number {
    return (
      this.progressSilenceSinceMs(turn) +
      this.frontModelConfig.progress.idleIntervalMs
    );
  }

  // When the turn's current audible silence began: the latest of the last
  // emitted segment, the estimated client playback end, and the last enqueued
  // filler.
  private progressSilenceSinceMs(turn: ActiveAssistantTurn): number {
    return Math.max(
      turn.progress.lastAudibleAtMs,
      this.assistantPlaybackTailUntilMs,
      turn.progress.lastFloorHolderAtMs ?? 0,
    );
  }

  // No assistant audio is pending or (estimatedly) still playing: nothing
  // buffered toward the next sentence, every queued TTS segment fully
  // emitted, and the client-side playback-tail estimate expired.
  private turnAudioIdle(turn: ActiveAssistantTurn): boolean {
    return (
      turn.ttsBuffer.length === 0 &&
      turn.ttsJobs.every((job) => job.settled) &&
      Date.now() >= this.assistantPlaybackTailUntilMs
    );
  }

  private clearProgressIdleTimer(turn: ActiveAssistantTurn): void {
    if (turn.progress.idleTimer !== null) {
      clearTimeout(turn.progress.idleTimer);
      turn.progress.idleTimer = null;
    }
  }

  // Clears the turn's filler timers (slow-first-delta ack, dead-air
  // narration, verdict deadline) for events that end the current filler
  // lifecycle: escalation hand-off (which then re-arms narration for the
  // escalated leg), barge-in, cancellation, tts-completion, finalize. Real
  // output moots only the ack (markFirstDeltaForAck) — the narration timer
  // keeps watching for mid-turn dead air.
  private clearFillerTimers(turn: ActiveAssistantTurn): void {
    this.clearAckTimer(turn);
    this.clearProgressIdleTimer(turn);
    if (turn.verdictDeadlineTimer !== null) {
      clearTimeout(turn.verdictDeadlineTimer);
      turn.verdictDeadlineTimer = null;
    }
  }

  // A spoken ack may only speak into a live turn's pre-first-delta dead air.
  // Once the turn is stale, the brain's first delta has arrived, an
  // escalation hand-off has enqueued its bridge phrase (which holds the floor
  // itself), or the turn has completed outright — a tool-only/no-text turn
  // completes with firstDeltaSeen still false — an ack is moot and must not
  // speak over real output, stack on the escalation bridge, or voice a
  // finished turn.
  private turnCanSpeakFiller(turn: ActiveAssistantTurn): boolean {
    return (
      this.isActiveAssistantTurn(turn.token) &&
      !turn.firstDeltaSeen &&
      !turn.escalationHandedOff &&
      !turn.assistantCompleted
    );
  }

  // Narration, unlike the ack, is not confined to the pre-first-delta window:
  // the dead air it exists to fill is almost always mid-turn, after the
  // model's opening words. It may speak whenever the live turn is audibly
  // silent right now — nothing streaming, queued, or still playing — and has
  // not completed. Escalated turns qualify too: the bridge phrase holds the
  // floor only while its audio plays (covered by the audible-idle check),
  // and the strong leg's tool loops are the longest dead air in the system.
  private turnCanNarrateProgress(turn: ActiveAssistantTurn): boolean {
    return (
      this.isActiveAssistantTurn(turn.token) &&
      !turn.assistantCompleted &&
      this.turnAudioIdle(turn)
    );
  }

  // The idle tick has something worth saying when the turn's tool activity has
  // moved since the last narration described it, or when the silence has run
  // past `maxSilenceMs` — the heartbeat ceiling that proves the assistant is
  // still alive on a turn with no observable activity at all. Every other tick
  // stays quiet, so the cadence follows the work rather than the clock.
  private progressIdleHasSomethingToSay(turn: ActiveAssistantTurn): boolean {
    const { progress } = turn;
    if (progress.stateEpoch !== progress.narratedEpoch) {
      return true;
    }
    const silentForMs = Date.now() - this.progressSilenceSinceMs(turn);
    if (silentForMs >= this.frontModelConfig.progress.maxSilenceMs) {
      return true;
    }
    log.debug(
      { turnId: turn.turnId, silentForMs },
      "Live voice progress narration held — nothing new since the last update",
    );
    return false;
  }

  // Gatekeeper for spoken progress narration: it speaks only while the turn
  // is audibly silent, spaced `minGapMs` from any spoken floor-holder (ack or
  // narration), one generation at a time, and — per trigger — only once the
  // ops trigger has `opsThreshold` ops accumulated or the idle trigger has
  // something new to report. No per-turn count cap: the cadence guards bound
  // the rate, and going quiet deep into a long turn is the failure mode
  // narration exists to prevent. Every failing guard short-circuits silently;
  // a skipped ops trigger keeps its accumulated count, so the next tool event
  // or idle tick retries.
  private maybeNarrateProgress(
    turn: ActiveAssistantTurn,
    trigger: "ops" | "idle" | "op_complete",
  ): void {
    const cfg = this.frontModelConfig.progress;
    const { progress } = turn;
    const frontDecider = this.frontDecider;
    if (
      !cfg.enabled ||
      !this.streamTtsAudio ||
      !frontDecider ||
      !this.turnCanNarrateProgress(turn) ||
      // A pending ack generation is a floor-holder-in-waiting: starting a
      // narration generation now would only be discarded by the post-await
      // re-check once the ack enqueues — a guaranteed wasted provider call.
      turn.ackGenerationPending ||
      progress.narrationInFlight ||
      (progress.lastFloorHolderAtMs !== null &&
        Date.now() - progress.lastFloorHolderAtMs < cfg.minGapMs) ||
      (trigger === "ops" && progress.opsSinceNarration < cfg.opsThreshold) ||
      (trigger === "idle" && !this.progressIdleHasSomethingToSay(turn))
    ) {
      return;
    }
    void this.speakProgressUpdate(turn, frontDecider, trigger);
  }

  // Generate and speak one progress narration. Like the ack, it is audio-only
  // — no assistant_text_delta frame — and enqueues as a standalone sentence
  // on the turn's ordered TTS queue. The decider internally bounds the call
  // by `progress.generationTimeoutMs` and resolves null on every failure
  // mode; on null the idle trigger falls back to a static phrase (silence is
  // actively harmful there) while the tool-activity triggers stay silent — a
  // generic filler is not worth it when narration was merely opportunistic.
  private async speakProgressUpdate(
    turn: ActiveAssistantTurn,
    frontDecider: VoiceFrontDecider,
    trigger: "ops" | "idle" | "op_complete",
  ): Promise<void> {
    const { progress } = turn;
    progress.narrationInFlight = true;
    // Any delta that lands while the decider call is in flight makes the
    // generated text stale — and proves the model is speaking again.
    const deltaEpochAtLaunch = turn.deltaEpoch;
    // The activity this update describes. Tool events that land mid-generation
    // are news the generated text cannot carry, so they must leave the idle
    // trigger armed rather than count as already narrated.
    const stateEpochAtLaunch = progress.stateEpoch;
    try {
      const now = Date.now();
      const currentOp = findLastIncompleteOp(progress.ops);
      const input: VoiceProgressTextInput = {
        transcriptSoFar: turn.utterance.finalTranscriptSegments
          .join(" ")
          .trim(),
        completedOps: progress.ops
          .filter(
            (op): op is TurnProgressOp & { completedAtMs: number } =>
              op.completedAtMs !== undefined,
          )
          // `ops` is in start order; the decider contract wants completion
          // order, which differs when parallel tools finish out of order.
          .sort((a, b) => a.completedAtMs - b.completedAtMs)
          .map((op) => ({
            toolName: op.toolName,
            ...(op.isError !== undefined ? { isError: op.isError } : {}),
            ...(op.resultPreview !== undefined
              ? { resultPreview: op.resultPreview }
              : {}),
          })),
        currentOp: currentOp
          ? {
              toolName: currentOp.toolName,
              elapsedMs: now - currentOp.startedAtMs,
            }
          : null,
        turnElapsedMs: now - turn.launchedAtMs,
        updateIndex: progress.updatesSpoken + 1,
      };
      const generated = await frontDecider
        .generateProgressText(input, turn.abortController.signal)
        // The decider contract never rejects; belt-and-braces for a stub.
        .catch(() => null);
      // Liveness re-check after the await: any turnCanNarrateProgress
      // condition may have flipped while generating, and a delta that landed
      // mid-generation (deltaEpoch moved) makes the text stale even when the
      // resulting audio has already drained by now. The ack-generation and
      // floor re-checks close the race with a generated ack that
      // STARTED after this generation did — the entry guard rejects a
      // narration while an ack generation is already pending, but cannot see
      // one that begins mid-generation: while that ack is pending it has not
      // yet stamped `lastFloorHolderAtMs`, and once it enqueues the minGapMs
      // spacing must be re-applied from that stamp — either way, enqueueing
      // now would stack back-to-back filler. A bail here is silent and keeps
      // the update budget, exactly like the stale-turn bail.
      if (
        !this.turnCanNarrateProgress(turn) ||
        turn.deltaEpoch !== deltaEpochAtLaunch ||
        turn.ackGenerationPending ||
        (progress.lastFloorHolderAtMs !== null &&
          Date.now() - progress.lastFloorHolderAtMs <
            this.frontModelConfig.progress.minGapMs)
      ) {
        return;
      }
      let raw = generated;
      if (raw === null) {
        if (trigger !== "idle") {
          return;
        }
        raw = pickProgressPhrase(this.progressPhraseCounter++);
      }
      if (!this.enqueueFillerPhrase(turn, raw)) {
        return;
      }
      progress.opsSinceNarration = 0;
      progress.narratedEpoch = stateEpochAtLaunch;
      progress.updatesSpoken += 1;
      // Like the ack mark, recorded only when narration audio actually
      // enqueued (decider text or static fallback alike).
      this.markProgressSpoken(turn);
      // Restart the dead-air countdown from this narration.
      this.armProgressIdleTimer(turn);
    } finally {
      progress.narrationInFlight = false;
    }
  }

  // Speak the turn's one floor-holding ack (every ack trigger shares the
  // `ackSpoken` budget). The ack is audio-only — no assistant_text_delta frame
  // — so captions and the persisted assistant message carry only the model's
  // own output. It enqueues as a complete standalone sentence on the turn's
  // ordered TTS queue, so the model's audio always follows it cleanly; it
  // never consumes the eager first-clause flush reserved for the model's real
  // first segment.
  private speakAck(
    activeTurn: ActiveAssistantTurn,
    kind: LiveVoiceSpokenAckKind,
    toolName?: string,
  ): void {
    if (!this.frontDecider) {
      // No decider, no ack: a canned line is worse than the silence, which
      // progress narration already covers once the turn runs long.
      return;
    }
    activeTurn.ackSpoken = true;
    // Optimistic ackSpoken above keeps the one-per-turn budget honest for
    // any other ack trigger while the generation is in flight; the async
    // path undoes it if the ack turns out moot.
    void this.speakGeneratedAck(activeTurn, this.frontDecider, kind, toolName);
  }

  // Ask the front model for one short contextual sentence. The decider
  // internally bounds the call by `ackGenerationTimeoutMs` and resolves null
  // on every failure mode, so the enqueue never waits beyond that budget; a
  // null generation speaks nothing.
  private async speakGeneratedAck(
    activeTurn: ActiveAssistantTurn,
    frontDecider: VoiceFrontDecider,
    kind: LiveVoiceSpokenAckKind,
    toolName?: string,
  ): Promise<void> {
    activeTurn.ackGenerationPending = true;
    try {
      const transcript = activeTurn.utterance.finalTranscriptSegments
        .join(" ")
        .trim();
      const generated = await frontDecider
        .generateAckText(
          {
            transcriptSoFar: transcript,
            toolName,
          },
          activeTurn.abortController.signal,
        )
        // The decider contract never rejects; belt-and-braces for a stub.
        .catch(() => null);
      // Liveness re-check after the await: any turnCanSpeakFiller condition
      // may have flipped while generating, mooting the ack. A null generation
      // (no provider, timeout, unusable output) speaks nothing. Either way,
      // undo the optimistic ackSpoken so the flag reflects reality and a
      // later trigger this turn can still hold the floor.
      if (generated === null || !this.turnCanSpeakFiller(activeTurn)) {
        activeTurn.ackSpoken = false;
        return;
      }
      this.enqueueAckPhrase(activeTurn, generated, kind);
    } finally {
      activeTurn.ackGenerationPending = false;
    }
  }

  // Records the ack-spoken metric only when a phrase actually enqueues; a
  // phrase that sanitizes away releases the turn's ack budget again.
  private enqueueAckPhrase(
    activeTurn: ActiveAssistantTurn,
    raw: string,
    kind: LiveVoiceSpokenAckKind,
  ): void {
    if (this.enqueueFillerPhrase(activeTurn, raw)) {
      this.markAckSpoken(activeTurn, kind);
      return;
    }
    activeTurn.ackSpoken = false;
  }

  // Sanitize and enqueue one filler sentence (spoken ack or progress
  // narration) on the turn's ordered TTS queue — the shared tail of every
  // filler path. Returns whether a phrase actually enqueued; per-kind metric
  // marks and bookkeeping are the caller's.
  private enqueueFillerPhrase(turn: ActiveAssistantTurn, raw: string): boolean {
    const phrase = sanitizeForTts(raw).trim();
    if (phrase.length === 0) {
      return false;
    }
    this.enqueueTtsSegment(turn.token, phrase, {
      countsAsFirstSegment: false,
    });
    // A spoken filler holds the floor, so narration's minGapMs spaces from it.
    turn.progress.lastFloorHolderAtMs = Date.now();
    return true;
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

    this.clearFillerTimers(activeTurn);
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

        // Drain-scoped minimize: the latched marker is consumed here, after
        // the turn's speech has fully drained — never mid-speech, never for
        // a barged-in turn, at most once per turn.
        if (
          currentTurn.minimizeRequested &&
          !currentTurn.abortController.signal.aborted
        ) {
          currentTurn.minimizeRequested = false;
          await this.sendFrame(
            { type: "minimize_room", turnId: currentTurn.turnId },
            () => !this.isClosed,
          );
        }

        if (currentTurn.handle && currentTurn.finalized) {
          this.clearActiveAssistantTurn(token);
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

  private enqueueTtsSegment(
    token: symbol,
    segment: string,
    options: { countsAsFirstSegment?: boolean } = {},
  ): void {
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token || !this.streamTtsAudio) {
      return;
    }

    // A spoken ack (countsAsFirstSegment: false) leaves the eager
    // first-clause flush available for the model's real first segment.
    if (options.countsAsFirstSegment ?? true) {
      activeTurn.ttsSegmentEnqueued = true;
    }
    const job: TtsSegmentJob = {
      text: segment,
      started: false,
      settled: false,
      emitting: false,
      bufferedChunks: [],
      synthesis: null,
      frames: Promise.resolve(),
    };
    activeTurn.ttsJobs.push(job);
    this.pumpTtsSynthesis(token);
    activeTurn.ttsQueue = activeTurn.ttsQueue
      .catch(() => {})
      .then(() => this.emitTtsJob(token, job));
  }

  // Starts provider streams for queued jobs, in list order, while an
  // open-job slot is free. The prefetching job's chunks buffer in memory
  // until the emission chain promotes it, so the next segment's provider
  // first-chunk latency overlaps the current segment's playback.
  private pumpTtsSynthesis(token: symbol): void {
    const activeTurn = this.activeAssistantTurn;
    const streamTtsAudio = this.streamTtsAudio;
    if (
      activeTurn?.token !== token ||
      !streamTtsAudio ||
      activeTurn.abortController.signal.aborted ||
      this.isClosed
    ) {
      return;
    }

    while (
      activeTurn.ttsJobs.filter((job) => job.started && !job.settled).length <
      TTS_MAX_OPEN_SYNTHESIS_JOBS
    ) {
      const job = activeTurn.ttsJobs.find((candidate) => !candidate.started);
      if (!job) {
        return;
      }
      job.started = true;
      let synthesis: Promise<void>;
      try {
        synthesis = streamTtsAudio({
          text: job.text,
          signal: activeTurn.abortController.signal,
          outputFormat: "pcm",
          sampleRate: this.context.startFrame.audio.sampleRate,
          onAudioChunk: (chunk) => {
            if (!this.isForwardingTts(token)) {
              return;
            }
            if (job.emitting) {
              this.forwardTtsChunk(token, job, chunk);
            } else {
              job.bufferedChunks.push(chunk);
            }
          },
        }).then(() => undefined);
      } catch (err) {
        synthesis = Promise.reject(err);
      }
      // The job's emission step observes the rejection; this handler only
      // keeps a failure on an already-cancelled turn from surfacing as an
      // unhandled rejection.
      synthesis.catch(() => {});
      job.synthesis = synthesis;
    }
  }

  // Emission slot for one job, run in strict segment order on the turn's
  // ttsQueue chain: promotes the job from prefetch to live, flushes what it
  // buffered, and returns only once every frame write for the job is ordered
  // ahead of the next segment's.
  private async emitTtsJob(token: symbol, job: TtsSegmentJob): Promise<void> {
    try {
      const currentTurn = this.activeAssistantTurn;
      if (
        currentTurn?.token !== token ||
        currentTurn.abortController.signal.aborted
      ) {
        // The turn is gone: release the prefetched audio immediately rather
        // than holding it until the turn object drops.
        job.bufferedChunks.length = 0;
        return;
      }

      // Both slots can be busy when a job is enqueued; every earlier job has
      // settled once it reaches the head of the chain, so a slot is free.
      if (!job.started) {
        this.pumpTtsSynthesis(token);
      }

      // Promote synchronously: no provider callback can land between the
      // flag flip and the buffered flush, so flushed and live chunks stay in
      // provider order on the job's frame chain.
      job.emitting = true;
      for (const chunk of job.bufferedChunks.splice(0)) {
        this.forwardTtsChunk(token, job, chunk);
      }

      let failed = false;
      let synthesisError: unknown;
      try {
        await job.synthesis;
      } catch (err) {
        failed = true;
        synthesisError = err;
      }
      // The provider stream has settled, so the frame chain is complete;
      // awaiting it puts every frame of this segment ahead of the next.
      await job.frames;

      if (failed && this.isForwardingTts(token)) {
        // Per-segment failure: the turn (and session) continue, so the
        // error is recoverable for the client.
        await this.sendFrame(
          {
            type: "error",
            code: LiveVoiceProtocolErrorCode.InvalidField,
            message: `Live voice TTS failed: ${errorMessage(synthesisError)}`,
            recoverable: true,
          },
          () => this.isForwardingTts(token),
        );
      }
    } finally {
      job.settled = true;
      const settledTurn = this.activeAssistantTurn;
      if (settledTurn?.token === token) {
        // Anchor the dead-air countdown to the end of emission; the playback
        // -tail estimate covers any client-side buffer still draining.
        settledTurn.progress.lastAudibleAtMs = Date.now();
      }
      this.pumpTtsSynthesis(token);
    }
  }

  private forwardTtsChunk(
    token: symbol,
    job: TtsSegmentJob,
    chunk: LiveVoiceTtsAudioChunk,
  ): void {
    if (!this.isForwardingTts(token)) {
      return;
    }
    const activeTurn = this.activeAssistantTurn;
    if (activeTurn?.token !== token) {
      return;
    }
    // Only retain the assistant TTS audio when it will be archived (see
    // collectUserAudio); the mime/sample-rate are cheap and left unconditional.
    if (this.archiveAudio) {
      activeTurn.assistantAudioChunks.push(
        Buffer.from(chunk.dataBase64, "base64"),
      );
    }
    activeTurn.assistantAudioMimeType = chunk.contentType;
    activeTurn.assistantAudioSampleRate = chunk.sampleRate;
    job.frames = job.frames.then(async () => {
      const sent = await this.sendFrame(
        {
          type: "tts_audio",
          mimeType: chunk.contentType,
          sampleRate: chunk.sampleRate,
          dataBase64: chunk.dataBase64,
        },
        () => this.isForwardingTts(token),
      );
      // Skip a frame that wasn't actually written — a backed-up outbound
      // queue hasn't reached the client, so it must not extend the
      // playback-tail estimate or latch first-audio state. Token match keeps
      // a stale turn's late send from latching a newer turn.
      if (!sent) {
        return;
      }
      // Extend the client playback-tail estimate by this chunk's PCM
      // duration (chunks queue gaplessly client-side, so the tail grows
      // from whichever is later: now or the current estimate).
      const chunkMs = pcm16DurationMs(
        Buffer.byteLength(chunk.dataBase64, "base64"),
        chunk.sampleRate,
      );
      const now = Date.now();
      this.assistantPlaybackTailUntilMs =
        Math.max(now, this.assistantPlaybackTailUntilMs) + chunkMs;
      const turnAfterSend = this.activeAssistantTurn;
      if (turnAfterSend?.token !== token || turnAfterSend.ttsAudioStarted) {
        return;
      }
      turnAfterSend.ttsAudioStarted = true;
      this.metrics.markFirstTtsAudio(turnAfterSend.turnId);
    });
  }

  private collectUserAudio(utterance: UtteranceCycle, chunk: Buffer): void {
    // Only retain the raw audio when it will actually be archived — otherwise
    // buffering a whole turn's PCM is dead memory. The first-audio metric is
    // independent of archiving, so it stays unconditional.
    if (this.archiveAudio) {
      utterance.userAudioChunks.push(Buffer.from(chunk));
    }
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

  // First-wins across an utterance's hold replays: the anchor stays at the
  // FIRST dispatch, so the dispatch-anchored durations include the hold
  // pipeline the caller actually sat through.
  private markAssistantDispatch(
    utterance: UtteranceCycle,
    turnId: string,
  ): void {
    if (!this.startMetricsTurnIfNeeded(utterance, turnId)) {
      return;
    }
    this.metrics.markAssistantDispatch(turnId);
  }

  private markEndpointDecision(
    utterance: UtteranceCycle,
    action: VoiceEndpointAction,
    latencyMs: number,
  ): void {
    const turnId = this.ensureTurnId(utterance);
    if (!this.startMetricsTurnIfNeeded(utterance, turnId)) {
      return;
    }
    this.metrics.markEndpointDecision(turnId, { action, latencyMs });
  }

  private markAckSpoken(
    activeTurn: ActiveAssistantTurn,
    kind: LiveVoiceSpokenAckKind,
  ): void {
    const { utterance } = activeTurn;
    if (!this.startMetricsTurnIfNeeded(utterance, activeTurn.turnId)) {
      return;
    }
    this.metrics.markAckSpoken(activeTurn.turnId, kind);
  }

  private markProgressSpoken(activeTurn: ActiveAssistantTurn): void {
    const { utterance } = activeTurn;
    if (!this.startMetricsTurnIfNeeded(utterance, activeTurn.turnId)) {
      return;
    }
    this.metrics.markProgressSpoken(activeTurn.turnId);
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
    // An utterance that finalizes here never became a turn (empty transcript,
    // client interrupt, transcriber close, error), so it ends the window a
    // barge-in's merge context was waiting to attach to. Drop that context so
    // it can't leak into a later, unrelated turn. The barged turn itself
    // finalizes through finalizeAssistantTurn, not here, so this never clears a
    // request that the barge-in follow-up turn is still about to consume.
    this.pendingInterruptedRequest = null;
    // `pendingContinuationResult` is deliberately NOT cleared here. Unlike the
    // merge context (bound to the immediate barge-in follow-up), a completed
    // continuation's answer targets the next REAL turn, and hands-free server-VAD
    // routinely discards noise/empty-transcript utterances between turns; wiping
    // it on each such discard would frequently drop a valid result before the
    // user's next question. It is bounded instead by consume-once, the hard-stop
    // clear (abortDetachedRuns), and the model's "use only if relevant" framing.
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
    this.clearFillerTimers(turn);
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
      this.clearActiveAssistantTurn(turn.token);
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
    code: LiveVoiceProtocolErrorCode,
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
  // turn / 60 ms barge-in guard), so an unset config leaves behavior
  // unchanged. Optional-chained
  // because hand-built test configs may predate the liveVoice namespace;
  // absent config falls through to the in-code defaults.
  const liveVoiceConfig = getConfig().liveVoice;
  const vadConfig = liveVoiceConfig?.vad;
  // Parsed once here into a complete config, shared by the decider and the
  // session (the constructor's own parse is then a no-op re-validation).
  const frontModelConfig = LiveVoiceFrontModelConfigSchema.parse(
    options.frontModelConfig ?? liveVoiceConfig?.frontModel ?? {},
  );
  return new LiveVoiceSession(context, {
    ...options,
    turnDetectorConfig:
      options.turnDetectorConfig ??
      (vadConfig
        ? {
            silenceThresholdMs: vadConfig.silenceThresholdMs,
            maxTurnDurationMs: vadConfig.maxTurnDurationMs,
          }
        : {}),
    speechEnergyThreshold:
      options.speechEnergyThreshold ?? vadConfig?.speechEnergyThreshold,
    bargeInMinSpeechMs:
      options.bargeInMinSpeechMs ?? vadConfig?.bargeInMinSpeechMs,
    frontModelConfig,
    // Eager construction is safe even when the `liveVoice.frontModel` config
    // namespace is absent — schema defaults fill the tunables. An explicit
    // option (incl. `null`) always wins — the test seam.
    frontDecider:
      options.frontDecider !== undefined
        ? options.frontDecider
        : createVoiceFrontDecider({ config: frontModelConfig }),
    resolveCredentialReadiness:
      options.resolveCredentialReadiness === undefined
        ? defaultResolveLiveVoiceCredentialReadiness
        : options.resolveCredentialReadiness,
    startVoiceTurn: options.startVoiceTurn ?? defaultStartVoiceTurn,
    streamTtsAudio:
      options.streamTtsAudio === undefined
        ? defaultStreamLiveVoiceTtsAudio
        : options.streamTtsAudio,
    spawnBackgroundContinuation:
      options.spawnBackgroundContinuation ?? defaultSpawnBackgroundContinuation,
    getTurnTeardown: options.getTurnTeardown ?? getConversationTurnTeardown,
    // Off by default (see the `liveVoice.archiveAudio` schema): voice turns
    // persist only their transcribed text, so the recorded audio never lands
    // as an attachment on the conversation messages. Enable via config for
    // playback/debugging. An explicit option (incl. `null`) always wins — the
    // test seam and any future caller override.
    archiveAudio:
      options.archiveAudio === undefined
        ? liveVoiceConfig?.archiveAudio
          ? defaultArchiveLiveVoiceAudio
          : null
        : options.archiveAudio,
    emitMetrics: options.emitMetrics ?? true,
  });
}

// Forks the live voice conversation into a background subagent that continues
// the interrupted turn. The fork inherits the conversation's current messages
// (which include the interrupted turn's completed tool calls after teardown),
// so it resumes without repeating them. Uses spawnAndAwait (synchronous mode)
// so the terminal parent-notification is skipped — the run itself says nothing;
// its final answer is RETURNED so the session decides how it reaches the user.
// The `signal` aborts the child on a stop/interrupt (spawnAndAwait then
// rejects).
//
// Exported for tests only: every production caller reaches it through the
// `spawnBackgroundContinuation` option default in `createLiveVoiceSession`.
export async function defaultSpawnBackgroundContinuation(args: {
  parentConversationId: string;
  objective: string;
  label: string;
  signal: AbortSignal;
}): Promise<string> {
  // Trust first, before anything can hydrate: the bridge stamps trust per-turn
  // and clears it at teardown, which has settled by now — inheriting from the
  // parent would read the cleared window and run the continuation fail-closed
  // as `unknown`, denying every consequential tool. Resolve the same guardian
  // trust the foreground turn ran under and pass it explicitly (resolution
  // itself stays fail-closed: on a miss the continuation runs as `unknown`,
  // exactly as an unstamped turn does).
  const trustContext = await resolveLocalLiveVoiceTrustContext(
    args.parentConversationId,
  );
  // getOrCreateConversation (not a raw registry read): it rebuilds a stale
  // instance and awaits loadFromDb, so the snapshot below sees the persisted
  // history. A raw findConversation can return a cold instance whose in-memory
  // `messages` is empty, which silently forks a continuation with no context.
  const { getOrCreateConversation } =
    await import("../daemon/conversation-store.js");
  const parentConversation = await getOrCreateConversation(
    args.parentConversationId,
  );
  // Hydration runs under the resolved trust: `loadFromDb` filters history by
  // the instance's own trust class, so a load with no trust context drops
  // memory blocks and forces the compaction summary to null — the fork would
  // inherit a lobotomized snapshot. Stamp for the duration of the load and
  // restore the prior value, the same set-load-restore idiom
  // `elevatePointerConversationToGuardian` uses to un-filter a cold pointer
  // turn. The restore matters: the bridge owns this conversation's trust
  // per-turn and expects the window between turns to be empty.
  //
  // `ensureActorScopedHistory` reloads exactly when the resident history was
  // loaded under a different trust class — covering both the never-loaded cold
  // instance and the untrusted load `getOrCreateConversation` may have just
  // run — and no-ops when the history is already guardian-scoped. Without a
  // guardian to stamp there is nothing to re-scope, so an unhydrated instance
  // falls back to a plain load; a genuinely new conversation reads zero rows,
  // harmless.
  const priorTrustContext = parentConversation.trustContext;
  if (trustContext) {
    const stampedTrustContext = { ...trustContext };
    parentConversation.setTrustContext(stampedTrustContext);
    try {
      await parentConversation.ensureActorScopedHistory();
    } finally {
      // Only undo the stamp this block installed: the user's next foreground
      // turn can start during the load and stamp its own trust, and clearing
      // that would run the live turn fail-closed.
      if (parentConversation.trustContext === stampedTrustContext) {
        parentConversation.setTrustContext(priorTrustContext ?? null);
      }
    }
  } else if (parentConversation.getMessages().length === 0) {
    await parentConversation.loadFromDb();
  }
  return await getSubagentManager().spawnAndAwait(
    {
      parentConversationId: args.parentConversationId,
      label: args.label,
      objective: args.objective,
      fork: true,
      sendResultToUser: false,
      // Full subagent abilities: the continuation runs like any other
      // background subagent, so it can genuinely finish build-shaped work
      // (JARVIS-1354). Side effects are governed by the standard
      // non-interactive permission path under the explicit trust context
      // resolved above — auto-approved up to the background risk threshold,
      // auto-denied above it — the same policy the foreground voice turn it
      // continues ran under. Workspace write races with the user's next
      // foreground turn are prevented by the session's foreground-wins abort
      // (a side-effecting tool start on a live turn aborts running
      // continuations; see the tool_use_start handler).
      ...(trustContext ? { trustContext } : {}),
      parentMessages: [...parentConversation.getMessages()],
      parentSystemPrompt: parentConversation.getCurrentSystemPrompt(),
    },
    // Broadcast subagent events to clients attached to this conversation so
    // the continuation appears in the UI like any other handoff — a background
    // run the user cannot see reads as the assistant silently dropping their
    // work. "Silent" means the RUN makes no sound of its own — its result is
    // spoken by a session turn, on the session's terms; it was never meant to
    // mean invisible.
    //
    // NOT the conversation's own sender: the voice bridge resets that to a
    // no-op at turn teardown (see voice-session-bridge's clientCallbackInstalled
    // reset), and the detach deliberately waits for that teardown before
    // spawning — so a sender-based route is guaranteed to be dead by the time
    // these events fire. `broadcastMessage` is the same path the bridge itself
    // uses to reach an attached web client. The subagent events carry
    // `parentConversationId`, not `conversationId`, so scope explicitly.
    (msg) => broadcastMessage(msg, args.parentConversationId),
    { signal: args.signal },
  );
}

async function defaultResolveStreamingTranscriber(
  options: ResolveStreamingTranscriberOptions,
): Promise<StreamingTranscriber | null> {
  const { resolveEffectiveSpeechProviders } =
    await import("../config/managed-speech-defaults.js");
  const { resolveStreamingTranscriber } =
    await import("../providers/speech-to-text/resolve.js");
  const { stt } = await resolveEffectiveSpeechProviders();
  return resolveStreamingTranscriber({ ...options, providerId: stt });
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
  // Stamp the turn with the guardian's trust context — the same resolution the
  // text-send route runs for a local vellum principal. A local live-voice
  // session only exists for the guardian's own authenticated client (the
  // gateway pins the `/v1/live-voice` upgrade to the bound guardian), but the
  // live-voice ingress bypasses the send-message route, so without this stamp
  // the turn resolved to the fail-closed `unknown` trust class and every
  // sensitive tool was denied. Resolution stays fail-closed: a gateway miss /
  // missing binding leaves the context unset (`unknown`), never a blind grant.
  const trustStartedAt = performance.now();
  const trustContext = await resolveLocalLiveVoiceTrustContext(
    options.conversationId,
  );
  const trustMs = Math.round(performance.now() - trustStartedAt);
  const { startVoiceTurn } = await import("../calls/voice-session-bridge.js");
  log.info(
    {
      conversationId: options.conversationId,
      trustMs,
      sinceLaunchMs:
        options.launchedAtMs != null ? Date.now() - options.launchedAtMs : null,
    },
    "Voice turn pre-bridge timing",
  );
  return startVoiceTurn({
    ...options,
    ...(trustContext ? { trustContext } : {}),
  });
}

/**
 * Resolve the local guardian's {@link TrustContext} for a live-voice turn, or
 * `undefined` when it cannot be established (no vellum guardian binding, or
 * the gateway is unreachable) — the turn then runs under the fail-closed
 * `unknown` capability set, exactly as an unstamped turn does.
 */
async function resolveLocalLiveVoiceTrustContext(
  conversationId: string,
): Promise<TrustContext | undefined> {
  const { findLocalGuardianPrincipalId } =
    await import("../runtime/local-actor-identity.js");
  const { resolveLocalPrincipalTrustContext } =
    await import("../runtime/local-principal-trust.js");
  const guardianPrincipalId = await findLocalGuardianPrincipalId();
  if (!guardianPrincipalId) {
    return undefined;
  }
  const trustContext = await resolveLocalPrincipalTrustContext({
    actorPrincipalId: guardianPrincipalId,
    sourceChannel: "vellum",
    conversationExternalId: conversationId,
  });
  // Only stamp a positive guardian resolution; the resolver's own
  // fail-closed `unknown` carries no more information than no stamp.
  return trustContext.trustClass === "guardian" ? trustContext : undefined;
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

// Duration (ms) of PCM16 mono audio: 2 bytes per sample.
function pcm16DurationMs(byteLength: number, sampleRate: number): number {
  return (byteLength / 2 / sampleRate) * 1_000;
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

  return Math.round(pcm16DurationMs(input.byteLength, input.sampleRate));
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
