/**
 * MeetSpeakerResolver — arbitrates between Deepgram speaker labels and the
 * DOM-derived active-speaker stream to produce the best identity attribution
 * for every final transcript chunk.
 *
 * Two signals feed into the resolver:
 *
 *   1. **Deepgram labels** — opaque `speaker-N` strings that are stable
 *      *within* a session but carry no real-world identity. They ride in
 *      `TranscriptChunkEvent.speakerLabel` (and occasionally `speakerId`).
 *   2. **DOM active-speaker events** — real participant ids + names scraped
 *      from the Meet UI, delivered as `SpeakerChangeEvent`s. These are
 *      authoritative for *who* is on camera but arrive independently of
 *      the audio stream, so they are only useful when correlated with a
 *      transcript's timestamp.
 *
 * The resolver maintains an internal label → identity mapping that is built
 * up across the meeting: the first time Deepgram says `speaker-0` while the
 * DOM says Alice is active, we bind `speaker-0 → Alice` and the next
 * Deepgram-only transcript carrying that label resolves to Alice without
 * a DOM round-trip.
 *
 * Resolution precedence for a given transcript:
 *   - Bound mapping for the Deepgram label → `"deepgram"`
 *   - DOM event within ±{@link DOM_CORRELATION_WINDOW_MS} of the transcript
 *     timestamp → `"dom-override"` (and bind the mapping if the Deepgram
 *     label was previously unmapped)
 *   - Neither → `"unknown"` with a default name
 *
 * When Deepgram's mapped identity disagrees with a near-in-time DOM event,
 * the DOM wins and the discrepancy is logged — the DOM source has higher
 * confidence because it carries the participant's actual display name.
 *
 * The resolver **wraps** (not replaces) the shared {@link SpeakerIdentityTracker}
 * from the calls module: each resolved identity is forwarded via
 * `tracker.identifySpeaker` so the cross-surface speaker profile list stays
 * coherent across calls and meetings.
 */

import type {
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "@vellumai/meet-contracts";

import type { PromptSpeakerMetadata } from "../calls/speaker-identification.js";
import { SpeakerIdentityTracker } from "../calls/speaker-identification.js";
import { getLogger } from "../util/logger.js";
import {
  type MeetEventSubscriber,
  type MeetEventUnsubscribe,
  subscribeToMeetingEvents,
} from "./event-publisher.js";

const log = getLogger("meet-speaker-resolver");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Window within which a DOM `SpeakerChangeEvent` is considered correlated
 * with a transcript chunk. ±500ms matches the plan's call-out — Deepgram's
 * final chunks usually trail the DOM update by a few hundred ms as the
 * buffer flushes, so a symmetric window is the conservative choice.
 */
export const DOM_CORRELATION_WINDOW_MS = 500;

/** Returned as `speakerName` when neither signal produced a binding. */
export const UNKNOWN_SPEAKER_NAME = "Unknown speaker";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Source of the resolved identity.
 *
 * - `"deepgram"`: a previously-learned `speakerLabel → identity` mapping
 *   was applied.
 * - `"dom-override"`: a DOM `SpeakerChangeEvent` fell inside the
 *   correlation window and supplied the identity.
 * - `"unknown"`: neither signal produced a binding — the caller should
 *   treat this as an unattributed utterance.
 */
export type ResolvedSpeakerConfidence =
  | "deepgram"
  | "dom-override"
  | "unknown";

export interface ResolvedSpeaker {
  /** Stable speaker identifier, if resolved. */
  speakerId: string | undefined;
  /** Display name — falls back to {@link UNKNOWN_SPEAKER_NAME}. */
  speakerName: string;
  /** Which signal produced the identity. See {@link ResolvedSpeakerConfidence}. */
  confidence: ResolvedSpeakerConfidence;
}

export interface MeetSpeakerResolverDeps {
  /** Meeting id — used to subscribe to the matching event stream. */
  meetingId: string;
  /**
   * Optional shared {@link SpeakerIdentityTracker}. Defaults to a fresh
   * per-resolver instance; callers who want the Meet stream to feed the
   * same tracker used by calls should pass theirs here.
   */
  tracker?: SpeakerIdentityTracker;
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

/** A bound `speakerLabel → identity` mapping learned from the DOM stream. */
interface LabelBinding {
  speakerId: string;
  speakerName: string;
}

// ---------------------------------------------------------------------------
// MeetSpeakerResolver
// ---------------------------------------------------------------------------

export class MeetSpeakerResolver {
  private readonly meetingId: string;
  private readonly tracker: SpeakerIdentityTracker;
  private readonly correlationWindowMs: number;
  private readonly unsubscribeFn: MeetEventUnsubscribe;

  /** Most-recent DOM active speaker — updated on every `speaker.change`. */
  private activeSpeaker: ActiveSpeakerSnapshot | null = null;

  /**
   * Bound `speakerLabel → identity` map. Once a label has been bound by a
   * near-in-time DOM event, the mapping sticks until the resolver is
   * disposed — callers drop and recreate the resolver per meeting so
   * stale bindings from a prior meeting can't leak.
   */
  private readonly labelBindings = new Map<string, LabelBinding>();

  constructor(deps: MeetSpeakerResolverDeps) {
    this.meetingId = deps.meetingId;
    this.tracker = deps.tracker ?? new SpeakerIdentityTracker();
    this.correlationWindowMs =
      deps.correlationWindowMs ?? DOM_CORRELATION_WINDOW_MS;

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
   * Mutates internal state (may bind a previously-unmapped
   * `speakerLabel`), so callers should treat this as the single entry
   * point per transcript — do not call twice on the same event.
   */
  resolve(transcript: TranscriptChunkEvent): ResolvedSpeaker {
    const transcriptMs = parseTimestamp(transcript.timestamp);
    const domMatch = this.correlatedActiveSpeaker(transcriptMs);
    const label = transcript.speakerLabel;

    // 1) Bound Deepgram label wins when no DOM disagreement is visible.
    if (label !== undefined) {
      const bound = this.labelBindings.get(label);
      if (bound) {
        // Deepgram says we already know this label → if DOM now disagrees,
        // DOM takes precedence (participant identities outrank stable-but-
        // opaque ASR labels). Log so the divergence is observable.
        if (
          domMatch &&
          (domMatch.speakerId !== bound.speakerId ||
            domMatch.speakerName !== bound.speakerName)
        ) {
          log.warn(
            {
              meetingId: this.meetingId,
              speakerLabel: label,
              deepgramSpeakerId: bound.speakerId,
              deepgramSpeakerName: bound.speakerName,
              domSpeakerId: domMatch.speakerId,
              domSpeakerName: domMatch.speakerName,
            },
            "Meet speaker resolver: Deepgram/DOM disagree — DOM overrides",
          );
          return this.emit({
            speakerId: domMatch.speakerId,
            speakerName: domMatch.speakerName,
            confidence: "dom-override",
          });
        }
        return this.emit({
          speakerId: bound.speakerId,
          speakerName: bound.speakerName,
          confidence: "deepgram",
        });
      }
    }

    // 2) Unbound label (or absent) + DOM match → DOM overrides, and if a
    //    Deepgram label was present we learn it for next time.
    if (domMatch) {
      if (label !== undefined) {
        this.labelBindings.set(label, {
          speakerId: domMatch.speakerId,
          speakerName: domMatch.speakerName,
        });
      }
      return this.emit({
        speakerId: domMatch.speakerId,
        speakerName: domMatch.speakerName,
        confidence: "dom-override",
      });
    }

    // 3) Nothing — unattributed utterance.
    return this.emit({
      speakerId: undefined,
      speakerName: UNKNOWN_SPEAKER_NAME,
      confidence: "unknown",
    });
  }

  /** Tear down the dispatcher subscription. Safe to call multiple times. */
  unsubscribe(): void {
    try {
      this.unsubscribeFn();
    } catch (err) {
      log.warn(
        { err, meetingId: this.meetingId },
        "MeetSpeakerResolver: unsubscribe threw",
      );
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private onSpeakerChange(event: SpeakerChangeEvent): void {
    const timestampMs = parseTimestamp(event.timestamp);
    this.activeSpeaker = {
      speakerId: event.speakerId,
      speakerName: event.speakerName,
      timestampMs,
    };
  }

  /**
   * Return the most-recent DOM active speaker if their `timestamp` is
   * within the correlation window of `transcriptMs`, otherwise `null`.
   *
   * If `transcriptMs` is NaN (unparsable ISO string) we refuse to match —
   * an unbounded window would bind arbitrary labels to whoever spoke last,
   * which is worse than leaving the transcript unattributed.
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
   * Forward the resolved identity to the shared
   * {@link SpeakerIdentityTracker} so cross-surface profile accounting
   * (calls + meetings) stays coherent, then return it.
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
        // SpeakerIdentityTracker is in-memory only, but defend against a
        // future implementation change — a tracker failure must never
        // break transcript attribution.
        log.warn(
          { err, meetingId: this.meetingId },
          "MeetSpeakerResolver: tracker.identifySpeaker threw",
        );
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
