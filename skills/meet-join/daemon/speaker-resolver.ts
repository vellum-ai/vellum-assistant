/**
 * MeetSpeakerResolver — arbitrates between the provider's diarization speaker
 * labels (e.g. Deepgram's opaque `"0"`, `"1"`, …) and the DOM-derived active-
 * speaker stream to produce the best identity attribution for every final
 * transcript chunk.
 *
 * Two signals feed into the resolver:
 *
 *   1. Provider labels — opaque strings that are stable within a
 *      session but carry no real-world identity. They ride in
 *      `TranscriptChunkEvent.speakerLabel` (and occasionally `speakerId`).
 *   2. DOM active-speaker events — real participant ids + names scraped
 *      from the Meet UI, delivered as `SpeakerChangeEvent`s. These are
 *      authoritative for who is on camera but arrive independently of
 *      the audio stream, so they are only useful when correlated with a
 *      transcript's timestamp.
 *
 * The resolver maintains a per-meeting label → participant mapping that is
 * built up across the meeting: the first time the provider says `"0"` while
 * the DOM says Alice is active, we bind `"0" → Alice` with `agreementCount=1`.
 * Subsequent transcripts with that label plus an agreeing DOM snapshot
 * increment the count; the count is what makes a mapping "stable" and
 * trustworthy on its own (see `provider-via-mapping` below).
 *
 * Resolution precedence for a given transcript (all conditional on the
 * provider label being present, unless noted):
 *
 *   - DOM active-speaker in window (±{@link DOM_CORRELATION_WINDOW_MS}):
 *     DOM is authoritative — returned with `confidence: "dom-authoritative"`.
 *     Mapping is created on first sight, incremented on agreement, or —
 *     after 3 consecutive disagreements — replaced with the new DOM
 *     speaker. A single disagreement is treated as transient DOM flicker:
 *     the mapping is preserved and the resolver returns the mapped identity
 *     with `confidence: "provider-via-mapping"` (a structured
 *     `speaker.mapping_conflict` log captures the divergence for review).
 *
 *   - No DOM in window, stable mapping exists (`agreementCount >= 3`):
 *     Use the learned mapping — `confidence: "provider-via-mapping"`.
 *
 *   - No DOM in window, no stable mapping, but a last-known DOM speaker
 *     exists: fall back to the last-known DOM speaker with
 *     `confidence: "dom-fallback"`. This handles brief DOM gaps before the
 *     mapping has had a chance to harden.
 *
 *   - No DOM in window AND no last-known DOM speaker: the resolver has
 *     no basis for attribution — `confidence: "unknown"` with the default
 *     name.
 *
 * When the provider label is absent (non-diarizing provider, or
 * diarization disabled), the DOM is the sole source: DOM in window →
 * `dom-authoritative`, else `unknown`.
 *
 * On teardown ({@link MeetSpeakerResolver.unsubscribe}) the resolver emits a
 * single structured log line summarizing the learned mappings and the
 * conflict count for post-hoc accuracy review.
 *
 * The resolver wraps (not replaces) a shared speaker-identity tracker
 * provided via `host.speakers.createTracker()`: each resolved identity is
 * forwarded via `tracker.identifySpeaker` so the cross-surface speaker
 * profile list stays coherent across calls and meetings.
 *
 * This file has zero `assistant/` imports — every runtime dependency
 * arrives via the {@link SkillHost} contract from
 * `@vellumai/skill-host-contracts`.
 */

import type { Logger, SkillHost } from "@vellumai/skill-host-contracts";

import type {
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "../contracts/index.js";

import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";
import { registerSubModule } from "./modules-registry.js";

// ---------------------------------------------------------------------------
// Local structural types
//
// These mirror the narrow surface of `SpeakerIdentityTracker` and its
// metadata payload that the resolver actually exercises. Defining them here
// avoids reaching into `assistant/` directly; the daemon-side SkillHost
// narrows its concrete tracker type to these structural supertypes at the
// boundary.
// ---------------------------------------------------------------------------

/**
 * Payload passed to {@link SpeakerIdentityTrackerShape.identifySpeaker}.
 * The resolver only populates `speakerId` + `speakerName`; the tracker
 * implementation is responsible for merging the remaining fields from
 * other ingest sites (calls, telephony, etc.).
 */
interface PromptSpeakerMetadata {
  speakerId?: string;
  speakerLabel?: string;
  speakerName?: string;
  speakerConfidence?: number;
  participantId?: string;
}

/**
 * Minimal tracker surface consumed by the resolver. The full
 * `SpeakerIdentityTracker` exported from `assistant/` is a structural
 * supertype — passing it here compiles cleanly without a cast.
 */
export interface SpeakerIdentityTrackerShape {
  identifySpeaker(metadata: PromptSpeakerMetadata): unknown;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Window within which a DOM `SpeakerChangeEvent` is considered correlated
 * with a transcript chunk. ±500ms matches the plan's call-out — provider
 * finals usually trail the DOM update by a few hundred ms as the audio
 * buffer flushes, so a symmetric window is the conservative choice.
 */
export const DOM_CORRELATION_WINDOW_MS = 500;

/**
 * Number of consecutive DOM disagreements before an existing
 * `label → participant` mapping is replaced. Up to 2 disagreements are
 * treated as transient DOM flicker and leave the mapping unchanged.
 */
export const MAPPING_REPLACE_THRESHOLD = 3;

/**
 * Minimum `agreementCount` at which a mapping is considered trustworthy
 * enough to attribute a transcript when the DOM is unavailable in the
 * correlation window. Below this threshold, the resolver prefers the
 * last-known DOM speaker (`dom-fallback`) to avoid hardening a noisy
 * first-observation mapping.
 */
export const STABLE_MAPPING_THRESHOLD = 3;

/** Returned as `speakerName` when neither signal produced a binding. */
export const UNKNOWN_SPEAKER_NAME = "Unknown speaker";

/** No-op logger used when deps do not supply one (tests). */
const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * No-op tracker used when deps do not supply one. Keeps the class safely
 * instantiable outside the host-backed factory (test scenarios that don't
 * care about cross-surface speaker accounting).
 */
const NOOP_TRACKER: SpeakerIdentityTrackerShape = {
  identifySpeaker: () => undefined,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Source of the resolved identity.
 *
 * - `"dom-authoritative"`: a DOM `SpeakerChangeEvent` fell inside the
 *   correlation window and supplied the identity (the highest-confidence
 *   signal — DOM carries the real participant name).
 * - `"provider-via-mapping"`: no DOM in the correlation window (or DOM
 *   disagreed but the mapping was preserved as likely-flicker); the
 *   resolver used the previously-learned mapping for the provider label.
 * - `"dom-fallback"`: no DOM in the correlation window, no stable mapping
 *   yet — the resolver fell back to the most recently observed DOM
 *   speaker. Lower confidence than the mapping path.
 * - `"unknown"`: neither signal produced a binding — the caller should
 *   treat this as an unattributed utterance.
 */
export type ResolvedSpeakerConfidence =
  | "dom-authoritative"
  | "provider-via-mapping"
  | "dom-fallback"
  | "unknown";

export interface ResolvedSpeaker {
  /** Stable speaker identifier, if resolved. */
  speakerId: string | undefined;
  /** Display name — falls back to {@link UNKNOWN_SPEAKER_NAME}. */
  speakerName: string;
  /** Which signal produced the identity. See {@link ResolvedSpeakerConfidence}. */
  confidence: ResolvedSpeakerConfidence;
}

/** Shape of the per-meeting summary emitted on teardown. */
export interface MeetingSummary {
  meetingId: string;
  labelMappings: Array<{
    label: string;
    participantId: string;
    participantName: string;
    agreementCount: number;
  }>;
  conflictCount: number;
}

export interface MeetSpeakerResolverDeps {
  /** Meeting id — used to subscribe to the matching event stream. */
  meetingId: string;
  /**
   * Optional shared speaker-identity tracker. Defaults to a no-op;
   * callers who want the Meet stream to feed the same tracker used by
   * calls should pass one here (the host-backed factory threads
   * `host.speakers.createTracker()` through for production wiring).
   */
  tracker?: SpeakerIdentityTrackerShape;
  /**
   * Optional correlation-window override (milliseconds). Defaults to
   * {@link DOM_CORRELATION_WINDOW_MS}. Tests set this to 0 to make the
   * fallback path deterministic.
   */
  correlationWindowMs?: number;
  /**
   * Optional subscribe override. Defaults to the process-level
   * {@link subscribeToMeetingEvents}. Tests inject a local shim so they
   * don't need to touch the singleton dispatcher.
   */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /**
   * Structural logger for internal warnings. Defaults to a silent no-op
   * so direct instantiation in tests does not require a logger; the
   * host-backed factory passes `host.logger.get("meet-speaker-resolver")`.
   */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Most recent DOM active-speaker — stored as an absolute epoch-ms. */
interface ActiveSpeakerSnapshot {
  speakerId: string;
  speakerName: string;
  timestampMs: number;
}

/**
 * A learned `label → participant` mapping. `agreementCount` grows when a
 * fresh DOM snapshot within the correlation window confirms the mapping.
 * `consecutiveDisagreements` is reset on agreement and grows on a DOM
 * conflict; crossing {@link MAPPING_REPLACE_THRESHOLD} replaces the mapping.
 *
 * `lastDisagreeSpeakerId` tracks which DOM speaker drove the current
 * disagreement streak. If a different DOM speaker disagrees, the counter
 * resets to 1 with the new challenger — random flicker from multiple
 * speakers should not accumulate toward a mapping replacement.
 */
interface LabelMapping {
  participantId: string;
  participantName: string;
  agreementCount: number;
  consecutiveDisagreements: number;
  lastDisagreeSpeakerId: string | null;
}

// ---------------------------------------------------------------------------
// MeetSpeakerResolver
// ---------------------------------------------------------------------------

export class MeetSpeakerResolver {
  private readonly meetingId: string;
  private readonly tracker: SpeakerIdentityTrackerShape;
  private readonly correlationWindowMs: number;
  private readonly unsubscribeFn: MeetEventUnsubscribe;
  private readonly log: Logger;

  /** Most-recent DOM active speaker — updated on every `speaker.change`. */
  private activeSpeaker: ActiveSpeakerSnapshot | null = null;

  /**
   * Learned `label → participant` mappings. Once bound, a mapping is only
   * replaced when the DOM disagrees {@link MAPPING_REPLACE_THRESHOLD} times
   * in a row. Callers drop and recreate the resolver per meeting so stale
   * bindings from a prior meeting can't leak.
   */
  private readonly labelMappings = new Map<string, LabelMapping>();

  /** Count of `speaker.mapping_conflict` log events — reported at teardown. */
  private conflictCount = 0;

  /** Guards {@link flushSummary} against double-emission. */
  private summaryFlushed = false;

  constructor(deps: MeetSpeakerResolverDeps) {
    this.meetingId = deps.meetingId;
    this.tracker = deps.tracker ?? NOOP_TRACKER;
    this.correlationWindowMs =
      deps.correlationWindowMs ?? DOM_CORRELATION_WINDOW_MS;
    this.log = deps.logger ?? NOOP_LOGGER;

    const subscribe = deps.subscribe ?? subscribeToMeetingEvents;
    this.unsubscribeFn = subscribe(this.meetingId, (event) => {
      if (event.type === "speaker.change") {
        this.onSpeakerChange(event);
      }
    });
  }

  /**
   * Resolve a transcript chunk to its best-available speaker identity.
   *
   * Mutates internal state (may create, increment, or replace a mapping
   * for the provider label), so callers should treat this as the single
   * entry point per transcript — do not call twice on the same event.
   */
  resolve(transcript: TranscriptChunkEvent): ResolvedSpeaker {
    const transcriptMs = parseTimestamp(transcript.timestamp);
    const domMatch = this.correlatedActiveSpeaker(transcriptMs);
    const label = transcript.speakerLabel;

    // Case A — provider label present.
    if (label !== undefined) {
      if (domMatch) {
        return this.resolveWithLabelAndDom(label, domMatch);
      }
      return this.resolveWithLabelNoDom(label);
    }

    // Case B — provider label absent. DOM is the sole source.
    if (domMatch) {
      return this.emit({
        speakerId: domMatch.speakerId,
        speakerName: domMatch.speakerName,
        confidence: "dom-authoritative",
      });
    }
    return this.emit({
      speakerId: undefined,
      speakerName: UNKNOWN_SPEAKER_NAME,
      confidence: "unknown",
    });
  }

  /**
   * Build and emit the end-of-meeting summary log. Invoked automatically
   * the first time {@link unsubscribe} is called; callers that want the
   * summary before teardown can call this explicitly. Idempotent — the
   * log is emitted at most once. Returns the summary payload regardless
   * of whether the log was actually emitted, so tests (and future
   * observability hooks) can inspect it without parsing log output.
   */
  flushSummary(): MeetingSummary {
    const summary: MeetingSummary = {
      meetingId: this.meetingId,
      labelMappings: Array.from(this.labelMappings.entries()).map(
        ([label, mapping]) => ({
          label,
          participantId: mapping.participantId,
          participantName: mapping.participantName,
          agreementCount: mapping.agreementCount,
        }),
      ),
      conflictCount: this.conflictCount,
    };

    if (!this.summaryFlushed) {
      this.summaryFlushed = true;
      this.log.info("Meet speaker resolver: meeting summary", summary);
    }
    return summary;
  }

  /**
   * Tear down the dispatcher subscription and emit the end-of-meeting
   * summary log. Safe to call multiple times — the summary is emitted
   * at most once.
   */
  unsubscribe(): void {
    try {
      this.unsubscribeFn();
    } catch (err) {
      this.log.warn("MeetSpeakerResolver: unsubscribe threw", {
        err,
        meetingId: this.meetingId,
      });
    }
    this.flushSummary();
  }

  // ── Internals ──────────────────────────────────────────────────────

  private onSpeakerChange(event: SpeakerChangeEvent): void {
    const timestampMs = parseTimestamp(event.timestamp);
    if (!Number.isFinite(timestampMs)) return;
    this.activeSpeaker = {
      speakerId: event.speakerId,
      speakerName: event.speakerName,
      timestampMs,
    };
  }

  /**
   * Provider label + DOM snapshot in window. DOM is authoritative; update
   * the mapping (create, agree, or record disagreement) accordingly.
   */
  private resolveWithLabelAndDom(
    label: string,
    domMatch: ActiveSpeakerSnapshot,
  ): ResolvedSpeaker {
    const existing = this.labelMappings.get(label);

    if (!existing) {
      // First sight — bind the mapping and emit DOM.
      this.labelMappings.set(label, {
        participantId: domMatch.speakerId,
        participantName: domMatch.speakerName,
        agreementCount: 1,
        consecutiveDisagreements: 0,
        lastDisagreeSpeakerId: null,
      });
      return this.emit({
        speakerId: domMatch.speakerId,
        speakerName: domMatch.speakerName,
        confidence: "dom-authoritative",
      });
    }

    const agrees =
      existing.participantId === domMatch.speakerId &&
      existing.participantName === domMatch.speakerName;

    if (agrees) {
      existing.agreementCount += 1;
      existing.consecutiveDisagreements = 0;
      existing.lastDisagreeSpeakerId = null;
      return this.emit({
        speakerId: domMatch.speakerId,
        speakerName: domMatch.speakerName,
        confidence: "dom-authoritative",
      });
    }

    // Disagreement — only count consecutive disagreements from the SAME
    // DOM speaker. A different challenger resets the streak to 1 so random
    // flicker from multiple speakers can't accumulate toward replacement.
    const sameChallenger =
      existing.lastDisagreeSpeakerId === domMatch.speakerId;
    const newDisagreements = sameChallenger
      ? existing.consecutiveDisagreements + 1
      : 1;

    this.conflictCount += 1;
    this.log.warn(
      "Meet speaker resolver: provider-label mapping disagrees with DOM",
      {
        event: "speaker.mapping_conflict",
        meetingId: this.meetingId,
        label,
        previousMapping: {
          participantId: existing.participantId,
          participantName: existing.participantName,
          agreementCount: existing.agreementCount,
        },
        newDomSpeaker: {
          speakerId: domMatch.speakerId,
          speakerName: domMatch.speakerName,
        },
        consecutiveDisagreements: newDisagreements,
      },
    );

    existing.consecutiveDisagreements = newDisagreements;
    existing.lastDisagreeSpeakerId = domMatch.speakerId;
    if (existing.consecutiveDisagreements >= MAPPING_REPLACE_THRESHOLD) {
      existing.participantId = domMatch.speakerId;
      existing.participantName = domMatch.speakerName;
      existing.agreementCount = 1;
      existing.consecutiveDisagreements = 0;
      existing.lastDisagreeSpeakerId = null;
      return this.emit({
        speakerId: domMatch.speakerId,
        speakerName: domMatch.speakerName,
        confidence: "dom-authoritative",
      });
    }

    // Preserve the mapping: treat this as transient DOM flicker and stay
    // with the learned identity. The caller still needs an attribution —
    // the mapping path is the best option.
    return this.emit({
      speakerId: existing.participantId,
      speakerName: existing.participantName,
      confidence: "provider-via-mapping",
    });
  }

  /**
   * Provider label present but DOM is not in the correlation window.
   * Prefer a stable mapping; else fall back to the last-known DOM speaker;
   * else unknown.
   */
  private resolveWithLabelNoDom(label: string): ResolvedSpeaker {
    const existing = this.labelMappings.get(label);
    if (existing && existing.agreementCount >= STABLE_MAPPING_THRESHOLD) {
      return this.emit({
        speakerId: existing.participantId,
        speakerName: existing.participantName,
        confidence: "provider-via-mapping",
      });
    }

    // No stable mapping — fall back to the last-known DOM speaker if we
    // have one. This is lower confidence: we haven't verified that this
    // label corresponds to the last speaker, but in short DOM gaps the
    // last-known speaker is usually still the one talking.
    const lastDom = this.activeSpeaker;
    if (lastDom) {
      return this.emit({
        speakerId: lastDom.speakerId,
        speakerName: lastDom.speakerName,
        confidence: "dom-fallback",
      });
    }

    return this.emit({
      speakerId: undefined,
      speakerName: UNKNOWN_SPEAKER_NAME,
      confidence: "unknown",
    });
  }

  /**
   * Return the most-recent DOM active speaker if their `timestamp` is
   * within the correlation window of `transcriptMs`, otherwise `null`.
   *
   * If `transcriptMs` is NaN (unparsable ISO string) we refuse to match —
   * an unbounded window would create a label↔participant mapping based on
   * whoever spoke most recently, regardless of how stale that DOM event
   * is. Returning `null` here forces the fallback path (last-known DOM
   * with `dom-fallback`, or `unknown`), which never mutates the mapping
   * table and so can't poison future resolutions.
   */
  private correlatedActiveSpeaker(
    transcriptMs: number,
  ): ActiveSpeakerSnapshot | null {
    if (!Number.isFinite(transcriptMs)) return null;
    const snapshot = this.activeSpeaker;
    if (!snapshot) return null;
    const delta = Math.abs(snapshot.timestampMs - transcriptMs);
    if (delta > this.correlationWindowMs) return null;
    return snapshot;
  }

  /**
   * Forward the resolved identity to the shared speaker-identity tracker
   * so cross-surface profile accounting (calls + meetings) stays
   * coherent, then return it.
   */
  private emit(resolved: ResolvedSpeaker): ResolvedSpeaker {
    if (resolved.confidence !== "unknown" && resolved.speakerId) {
      const metadata: PromptSpeakerMetadata = {
        speakerId: resolved.speakerId,
        speakerName: resolved.speakerName,
      };
      try {
        this.tracker.identifySpeaker(metadata);
      } catch (err) {
        // Tracker is typically in-memory, but defend against a future
        // implementation change — a tracker failure must never break
        // transcript attribution.
        this.log.warn("MeetSpeakerResolver: tracker.identifySpeaker threw", {
          err,
          meetingId: this.meetingId,
        });
      }
    }
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 timestamp (as produced by the bot) to epoch-ms.
 * Returns `NaN` if the input is unparsable — callers should treat NaN as
 * "cannot correlate" rather than "correlates with anything".
 */
function parseTimestamp(iso: string): number {
  return Date.parse(iso);
}

// ---------------------------------------------------------------------------
// Host-backed factory
// ---------------------------------------------------------------------------

/**
 * Per-meeting overrides accepted by the builder returned from
 * {@link createSpeakerResolver}. The session manager supplies the
 * meeting id and (optionally) a per-meeting correlation window; the
 * factory wires in the host-provided logger and tracker.
 */
export interface CreateSpeakerResolverInstanceOptions {
  meetingId: string;
  /** Override the correlation window (tests only). */
  correlationWindowMs?: number;
  /** Override the event-stream subscribe function (tests only). */
  subscribe?: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  /**
   * Supply a pre-constructed tracker instead of the host-default. The
   * host-backed factory calls `host.speakers.createTracker()` once per
   * builder call; callers that want to share a tracker across surfaces
   * (e.g. calls + Meet) can pass their own.
   */
  tracker?: SpeakerIdentityTrackerShape;
}

/**
 * Host-backed factory for {@link MeetSpeakerResolver}. The session
 * manager retrieves this factory from the sub-module registry and calls
 * the returned builder once per meeting.
 *
 * The builder consults `host.speakers.createTracker()` for the default
 * tracker and routes internal warnings through
 * `host.logger.get("meet-speaker-resolver")`.
 */
export function createSpeakerResolver(
  host: SkillHost,
): (opts: CreateSpeakerResolverInstanceOptions) => MeetSpeakerResolver {
  const logger = host.logger.get("meet-speaker-resolver");
  return (opts) =>
    new MeetSpeakerResolver({
      meetingId: opts.meetingId,
      tracker:
        opts.tracker ??
        (host.speakers.createTracker() as SpeakerIdentityTrackerShape),
      logger,
      correlationWindowMs: opts.correlationWindowMs,
      subscribe: opts.subscribe,
    });
}

// ---------------------------------------------------------------------------
// Sub-module registry wiring
// ---------------------------------------------------------------------------

/**
 * Registry key for the speaker-resolver factory. The session manager
 * looks this up via {@link getSubModule} to obtain the per-meeting builder.
 */
export const SPEAKER_RESOLVER_SUB_MODULE = "speaker-resolver";

registerSubModule(SPEAKER_RESOLVER_SUB_MODULE, createSpeakerResolver);
