/**
 * MeetChatOpportunityDetector — watches meeting transcript, chat, and
 * participant changes for moments when the assistant should respond.
 * Fires `onOpportunity({ reason, kind })` through the injected callback
 * so a downstream orchestrator (the session manager) can wake the agent.
 *
 * The detector runs in one of two modes per event, keyed on the live
 * participant count:
 *
 *   **Group mode (participantCount >= 3)** — the two-tier chat-opportunity
 *   pipeline:
 *
 *     1. **Tier 1 (regex fast filter)** — synchronous on every final
 *        transcript chunk. Default patterns cover direct assistant-name
 *        mentions, `(hey|hi|…) <name>, … ?` style address-then-question
 *        forms, and generic "can you / does anyone know" requests. A hit
 *        feeds Tier 2 with a short trigger reason.
 *
 *        Inbound chat messages intentionally **bypass** Tier 1 and proceed
 *        straight to Tier 2 with a synthetic `"tier1:chat-always-on"`
 *        reason. Chat volume is orders of magnitude lower than transcript
 *        (typically <1/5s even on chatty meetings), so the regex gate's
 *        cost savings don't pay off there — and users typing in chat
 *        expect the assistant to read every message rather than be filtered
 *        by an English-interrogative keyword list.
 *
 *     2. **Tier 2 (LLM confirmation)** — fires on every Tier 1 hit and
 *        every inbound chat, subject to a configurable debounce. The
 *        prompt includes the rolling transcript (last N seconds), the
 *        most recent 5 chat messages, the trigger chunk, and the Tier 1
 *        reason, and asks for strict JSON `{ shouldRespond: boolean,
 *        reason: string }`.
 *
 *     Positive Tier 2 verdicts clear the escalation cooldown and fire
 *     `onOpportunity({ kind: "chat" })`.
 *
 *   **1:1 voice mode (voiceMode.enabled && participantCount === 2)** —
 *   Tier 1 and Tier 2 are both skipped for transcript: every utterance
 *   in a 1:1 is addressed to the bot, so there is nothing to filter for,
 *   and the extra Tier 2 LLM call adds ~500ms of latency per turn. Instead,
 *   the detector schedules a short silence-debounce timer
 *   (`voiceMode.eouDebounceMs`, default 800ms) on each final chunk. When
 *   the timer fires with no newer chunk having arrived, the detector
 *   treats that as end-of-utterance and fires
 *   `onOpportunity({ kind: "voice" })`. Inbound chat continues to run
 *   through the Tier-2-only chat path (which still wakes the agent).
 *
 *   The escalation cooldown remains the shared safety rail for both
 *   modes — one positive wake per `escalationCooldownSec` regardless of
 *   trigger path.
 *
 * Dependency injection keeps the detector fully testable: the LLM call
 * is reached via a `callDetectorLLM(prompt)` callable, the router
 * subscription can be overridden, and voice-mode timers can be driven
 * via `deps.setTimer` / `deps.clearTimer` injections.
 */

import type { Logger, SkillHost } from "@vellumai/skill-host-contracts";

import type {
  InboundChatEvent,
  MeetBotEvent,
  ParticipantChangeEvent,
  TranscriptChunkEvent,
} from "../contracts/index.js";

import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";
import { registerSubModule } from "./modules-registry.js";

/**
 * Fallback logger used when the detector is constructed without a host-
 * sourced logger. Keeps the class callable from unit tests that build it
 * directly without supplying a full {@link SkillHost} stub.
 */
const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.warn(msg, meta ?? {});
  },
  error: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.error(msg, meta ?? {});
  },
};

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

/**
 * Discriminator on the opportunity callback so downstream code can route
 * chat-opportunity wakes and 1:1 voice-turn wakes to different agent
 * sources (e.g. different `source` strings on `wakeAgent`).
 */
export type ChatOpportunityKind = "chat" | "voice";

/** Payload fired when an opportunity clears the escalation cooldown. */
export interface ChatOpportunityEvent {
  reason: string;
  kind: ChatOpportunityKind;
}

/** Callback fired when an opportunity clears Tier 2 and cooldown. */
export type ChatOpportunityCallback = (event: ChatOpportunityEvent) => void;

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

/** Configuration block mirrored from `services.meet.voiceMode`. */
export interface VoiceModeConfig {
  enabled: boolean;
  eouDebounceMs: number;
}

/** Stats snapshot exposed to session-manager for telemetry/debug surfaces. */
export interface ChatOpportunityDetectorStats {
  tier1Hits: number;
  tier2Calls: number;
  tier2PositiveCount: number;
  escalationsFired: number;
  escalationsSuppressed: number;
  /** Voice-mode wakes that made it past the escalation cooldown. */
  voiceWakesFired: number;
}

/** Timer handle type-erased so tests can swap `setTimeout` for a manual driver. */
export type TimerHandle = unknown;

export interface MeetChatOpportunityDetectorDeps {
  meetingId: string;
  /**
   * Display name the bot is using in the meeting. Used to build the
   * default name-mention and addressed-question Tier 1 regexes. Pass the
   * value the bot actually joined with, not the assistant's internal id.
   */
  assistantDisplayName: string;
  config: ProactiveChatConfig;
  voiceConfig: VoiceModeConfig;
  callDetectorLLM: ChatOpportunityLLMAsk;
  onOpportunity: ChatOpportunityCallback;
  /** Override the dispatcher subscribe (tests). */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /** Override `Date.now` for deterministic tests. */
  now?: () => number;
  /**
   * Override the voice-mode EOU timer scheduler. Defaults to
   * `setTimeout`. Tests inject a manual driver so they can advance
   * the debounce window deterministically without real wall-clock waits.
   */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /**
   * Logger used for detector telemetry. Production callers wire
   * `host.logger.get("meet-chat-opportunity-detector")` via
   * {@link createChatOpportunityDetector}; unit tests get a console-
   * backed fallback so they don't need to build a full {@link SkillHost}.
   */
  logger?: Logger;
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
  log: Logger,
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    if (!pattern) continue;
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch (err) {
      log.warn(
        "MeetChatOpportunityDetector: invalid detector regex — skipping",
        { err, pattern, meetingId },
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
  private readonly voiceConfig: VoiceModeConfig;
  private readonly callDetectorLLM: ChatOpportunityLLMAsk;
  private readonly onOpportunity: ChatOpportunityCallback;
  private readonly subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly log: Logger;

  private unsubscribe: MeetEventUnsubscribe | null = null;
  private disposed = false;

  /** Compiled Tier 1 regexes. Empty when `config.enabled === false`. */
  private readonly patterns: RegExp[];

  private readonly transcriptBuffer: TranscriptEntry[] = [];
  private readonly chatBuffer: ChatEntry[] = [];

  /**
   * Live participant count (bot + humans) as reported by the
   * `participant.change` stream. The scraper's first poll emits every
   * currently-visible participant in `joined` including the bot row, so
   * starting at 0 and tracking deltas produces a correct running count
   * without needing an explicit seed from the session manager.
   */
  private participantCount = 0;

  /** Wall-clock ms of the last Tier 2 call (regardless of outcome). */
  private lastTier2CallAt: number | null = null;
  /** Wall-clock ms of the last positive escalation (`shouldRespond: true`). */
  private lastEscalationAt: number | null = null;
  /** In-flight flag so overlapping Tier 1 hits don't race Tier 2 calls. */
  private tier2InFlight = false;

  /**
   * Active end-of-utterance timer for 1:1 voice mode. Reset on every
   * new final transcript chunk, fires `onOpportunity` once the debounce
   * window elapses with no new chunk. Null when no timer is pending.
   */
  private voiceEouTimer: TimerHandle | null = null;
  /** Last voice-mode trigger text — carried into the wake hint when the timer fires. */
  private voicePendingTriggerText: string | null = null;

  private readonly stats: ChatOpportunityDetectorStats = {
    tier1Hits: 0,
    tier2Calls: 0,
    tier2PositiveCount: 0,
    escalationsFired: 0,
    escalationsSuppressed: 0,
    voiceWakesFired: 0,
  };

  constructor(deps: MeetChatOpportunityDetectorDeps) {
    this.meetingId = deps.meetingId;
    this.assistantDisplayName = deps.assistantDisplayName;
    this.config = deps.config;
    this.voiceConfig = deps.voiceConfig;
    this.callDetectorLLM = deps.callDetectorLLM;
    this.onOpportunity = deps.onOpportunity;
    this.subscribe = deps.subscribe ?? subscribeToMeetingEvents;
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((cb: () => void, ms: number): TimerHandle => setTimeout(cb, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((handle: TimerHandle): void => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.log = deps.logger ?? consoleLogger;

    this.patterns = this.config.enabled
      ? this.buildPatterns(
          deps.assistantDisplayName,
          this.config.detectorKeywords,
        )
      : [];
  }

  /**
   * Whether the detector currently considers the meeting a 1:1
   * (exactly bot + one human, participantCount === 2). The scraper's
   * first poll emits every currently-visible participant (including
   * the bot row with `isSelf: true`), so an established 1:1 meeting
   * ticks through to 2. Any value other than 2 — 0 or 1 (pre-poll /
   * bot alone) or ≥ 3 (group) — takes the Tier 1 + Tier 2 path, which
   * is both the safe default when the detector has no participant
   * information and the correct behavior for multi-party meetings.
   */
  private isOneOnOne(): boolean {
    return this.participantCount === 2;
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
    this.disposed = true;
    this.cancelVoiceEouTimer();
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (err) {
        this.log.warn(
          "MeetChatOpportunityDetector: unsubscribe threw during dispose",
          { err, meetingId: this.meetingId },
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
    try {
      // Participant changes are tracked regardless of `config.enabled`
      // so the mode-switch stays correct even when proactive-chat is
      // off — voice mode is independently gated and benefits from the
      // same live count.
      if (event.type === "participant.change") {
        this.onParticipantChange(event);
        return;
      }
      // Transcript chunks must reach `onTranscriptChunk` regardless of
      // `config.enabled` so the 1:1 voice-mode EOU path can fire when
      // proactive chat is off. The Tier 1 + Tier 2 branch inside is
      // gated on `config.enabled` separately.
      if (event.type === "transcript.chunk") {
        this.onTranscriptChunk(event);
        return;
      }
      // Inbound chat is purely a proactive-chat input; skip when off.
      if (!this.config.enabled) return;
      if (event.type === "chat.inbound") {
        this.onInboundChat(event);
        return;
      }
    } catch (err) {
      this.log.warn("MeetChatOpportunityDetector: event handler threw", {
        err,
        meetingId: this.meetingId,
        eventType: event.type,
      });
    }
  }

  private onParticipantChange(event: ParticipantChangeEvent): void {
    const wasOneOnOne = this.isOneOnOne();
    this.participantCount += event.joined.length - event.left.length;
    if (this.participantCount < 0) this.participantCount = 0;

    // If a third participant just joined, cancel any pending voice EOU
    // timer — we should not fire a voice wake for an utterance that
    // happened while the meeting was 1:1 if the mode flipped before
    // the debounce window elapsed. The next utterance will take the
    // group-mode (Tier 1 + Tier 2) branch.
    if (wasOneOnOne && !this.isOneOnOne()) {
      this.cancelVoiceEouTimer();
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

    if (this.voiceConfig.enabled && this.isOneOnOne()) {
      // 1:1 voice mode: skip Tier 1 + Tier 2 entirely. Every utterance
      // is necessarily addressed to the bot, so both filters are pure
      // overhead. The EOU silence debounce decides when to fire;
      // escalation cooldown remains the safety rail.
      this.scheduleVoiceEouWake(raw);
      return;
    }

    // Tier 1 + Tier 2 only run when proactive chat is enabled. Voice
    // mode above is independently gated and reaches here on its own.
    if (!this.config.enabled) return;

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

    // Backfilled replays of pre-existing DOM chat history populate the
    // Tier 2 prompt context buffer but must NOT drive Tier 2 themselves.
    // The reader emits one backfill event per already-mounted message on
    // attach; treating those as live triggers would burn the debounce /
    // in-flight slot and silently drop the first real live message that
    // arrives inside the `tier2DebounceMs` window.
    if (event.isBackfill === true) return;

    // Every non-backfill inbound chat proceeds to Tier 2 unconditionally.
    // Chat volume is low enough (<1/5s typical) that the debounce +
    // escalation cooldown are sufficient throttles on their own, and a
    // keyword gate silently drops natural-but-unkeyworded invitations
    // like "yo where's that deck" or "wait which one". The synthetic
    // `tier1:chat-always-on` reason keeps log-grep patterns (`tier1:*`)
    // working and signals the bypass path in telemetry.
    this.stats.tier1Hits += 1;
    void this.maybeRunTier2("tier1:chat-always-on", raw);
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
        this.log.warn(
          "MeetChatOpportunityDetector: failed to build name-mention regex",
          { err, displayName, meetingId: this.meetingId },
        );
      }
      // Address + question: `(hey|hi|ok|so),? <assistantName>[,.]? … ?`.
      try {
        patterns.push(
          new RegExp(`(hey|hi|ok|so),?\\s+${nameLiteral}[,.]?\\s+.*\\?$`, "i"),
        );
      } catch (err) {
        this.log.warn(
          "MeetChatOpportunityDetector: failed to build addressed-question regex",
          { err, displayName, meetingId: this.meetingId },
        );
      }
    }
    patterns.push(...compilePatterns(extras, this.meetingId, this.log));
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
      this.log.debug("MeetChatOpportunityDetector: Tier 2 debounced", {
        event: "chat_opportunity.tier2.debounced",
        meetingId: this.meetingId,
        msSinceLast: nowMs - this.lastTier2CallAt,
      });
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
      if (this.disposed) return;
      if (!decision.shouldRespond) {
        this.log.debug("MeetChatOpportunityDetector: Tier 2 declined", {
          event: "chat_opportunity.tier2.negative",
          meetingId: this.meetingId,
          triggerReason,
          reason: decision.reason,
        });
        return;
      }
      this.stats.tier2PositiveCount += 1;
      this.tryFireOpportunity({
        reason: decision.reason,
        kind: "chat",
        logContext: { triggerReason, decisionReason: decision.reason },
      });
    } catch (err) {
      // Restore the debounce clock on failure so the next trigger isn't
      // silently suppressed for the remainder of the debounce window.
      this.lastTier2CallAt = prevTier2CallAt;
      this.log.warn("MeetChatOpportunityDetector: Tier 2 LLM call failed", {
        err,
        meetingId: this.meetingId,
        triggerReason,
      });
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

  // ── Shared opportunity fire (escalation cooldown) ─────────────────────────

  /**
   * Run the escalation cooldown check and, if it passes, invoke
   * `onOpportunity` with the supplied kind. Shared between the Tier 2
   * (chat) path and the voice EOU path so both modes are gated by a
   * single `escalationCooldownSec` window. A wake for either kind
   * suppresses subsequent wakes of either kind for the cooldown
   * duration — the rationale is that "she already spoke" is a human-
   * facing property, not per-channel.
   */
  private tryFireOpportunity(opts: {
    reason: string;
    kind: ChatOpportunityKind;
    logContext?: Record<string, unknown>;
  }): void {
    const cooldownMs = this.config.escalationCooldownSec * 1_000;
    const nowAfter = this.now();
    if (
      this.lastEscalationAt !== null &&
      nowAfter - this.lastEscalationAt < cooldownMs
    ) {
      this.stats.escalationsSuppressed += 1;
      this.log.debug(
        "MeetChatOpportunityDetector: escalation suppressed by cooldown",
        {
          event: "chat_opportunity.escalation.suppressed",
          meetingId: this.meetingId,
          kind: opts.kind,
          msSinceLast: nowAfter - this.lastEscalationAt,
        },
      );
      return;
    }

    this.lastEscalationAt = nowAfter;
    this.stats.escalationsFired += 1;
    if (opts.kind === "voice") this.stats.voiceWakesFired += 1;
    this.log.info(
      "MeetChatOpportunityDetector: firing opportunity callback",
      {
        event: "chat_opportunity.escalation.fired",
        meetingId: this.meetingId,
        kind: opts.kind,
        ...opts.logContext,
      },
    );
    try {
      this.onOpportunity({ reason: opts.reason, kind: opts.kind });
    } catch (err) {
      this.log.error(
        "MeetChatOpportunityDetector: onOpportunity callback threw",
        { err, meetingId: this.meetingId, kind: opts.kind },
      );
    }
  }

  // ── Voice EOU (1:1 mode) ──────────────────────────────────────────────────

  /**
   * Reset the EOU debounce timer on every new final transcript chunk.
   * If no new chunk arrives within `voiceConfig.eouDebounceMs`, the
   * timer fires and we treat that as end-of-utterance. The trigger
   * text is truncated into the opportunity hint so the agent knows
   * what the user just said without having to re-read the transcript.
   */
  private scheduleVoiceEouWake(triggerText: string): void {
    this.cancelVoiceEouTimer();
    this.voicePendingTriggerText = triggerText;
    this.voiceEouTimer = this.setTimer(() => {
      this.voiceEouTimer = null;
      this.onVoiceEouFire();
    }, this.voiceConfig.eouDebounceMs);
  }

  private cancelVoiceEouTimer(): void {
    if (this.voiceEouTimer !== null) {
      this.clearTimer(this.voiceEouTimer);
      this.voiceEouTimer = null;
    }
    this.voicePendingTriggerText = null;
  }

  private onVoiceEouFire(): void {
    if (this.disposed) return;
    const trigger = this.voicePendingTriggerText ?? "";
    this.voicePendingTriggerText = null;
    // Double-check the mode at fire time — a third participant may
    // have joined while the timer was pending. If so, drop rather than
    // wake under group-meeting assumptions.
    if (!this.isOneOnOne() || !this.voiceConfig.enabled) return;

    const snippet = trigger.length > 120 ? `${trigger.slice(0, 117)}...` : trigger;
    this.tryFireOpportunity({
      reason: `voice-turn: ${snippet}`,
      kind: "voice",
      logContext: { triggerText: snippet, participantCount: this.participantCount },
    });
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

// ---------------------------------------------------------------------------
// Host-based factory
// ---------------------------------------------------------------------------

/**
 * Build a callable that constructs per-meeting
 * {@link MeetChatOpportunityDetector} instances bound to a
 * {@link SkillHost}. The factory wires the host's logger; per-meeting
 * deps (config, voice config, LLM callable, opportunity callback, etc.)
 * are supplied by the session manager at construction time.
 *
 * Registered under the sub-module slot `"chat-opportunity-detector"` in
 * {@link registerSubModule} at module import time; PR 17's session
 * manager consumes the registration via `getSubModule`.
 */
export function createChatOpportunityDetector(
  host: SkillHost,
): (deps: MeetChatOpportunityDetectorDeps) => MeetChatOpportunityDetector {
  const logger = host.logger.get("meet-chat-opportunity-detector");
  return (deps) =>
    new MeetChatOpportunityDetector({
      ...deps,
      logger: deps.logger ?? logger,
    });
}

registerSubModule(
  "chat-opportunity-detector",
  createChatOpportunityDetector,
);
