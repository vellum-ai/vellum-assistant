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
  TranscriptChunkEvent,
} from "@vellumai/meet-contracts";

import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import type { Provider, ToolDefinition } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
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
   * repo-wide provider abstraction using {@link CONSENT_LLM_MAX_TOKENS} and
   * `modelIntent: "latency-optimized"`. Tests inject scripted responses.
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

  /** In-flight flag so overlapping keyword hits don't fan out LLM calls. */
  private llmInFlight = false;

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
      ((handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>));
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

    const speaker =
      event.speakerLabel ?? event.speakerId ?? "Unknown speaker";
    const entry: TranscriptEntry = {
      tMs: this.now(),
      timestamp: event.timestamp,
      speaker,
      text: raw,
    };
    this.transcriptBuffer.push(entry);
    this.trimTranscriptBuffer();

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

    if (this.matchesKeyword(raw)) {
      void this.maybeRunLLMCheck("keyword:chat");
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
   */
  private async maybeRunLLMCheck(trigger: string): Promise<void> {
    if (this.decided || this.llmInFlight) return;
    // Don't call the LLM on the tick path when both buffers are empty.
    if (
      trigger === "tick" &&
      this.transcriptBuffer.length === 0 &&
      this.chatBuffer.length === 0
    ) {
      return;
    }

    const prompt = this.buildPrompt();
    this.llmInFlight = true;
    try {
      const decision = await this.llmAsk(prompt);
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
        : this.chatBuffer
            .map((e) => `${e.fromName}: ${e.text}`)
            .join("\n");
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
 * abstraction with `modelIntent: "latency-optimized"`, times out at
 * {@link CONSENT_LLM_TIMEOUT_MS}, and extracts the tool-use input as the
 * structured verdict.
 *
 * Hidden behind an injectable hook so tests never need to stand up a
 * real provider.
 */
async function defaultLLMAsk(prompt: string): Promise<ObjectionDecision> {
  const provider: Provider | null = await getConfiguredProvider();
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
          modelIntent: "latency-optimized",
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
