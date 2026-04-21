/**
 * MeetConsentMonitor — watches transcript and inbound chat for signals that a
 * participant does not want an AI note-taker in the meeting, and (when the
 * `autoLeaveOnObjection` config flag is enabled) auto-invokes
 * {@link MeetSessionManager.leave} on confirmation.
 *
 * Design:
 *
 *   1. **Fast path (deterministic)** — every inbound `TranscriptChunkEvent`
 *      (finals only) and `InboundChatEvent` is lowercased and substring-
 *      checked against `config.objectionKeywords`. A hit flags the event
 *      for LLM confirmation; a miss simply buffers it for future context.
 *
 *   2. **Slow path (model-mediated)** — the rolling buffer (~30s of
 *      transcript + last 5 chat messages) is sent to a latency-optimized
 *      LLM call on every keyword hit, plus on a 20s timer cadence as a
 *      safety net for phrasing the keyword list missed. The model returns
 *      strict JSON `{ "objected": boolean, "reason": string }`.
 *
 *   3. **One decision per meeting** — as soon as the LLM returns
 *      `objected: true`, the monitor disables further checks. If
 *      `autoLeaveOnObjection` is true it invokes
 *      `sessionManager.leave(meetingId, "objection: " + reason)`. If false
 *      (dev/debug mode) the decision is logged but no leave is triggered.
 *
 * Dedupe: back-to-back identical chunks (same raw text) within a 5s window
 * are collapsed so a repeated ASR chunk can't re-trigger the LLM path.
 *
 * Dependency injection keeps this testable: the LLM is reached via an
 * `llmAsk(prompt)` callable; tests pass scripted responses. The subscribe
 * hook defaults to the real dispatcher but can be swapped for an in-memory
 * shim. The session-manager handle only needs a `leave(meetingId, reason)`
 * method — the real {@link MeetSessionManager} satisfies this naturally.
 */

import type {
  InboundChatEvent,
  MeetBotEvent,
  ParticipantChangeEvent,
  TranscriptChunkEvent,
} from "../contracts/index.js";

import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../../assistant/src/providers/provider-send-message.js";
import type {
  Provider,
  ToolDefinition,
} from "../../../assistant/src/providers/types.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";

const log = getLogger("meet-consent-monitor");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Sliding-window length for the rolling transcript buffer. */
export const TRANSCRIPT_WINDOW_MS = 30_000;

/** How many recent chat messages are kept for LLM context. */
export const CHAT_BUFFER_SIZE = 5;

/** Timer cadence for the safety-net LLM check. */
export const LLM_TICK_INTERVAL_MS = 20_000;

/** Window used to dedupe identical chunks. */
export const DEDUPE_WINDOW_MS = 5_000;

/**
 * Minimum wall-clock interval between consecutive LLM checks regardless of
 * trigger source (timer tick or fast-keyword hit). Acts as a coarse rate
 * limiter so e.g. three keyword-matching utterances in quick succession
 * collapse to a single LLM call. Intentionally not exposed via config —
 * making this tunable is premature until production data justifies it.
 *
 * Worst-case objection latency with this debounce in place:
 *   8s (debounce window) + 20s (next timer tick) = 28s, comfortably under
 *   the 30s correctness invariant.
 */
export const LLM_CHECK_DEBOUNCE_MS = 8_000;

/** LLM call timeout — keeps the consent path bounded. */
export const CONSENT_LLM_TIMEOUT_MS = 5_000;

/** Max tokens for the LLM structured response. */
export const CONSENT_LLM_MAX_TOKENS = 256;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the JSON the LLM returns. */
export interface ObjectionDecision {
  objected: boolean;
  reason: string;
}

/**
 * The minimal handle the monitor needs on the session manager. The real
 * {@link MeetSessionManager} satisfies this.
 */
export interface MeetSessionLeaver {
  leave(meetingId: string, reason: string): Promise<void>;
}

/** Callable returning a strict-JSON objection verdict for a prompt. */
export type ObjectionLLMAsk = (prompt: string) => Promise<ObjectionDecision>;

export interface MeetConsentMonitorConfig {
  autoLeaveOnObjection: boolean;
  objectionKeywords: readonly string[];
}

export interface MeetConsentMonitorDeps {
  meetingId: string;
  assistantId: string;
  sessionManager: MeetSessionLeaver;
  config: MeetConsentMonitorConfig;
  /**
   * Ask the LLM for an objection verdict. Defaults to a wrapper around the
   * repo-wide provider abstraction using {@link CONSENT_LLM_MAX_TOKENS}
   * under the `meetConsentMonitor` call site. Tests inject scripted
   * responses.
   */
  llmAsk?: ObjectionLLMAsk;
  /** Override the dispatcher subscribe (tests). */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /** Override setTimeout/clearTimeout for tests that capture the timer. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Override `Date.now` for tests that want deterministic dedupe timing. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Rolling buffers
// ---------------------------------------------------------------------------

interface TranscriptEntry {
  tMs: number;
  timestamp: string;
  speaker: string;
  text: string;
}

interface ChatEntry {
  timestamp: string;
  fromName: string;
  text: string;
}

// ---------------------------------------------------------------------------
// MeetConsentMonitor
// ---------------------------------------------------------------------------

export class MeetConsentMonitor {
  private readonly meetingId: string;
  private readonly assistantId: string;
  private readonly sessionManager: MeetSessionLeaver;
  private readonly config: MeetConsentMonitorConfig;
  private readonly llmAsk: ObjectionLLMAsk;
  private readonly subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly now: () => number;

  private unsubscribe: MeetEventUnsubscribe | null = null;
  private timerHandle: unknown = null;

  /**
   * Transcript entries within the rolling {@link TRANSCRIPT_WINDOW_MS}. Old
   * entries are trimmed on each append.
   */
  private transcriptBuffer: TranscriptEntry[] = [];

  /**
   * Last {@link CHAT_BUFFER_SIZE} chat entries. FIFO.
   */
  private chatBuffer: ChatEntry[] = [];

  /**
   * Dedupe ledger: hash(`<kind>:<text>`) → last-seen timestamp (ms). Used
   * to collapse back-to-back identical chunks within
   * {@link DEDUPE_WINDOW_MS}.
   */
  private readonly recentHashes = new Map<string, number>();

  /** Flips to true after the first positive objection verdict. */
  private decided = false;

  /** Flips to true when `stop()` is called so in-flight LLM verdicts are discarded. */
  private stopped = false;

  /** In-flight flag so overlapping keyword hits don't fan out LLM calls. */
  private llmInFlight = false;

  /**
   * Monotonic timestamp (`this.now()`) of the most recent content-bearing
   * event: a final transcript chunk from a non-bot speaker, an inbound
   * chat message (the bot's own outbound chat is already stripped upstream
   * by the chat reader's self-filter), or a `participant.change` with a
   * non-bot joiner. Compared against {@link lastLlmCheckContentTimestamp}
   * on every timer tick to decide whether any new objection signal has
   * actually arrived since the last LLM check.
   */
  private lastContentTimestamp: number | null = null;

  /**
   * Value of {@link lastContentTimestamp} at the moment the LLM check last
   * fired (or `null` before the first check). When a timer tick finds
   * `lastContentTimestamp === lastLlmCheckContentTimestamp` it means no
   * content-bearing event has arrived since the previous LLM call, so the
   * tick is skipped. Both trigger paths (tick and keyword) advance this
   * watermark when they actually fire an LLM call — a keyword-fired call
   * must also make the next tick a no-op if no new content arrives, since
   * the keyword-path call already saw the current buffer. The tick path
   * is still the only path that consults the watermark; keyword-triggered
   * calls always fire (subject to the debounce).
   */
  private lastLlmCheckContentTimestamp: number | null = null;

  /**
   * The bot's own participant id, discovered lazily from the first
   * `participant.change` event whose `joined[].isSelf === true`. Used to
   * drop transcript chunks whose resolved speaker id matches the bot (the
   * bot is a silent listener, so this should never happen in practice, but
   * cheap defense-in-depth keeps the watermark honest if an ASR pipeline
   * mis-tags a chunk).
   */
  private botParticipantId: string | null = null;

  /**
   * Wall-clock timestamp (`this.now()`) of the most recent LLM check
   * regardless of trigger source. Set on entry to {@link maybeRunLLMCheck}
   * before the async LLM call begins so concurrent triggers within the
   * debounce window collapse to a single call. Compared against
   * {@link LLM_CHECK_DEBOUNCE_MS} on every potential LLM-firing path
   * (tick AND keyword) — both guards (this debounce and the content
   * watermark) apply independently and either can short-circuit a call.
   *
   * On LLM failure the previous value is restored so a failed call does
   * not burn the debounce window — the monitor's resilience contract is
   * that it can retry on the very next trigger after a failure.
   */
  private lastLlmCheckAt: number | null = null;

  constructor(deps: MeetConsentMonitorDeps) {
    this.meetingId = deps.meetingId;
    this.assistantId = deps.assistantId;
    this.sessionManager = deps.sessionManager;
    this.config = deps.config;
    this.llmAsk = deps.llmAsk ?? defaultLLMAsk;
    this.subscribe = deps.subscribe ?? subscribeToMeetingEvents;
    this.setIntervalFn =
      deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn =
      deps.clearIntervalFn ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Begin observing the meeting. Idempotent.
   *
   * Subscribes to the dispatcher so the monitor coexists with the bridge,
   * storage writer, and event-hub publisher. Starts a 20s safety-net timer
   * that invokes the LLM path with whatever's in the buffers — this
   * catches objection phrases the keyword list didn't anticipate.
   */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.subscribe(this.meetingId, (event) =>
      this.onEvent(event),
    );
    this.timerHandle = this.setIntervalFn(() => {
      // Fire-and-forget — callers never await the tick.
      void this.maybeRunLLMCheck("tick");
    }, LLM_TICK_INTERVAL_MS);
  }

  /**
   * Tear down the subscription and timer. Idempotent.
   */
  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetConsentMonitor: unsubscribe threw during stop",
        );
      }
      this.unsubscribe = null;
    }
    if (this.timerHandle !== null) {
      try {
        this.clearIntervalFn(this.timerHandle);
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetConsentMonitor: clearInterval threw during stop",
        );
      }
      this.timerHandle = null;
    }
  }

  // ── Event handling ────────────────────────────────────────────────────────

  private onEvent(event: MeetBotEvent): void {
    if (this.decided) return;
    try {
      if (event.type === "transcript.chunk") {
        this.onTranscriptChunk(event);
        return;
      }
      if (event.type === "chat.inbound") {
        this.onInboundChat(event);
        return;
      }
      if (event.type === "participant.change") {
        this.onParticipantChange(event);
        return;
      }
    } catch (err) {
      log.warn(
        { err, meetingId: this.meetingId, eventType: event.type },
        "MeetConsentMonitor: event handler threw",
      );
    }
  }

  private onTranscriptChunk(event: TranscriptChunkEvent): void {
    if (!event.isFinal) return;
    const raw = event.text ?? "";
    if (raw.trim().length === 0) return;

    if (this.isDuplicate("t", raw)) return;

    const speaker = event.speakerLabel ?? event.speakerId ?? "Unknown speaker";
    const entry: TranscriptEntry = {
      tMs: this.now(),
      timestamp: event.timestamp,
      speaker,
      text: raw,
    };
    this.transcriptBuffer.push(entry);
    this.trimTranscriptBuffer();

    // Content-bearing for the tick-skip watermark iff the speaker is not
    // the bot itself. The bot is a silent listener, so `speakerId ===
    // botParticipantId` should be vanishingly rare — we guard it anyway so
    // a mis-tagged ASR chunk can't falsely advance the watermark.
    if (
      this.botParticipantId === null ||
      event.speakerId === undefined ||
      event.speakerId !== this.botParticipantId
    ) {
      this.lastContentTimestamp = this.now();
    }

    if (this.matchesKeyword(raw)) {
      void this.maybeRunLLMCheck("keyword:transcript");
    }
  }

  private onInboundChat(event: InboundChatEvent): void {
    const raw = event.text ?? "";
    if (raw.trim().length === 0) return;

    if (this.isDuplicate("c", raw)) return;

    const entry: ChatEntry = {
      timestamp: event.timestamp,
      fromName: event.fromName,
      text: raw,
    };
    this.chatBuffer.push(entry);
    while (this.chatBuffer.length > CHAT_BUFFER_SIZE) this.chatBuffer.shift();

    // Every `InboundChatEvent` the monitor receives is already non-self —
    // the in-page chat reader strips the bot's own outbound messages via
    // its `selfName`/`data-is-self` filter before publishing the event.
    // A defensive `fromId === botParticipantId` check is layered on top in
    // case the upstream filter ever regresses.
    if (
      this.botParticipantId === null ||
      event.fromId !== this.botParticipantId
    ) {
      this.lastContentTimestamp = this.now();
    }

    if (this.matchesKeyword(raw)) {
      void this.maybeRunLLMCheck("keyword:chat");
    }
  }

  /**
   * New participants are exactly when a re-check is cheap insurance —
   * someone who hasn't seen the consent disclosure may object immediately.
   * Reset the watermark so the next 20s tick fires an LLM call regardless
   * of whether the new participant has spoken yet. The `isSelf` joiner
   * also gives us the bot's participant id, which is used downstream to
   * ignore bot-tagged transcript chunks.
   *
   * Only `joined.length > 0` is content-bearing — leaves and speaker-tile
   * changes are not, since "someone left" never creates a fresh objection
   * risk the monitor hasn't already seen.
   */
  private onParticipantChange(event: ParticipantChangeEvent): void {
    for (const participant of event.joined) {
      if (participant.isSelf && this.botParticipantId === null) {
        this.botParticipantId = participant.id;
      }
    }
    // Only count *non-bot* joiners as content-bearing: a bot-self rejoin
    // (unusual, but possible on reconnect) is not a new participant who
    // might object.
    const hasNonBotJoiner = event.joined.some(
      (p) => p.isSelf !== true && p.id !== this.botParticipantId,
    );
    if (hasNonBotJoiner) {
      this.lastContentTimestamp = this.now();
    }
  }

  // ── Fast path: keyword + dedupe ───────────────────────────────────────────

  private matchesKeyword(text: string): boolean {
    const lower = text.toLowerCase();
    for (const kw of this.config.objectionKeywords) {
      if (kw && lower.includes(kw.toLowerCase())) return true;
    }
    return false;
  }

  private isDuplicate(kind: "t" | "c", text: string): boolean {
    const key = `${kind}:${text}`;
    const now = this.now();
    const prev = this.recentHashes.get(key);
    if (prev !== undefined && now - prev < DEDUPE_WINDOW_MS) {
      return true;
    }
    this.recentHashes.set(key, now);
    this.pruneRecentHashes(now);
    return false;
  }

  private pruneRecentHashes(now: number): void {
    for (const [key, t] of this.recentHashes) {
      if (now - t >= DEDUPE_WINDOW_MS) this.recentHashes.delete(key);
    }
  }

  private trimTranscriptBuffer(): void {
    const cutoff = this.now() - TRANSCRIPT_WINDOW_MS;
    while (
      this.transcriptBuffer.length > 0 &&
      this.transcriptBuffer[0].tMs < cutoff
    ) {
      this.transcriptBuffer.shift();
    }
  }

  // ── Slow path: LLM confirmation ───────────────────────────────────────────

  /**
   * Run one LLM check over the current buffer if one isn't already in
   * flight and the monitor hasn't already decided. Overlapping calls are
   * collapsed — the buffer the in-flight call saw is sufficient context.
   *
   * Two independent skip guards apply here:
   *   1. **Debounce** ({@link LLM_CHECK_DEBOUNCE_MS}) — applies to ALL
   *      triggers. If less than the debounce window has elapsed since the
   *      last LLM call, skip. The watermark below cannot save the keyword
   *      path on its own, so this guard gives keyword-triggered calls a
   *      coarse rate limit too. On LLM failure this clock is restored so
   *      a failed call does not silently burn the debounce window.
   *   2. **Content watermark** — applies only to tick-driven calls. If
   *      no content-bearing event has arrived since the last LLM check,
   *      skip even if the debounce window has elapsed. Both trigger
   *      paths advance the watermark when they fire, so a keyword-fired
   *      call will correctly make the next tick a no-op.
   *
   * The "already decided to leave" guard short-circuits before either,
   * and intentionally does NOT touch {@link lastLlmCheckAt} — we don't
   * want a stop-and-leave flow to reset debounce state for any future
   * checks (there shouldn't be any, but defense-in-depth).
   */
  private async maybeRunLLMCheck(trigger: string): Promise<void> {
    if (this.decided || this.llmInFlight || this.stopped) return;
    // Don't call the LLM on the tick path when both buffers are empty.
    if (
      trigger === "tick" &&
      this.transcriptBuffer.length === 0 &&
      this.chatBuffer.length === 0
    ) {
      return;
    }

    // Debounce guard: applies to every trigger (tick AND keyword). A
    // string of "please leave" utterances within an 8s window collapses
    // to a single LLM call. Independent of the content watermark below —
    // both guards can skip a call for different reasons.
    const now = this.now();
    if (
      this.lastLlmCheckAt !== null &&
      now - this.lastLlmCheckAt < LLM_CHECK_DEBOUNCE_MS
    ) {
      log.debug(
        {
          event: "consent_monitor.check.debounced",
          meetingId: this.meetingId,
          trigger,
          msSinceLastCheck: now - this.lastLlmCheckAt,
        },
        "MeetConsentMonitor: LLM check debounced",
      );
      return;
    }

    // Content-watermark skip: on a tick, if nothing content-bearing has
    // arrived since the last tick-driven LLM check, skip the call. The
    // keyword path is intentionally excluded — keyword hits always fire
    // (subject to the debounce above).
    if (
      trigger === "tick" &&
      this.lastContentTimestamp === this.lastLlmCheckContentTimestamp
    ) {
      log.debug(
        {
          event: "consent_monitor.timer.skipped_no_new_content",
          meetingId: this.meetingId,
          lastContentTimestamp: this.lastContentTimestamp,
        },
        "MeetConsentMonitor: timer tick skipped — no new non-bot content",
      );
      return;
    }

    // Stamp the debounce clock BEFORE the async LLM call begins so a
    // second trigger arriving while this call is in flight is debounced
    // (in addition to being collapsed by the in-flight flag below).
    // Capture the previous value so we can restore it if the LLM call
    // throws — a failed call must not burn the debounce window, since
    // the resilience contract guarantees the monitor can retry on the
    // next trigger.
    const prevLlmCheckAt = this.lastLlmCheckAt;
    this.lastLlmCheckAt = now;

    // Capture the content timestamp we're about to check so we can
    // advance the watermark only after a successful LLM call. Advancing
    // before the call would prevent retry on failure.
    const contentTimestampAtCheck = this.lastContentTimestamp;

    this.trimTranscriptBuffer();
    const prompt = this.buildPrompt();
    this.llmInFlight = true;
    try {
      const decision = await this.llmAsk(prompt);
      if (this.stopped) return;

      // Advance the content watermark only after a successful LLM call
      // so that a failed call doesn't prevent the next tick from retrying.
      this.lastLlmCheckContentTimestamp = contentTimestampAtCheck;

      if (!decision.objected) {
        log.debug(
          {
            meetingId: this.meetingId,
            trigger,
            reason: decision.reason,
          },
          "MeetConsentMonitor: LLM confirmed no objection",
        );
        return;
      }
      // Positive verdict — lock the monitor and act.
      this.decided = true;
      log.info(
        {
          meetingId: this.meetingId,
          assistantId: this.assistantId,
          trigger,
          reason: decision.reason,
          autoLeave: this.config.autoLeaveOnObjection,
        },
        "MeetConsentMonitor: objection detected",
      );
      if (this.config.autoLeaveOnObjection) {
        try {
          await this.sessionManager.leave(
            this.meetingId,
            `objection: ${decision.reason}`,
          );
        } catch (err) {
          log.error(
            { err, meetingId: this.meetingId },
            "MeetConsentMonitor: session leave failed",
          );
        }
      }
    } catch (err) {
      // Restore the debounce clock on failure so the next trigger is not
      // silently suppressed. The content watermark doesn't need restoring
      // because it's only advanced after a successful LLM call (line above).
      this.lastLlmCheckAt = prevLlmCheckAt;
      log.warn(
        { err, meetingId: this.meetingId, trigger },
        "MeetConsentMonitor: LLM call failed — staying in the meeting",
      );
    } finally {
      this.llmInFlight = false;
    }
  }

  private buildPrompt(): string {
    const chatLines =
      this.chatBuffer.length === 0
        ? "(none)"
        : this.chatBuffer.map((e) => `${e.fromName}: ${e.text}`).join("\n");
    const transcriptLines =
      this.transcriptBuffer.length === 0
        ? "(none)"
        : this.transcriptBuffer
            .map((e) => `${e.speaker}: ${e.text}`)
            .join("\n");
    return (
      "Given this recent chat and transcript from a Google Meet, has any " +
      "participant indicated they do not want an AI note-taker in this " +
      'meeting? Return strictly JSON: { "objected": boolean, "reason": string }.\n\n' +
      "Recent chat:\n" +
      chatLines +
      "\n\nRecent transcript:\n" +
      transcriptLines +
      "\n"
    );
  }

  // ── Test-only introspection ──────────────────────────────────────────────

  /** Exposed for tests: count of transcript entries currently buffered. */
  _bufferedTranscriptCount(): number {
    return this.transcriptBuffer.length;
  }

  /** Exposed for tests: count of chat entries currently buffered. */
  _bufferedChatCount(): number {
    return this.chatBuffer.length;
  }

  /** Exposed for tests: whether the monitor has locked on an objection. */
  _isDecided(): boolean {
    return this.decided;
  }
}

// ---------------------------------------------------------------------------
// Default LLM binding
// ---------------------------------------------------------------------------

/** Tool schema used to force structured JSON output from the LLM. */
const OBJECTION_TOOL: ToolDefinition = {
  name: "report_objection",
  description:
    "Report whether any meeting participant has objected to the AI note-taker's presence.",
  input_schema: {
    type: "object" as const,
    properties: {
      objected: {
        type: "boolean",
        description:
          "True if any participant voiced a clear objection to the AI note-taker; false otherwise.",
      },
      reason: {
        type: "string",
        description:
          "Brief explanation of the objection, or an empty string when no objection was raised.",
      },
    },
    required: ["objected", "reason"],
  },
};

/**
 * Default {@link ObjectionLLMAsk} — routes through the repo-wide provider
 * abstraction under the `meetConsentMonitor` call site, times out at
 * {@link CONSENT_LLM_TIMEOUT_MS}, and extracts the tool-use input as the
 * structured verdict.
 *
 * Hidden behind an injectable hook so tests never need to stand up a
 * real provider.
 */
async function defaultLLMAsk(prompt: string): Promise<ObjectionDecision> {
  const provider: Provider | null =
    await getConfiguredProvider("meetConsentMonitor");
  if (!provider) {
    // No provider available — conservatively assume no objection so the
    // monitor doesn't interrupt a meeting based on missing infra.
    return { objected: false, reason: "" };
  }

  const { signal, cleanup } = createTimeout(CONSENT_LLM_TIMEOUT_MS);
  try {
    const response = await provider.sendMessage(
      [userMessage(prompt)],
      [OBJECTION_TOOL],
      "You are a strict JSON classifier. Only respond via the report_objection tool.",
      {
        config: {
          callSite: "meetConsentMonitor",
          max_tokens: CONSENT_LLM_MAX_TOKENS,
          tool_choice: { type: "tool" as const, name: OBJECTION_TOOL.name },
        },
        signal,
      },
    );
    const tool = extractToolUse(response);
    if (!tool) return { objected: false, reason: "" };
    const input = tool.input as { objected?: unknown; reason?: unknown };
    return {
      objected: input.objected === true,
      reason: typeof input.reason === "string" ? input.reason : "",
    };
  } finally {
    cleanup();
  }
}
