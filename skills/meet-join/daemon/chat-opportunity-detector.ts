/**
 * MeetChatOpportunityDetector — watches meeting transcript and chat for
 * moments when the AI assistant chiming in via meeting chat would be
 * appropriate and helpful. Fires `onOpportunity(reason)` on positive
 * verdicts so a downstream orchestrator (PR 7) can decide what to post.
 *
 * Two-tier design:
 *
 *   1. **Tier 1 (regex fast filter)** — synchronous on every final
 *      transcript chunk and every inbound chat message. Default patterns
 *      cover direct assistant-name mentions, `(hey|hi|…) <name>, … ?` style
 *      address-then-question forms, and generic "can you / does anyone
 *      know" requests. A hit feeds Tier 2 with a short trigger reason.
 *
 *   2. **Tier 2 (LLM confirmation)** — fires on every Tier 1 hit,
 *      subject to a configurable debounce. The prompt includes the
 *      rolling transcript (last N seconds), the most recent 5 chat
 *      messages, the trigger chunk, and the Tier 1 reason, and asks for
 *      strict JSON `{ shouldRespond: boolean, reason: string }`. Positive
 *      verdicts are rate-limited further by an "escalation cooldown" so
 *      a chatty meeting can't fire the callback repeatedly.
 *
 * The detector is intentionally inert until wired: it does not itself
 * post to meeting chat, consult any session manager, or share state with
 * other meetings. PR 7 of the meet-phase-2-chat plan is responsible for
 * plumbing `onOpportunity` into the session manager and actually
 * constructing the chat reply.
 *
 * Dependency injection keeps the detector fully testable: the LLM call
 * is reached via a `callDetectorLLM(prompt)` callable, and the router
 * subscription can be overridden with an in-memory shim.
 */

import type {
  InboundChatEvent,
  MeetBotEvent,
  TranscriptChunkEvent,
} from "../contracts/index.js";

import { getLogger } from "../../../assistant/src/util/logger.js";
import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";

const log = getLogger("meet-chat-opportunity-detector");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the JSON the Tier 2 LLM returns. */
export interface ChatOpportunityDecision {
  shouldRespond: boolean;
  reason: string;
}

/** Tier 2 LLM callable. Tests inject scripted responses. */
export type ChatOpportunityLLMAsk = (
  prompt: string,
) => Promise<ChatOpportunityDecision>;

/** Callback fired when an opportunity clears Tier 2 and cooldown. */
export type ChatOpportunityCallback = (reason: string) => void;

/**
 * Configuration block mirrored from `services.meet.proactiveChat`. Carried
 * independently so this file doesn't depend on the assistant-facing zod
 * schema (which would pull the whole config surface into the skill bundle).
 */
export interface ProactiveChatConfig {
  enabled: boolean;
  detectorKeywords: readonly string[];
  tier2DebounceMs: number;
  escalationCooldownSec: number;
  tier2MaxTranscriptSec: number;
}

/** Stats snapshot exposed to PR 7 for telemetry/debug surfaces. */
export interface ChatOpportunityDetectorStats {
  tier1Hits: number;
  tier2Calls: number;
  tier2PositiveCount: number;
  escalationsFired: number;
  escalationsSuppressed: number;
}

export interface MeetChatOpportunityDetectorDeps {
  meetingId: string;
  /**
   * Display name the bot is using in the meeting. Used to build the
   * default name-mention and addressed-question Tier 1 regexes. Pass the
   * value the bot actually joined with, not the assistant's internal id.
   */
  assistantDisplayName: string;
  config: ProactiveChatConfig;
  callDetectorLLM: ChatOpportunityLLMAsk;
  onOpportunity: ChatOpportunityCallback;
  /** Override the dispatcher subscribe (tests). */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /** Override `Date.now` for deterministic tests. */
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

/** Max chat messages preserved for Tier 2 prompt context. */
const CHAT_BUFFER_SIZE = 5;

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

/** Escape a raw string so it can be embedded as a literal in a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a list of pattern strings into case-insensitive {@link RegExp}
 * instances. Invalid patterns are dropped with a warning log — a single
 * bad entry must not disable the detector.
 */
function compilePatterns(
  patterns: readonly string[],
  meetingId: string,
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    if (!pattern) continue;
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch (err) {
      log.warn(
        { err, pattern, meetingId },
        "MeetChatOpportunityDetector: invalid detector regex — skipping",
      );
    }
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// MeetChatOpportunityDetector
// ---------------------------------------------------------------------------

export class MeetChatOpportunityDetector {
  private readonly meetingId: string;
  private readonly assistantDisplayName: string;
  private readonly config: ProactiveChatConfig;
  private readonly callDetectorLLM: ChatOpportunityLLMAsk;
  private readonly onOpportunity: ChatOpportunityCallback;
  private readonly subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  private readonly now: () => number;

  private unsubscribe: MeetEventUnsubscribe | null = null;

  /** Compiled Tier 1 regexes. Empty when `config.enabled === false`. */
  private readonly patterns: RegExp[];

  private readonly transcriptBuffer: TranscriptEntry[] = [];
  private readonly chatBuffer: ChatEntry[] = [];

  /** Wall-clock ms of the last Tier 2 call (regardless of outcome). */
  private lastTier2CallAt: number | null = null;
  /** Wall-clock ms of the last positive escalation (`shouldRespond: true`). */
  private lastEscalationAt: number | null = null;
  /** In-flight flag so overlapping Tier 1 hits don't race Tier 2 calls. */
  private tier2InFlight = false;

  private readonly stats: ChatOpportunityDetectorStats = {
    tier1Hits: 0,
    tier2Calls: 0,
    tier2PositiveCount: 0,
    escalationsFired: 0,
    escalationsSuppressed: 0,
  };

  constructor(deps: MeetChatOpportunityDetectorDeps) {
    this.meetingId = deps.meetingId;
    this.assistantDisplayName = deps.assistantDisplayName;
    this.config = deps.config;
    this.callDetectorLLM = deps.callDetectorLLM;
    this.onOpportunity = deps.onOpportunity;
    this.subscribe = deps.subscribe ?? subscribeToMeetingEvents;
    this.now = deps.now ?? Date.now;

    this.patterns = this.config.enabled
      ? this.buildPatterns(
          deps.assistantDisplayName,
          this.config.detectorKeywords,
        )
      : [];
  }

  /**
   * Begin observing the meeting. Idempotent. When `config.enabled === false`
   * the detector still subscribes but the event handler short-circuits
   * before any Tier 1 evaluation — this keeps the lifecycle symmetric with
   * `dispose()` and makes the "disabled" telemetry trivially observable
   * (zero tier1Hits).
   */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.subscribe(this.meetingId, (event) =>
      this.onEvent(event),
    );
  }

  /**
   * Tear down the subscription. Idempotent. Matches the lifecycle
   * vocabulary ("dispose") called out in the phase plan.
   */
  dispose(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetChatOpportunityDetector: unsubscribe threw during dispose",
        );
      }
      this.unsubscribe = null;
    }
  }

  /** Snapshot of current detector stats. Callers should not mutate. */
  getStats(): ChatOpportunityDetectorStats {
    return { ...this.stats };
  }

  // ── Event handling ────────────────────────────────────────────────────────

  private onEvent(event: MeetBotEvent): void {
    if (!this.config.enabled) return;
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
        "MeetChatOpportunityDetector: event handler threw",
      );
    }
  }

  private onTranscriptChunk(event: TranscriptChunkEvent): void {
    if (!event.isFinal) return;
    const raw = event.text ?? "";
    if (raw.trim().length === 0) return;

    const speaker = event.speakerLabel ?? event.speakerId ?? "Unknown speaker";
    this.transcriptBuffer.push({
      tMs: this.now(),
      timestamp: event.timestamp,
      speaker,
      text: raw,
    });
    this.trimTranscriptBuffer();

    const reason = this.tier1Match(raw);
    if (reason !== null) {
      this.stats.tier1Hits += 1;
      void this.maybeRunTier2(reason, raw);
    }
  }

  private onInboundChat(event: InboundChatEvent): void {
    const raw = event.text ?? "";
    if (raw.trim().length === 0) return;

    this.chatBuffer.push({
      timestamp: event.timestamp,
      fromName: event.fromName,
      text: raw,
    });
    while (this.chatBuffer.length > CHAT_BUFFER_SIZE) this.chatBuffer.shift();

    const reason = this.tier1Match(raw);
    if (reason !== null) {
      this.stats.tier1Hits += 1;
      void this.maybeRunTier2(reason, raw);
    }
  }

  // ── Tier 1 ────────────────────────────────────────────────────────────────

  /**
   * Build the Tier 1 pattern list. The assistant-name mention and addressed-
   * question patterns are always prepended (they depend on the live display
   * name), then the config-supplied generic patterns follow.
   */
  private buildPatterns(
    displayName: string,
    extras: readonly string[],
  ): RegExp[] {
    const nameLiteral = escapeRegex(displayName.trim());
    const patterns: RegExp[] = [];
    if (nameLiteral.length > 0) {
      // Word-boundary name mention, case-insensitive.
      try {
        patterns.push(new RegExp(`\\b${nameLiteral}\\b`, "i"));
      } catch (err) {
        log.warn(
          { err, displayName, meetingId: this.meetingId },
          "MeetChatOpportunityDetector: failed to build name-mention regex",
        );
      }
      // Address + question: `(hey|hi|ok|so),? <assistantName>[,.]? … ?`.
      try {
        patterns.push(
          new RegExp(`(hey|hi|ok|so),?\\s+${nameLiteral}[,.]?\\s+.*\\?$`, "i"),
        );
      } catch (err) {
        log.warn(
          { err, displayName, meetingId: this.meetingId },
          "MeetChatOpportunityDetector: failed to build addressed-question regex",
        );
      }
    }
    patterns.push(...compilePatterns(extras, this.meetingId));
    return patterns;
  }

  /**
   * Return a short trigger reason if `text` matches any Tier 1 pattern, or
   * `null` when no pattern matched. The reason is the matching pattern's
   * `source` prefixed with `"tier1:"` so downstream logs can attribute.
   */
  private tier1Match(text: string): string | null {
    for (const re of this.patterns) {
      if (re.test(text)) return `tier1:${re.source}`;
    }
    return null;
  }

  // ── Tier 2 ────────────────────────────────────────────────────────────────

  /**
   * Run one Tier 2 LLM check if the debounce window has elapsed and no
   * other call is in flight. Overlapping Tier 1 hits within the debounce
   * window are silently dropped (stats still record them as `tier1Hits`
   * but not as `tier2Calls`).
   *
   * On a `shouldRespond: true` verdict, the escalation cooldown is checked
   * before firing `onOpportunity`. A verdict arriving within
   * `escalationCooldownSec` of the previous fire is counted as
   * `escalationsSuppressed` and dropped.
   */
  private async maybeRunTier2(
    triggerReason: string,
    triggerText: string,
  ): Promise<void> {
    if (this.tier2InFlight) return;

    const nowMs = this.now();
    if (
      this.lastTier2CallAt !== null &&
      nowMs - this.lastTier2CallAt < this.config.tier2DebounceMs
    ) {
      log.debug(
        {
          event: "chat_opportunity.tier2.debounced",
          meetingId: this.meetingId,
          msSinceLast: nowMs - this.lastTier2CallAt,
        },
        "MeetChatOpportunityDetector: Tier 2 debounced",
      );
      return;
    }

    // Stamp the debounce clock BEFORE the async call so a second trigger
    // arriving mid-flight is still debounced. Capture the previous value
    // so we can restore it on failure — a failed LLM call must not burn
    // the debounce window.
    const prevTier2CallAt = this.lastTier2CallAt;
    this.lastTier2CallAt = nowMs;
    this.tier2InFlight = true;
    this.stats.tier2Calls += 1;

    const prompt = this.buildPrompt(triggerReason, triggerText);
    try {
      const decision = await this.callDetectorLLM(prompt);
      if (!decision.shouldRespond) {
        log.debug(
          {
            event: "chat_opportunity.tier2.negative",
            meetingId: this.meetingId,
            triggerReason,
            reason: decision.reason,
          },
          "MeetChatOpportunityDetector: Tier 2 declined",
        );
        return;
      }
      this.stats.tier2PositiveCount += 1;

      // Escalation cooldown — suppress back-to-back fires.
      const cooldownMs = this.config.escalationCooldownSec * 1_000;
      const nowAfter = this.now();
      if (
        this.lastEscalationAt !== null &&
        nowAfter - this.lastEscalationAt < cooldownMs
      ) {
        this.stats.escalationsSuppressed += 1;
        log.debug(
          {
            event: "chat_opportunity.escalation.suppressed",
            meetingId: this.meetingId,
            msSinceLast: nowAfter - this.lastEscalationAt,
          },
          "MeetChatOpportunityDetector: escalation suppressed by cooldown",
        );
        return;
      }

      this.lastEscalationAt = nowAfter;
      this.stats.escalationsFired += 1;
      log.info(
        {
          event: "chat_opportunity.escalation.fired",
          meetingId: this.meetingId,
          triggerReason,
          decisionReason: decision.reason,
        },
        "MeetChatOpportunityDetector: firing opportunity callback",
      );
      try {
        this.onOpportunity(decision.reason);
      } catch (err) {
        log.error(
          { err, meetingId: this.meetingId },
          "MeetChatOpportunityDetector: onOpportunity callback threw",
        );
      }
    } catch (err) {
      // Restore the debounce clock on failure so the next trigger isn't
      // silently suppressed for the remainder of the debounce window.
      this.lastTier2CallAt = prevTier2CallAt;
      log.warn(
        { err, meetingId: this.meetingId, triggerReason },
        "MeetChatOpportunityDetector: Tier 2 LLM call failed",
      );
    } finally {
      this.tier2InFlight = false;
    }
  }

  // ── Prompt construction ───────────────────────────────────────────────────

  private buildPrompt(triggerReason: string, triggerText: string): string {
    const windowMs = this.config.tier2MaxTranscriptSec * 1_000;
    const cutoff = this.now() - windowMs;
    const transcriptLines = this.transcriptBuffer
      .filter((e) => e.tMs >= cutoff)
      .map((e) => `${e.speaker}: ${e.text}`);
    const transcriptBlock =
      transcriptLines.length === 0 ? "(none)" : transcriptLines.join("\n");
    const chatBlock =
      this.chatBuffer.length === 0
        ? "(none)"
        : this.chatBuffer.map((e) => `${e.fromName}: ${e.text}`).join("\n");
    return (
      `Recent transcript (last ${this.config.tier2MaxTranscriptSec}s):\n` +
      `${transcriptBlock}\n\n` +
      `Recent chat (last ${CHAT_BUFFER_SIZE}):\n${chatBlock}\n\n` +
      `Trigger chunk: ${triggerText}\n` +
      `Tier 1 reason: ${triggerReason}\n\n` +
      "Would the AI assistant chiming in via meeting chat be appropriate " +
      "and helpful here? Reply JSON only: " +
      "{ shouldRespond: bool, reason: string }"
    );
  }

  // ── Buffer maintenance ────────────────────────────────────────────────────

  private trimTranscriptBuffer(): void {
    const cutoff = this.now() - this.config.tier2MaxTranscriptSec * 1_000;
    while (
      this.transcriptBuffer.length > 0 &&
      this.transcriptBuffer[0].tMs < cutoff
    ) {
      this.transcriptBuffer.shift();
    }
  }
}
