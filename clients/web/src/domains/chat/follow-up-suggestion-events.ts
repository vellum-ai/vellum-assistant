import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";

/**
 * Telemetry for the follow-up suggestion chips under the latest assistant
 * reply: one impression per reply whose chips rendered, one click per chip
 * picked. Together they give the surface a click-through rate.
 *
 * Neither event carries a chip's text. A suggestion is written from the user's
 * own conversation, so its words are user-derived content; the click event
 * records the text's length instead, which is enough to tell whether long
 * suggestions are picked less often.
 *
 * Consent rides the shared `readAnalyticsConsent()` — the same decision every
 * other emitter gates on — read from `lib/` so the chat domain does not import
 * onboarding directly (`local/no-cross-domain-imports`).
 */

export const FOLLOW_UP_SUGGESTION_IMPRESSION_EVENT =
  "follow_up_suggestion_impression";
export const FOLLOW_UP_SUGGESTION_CLICK_EVENT = "follow_up_suggestion_click";

/** Identifies the reply a chip row hangs under. */
export interface FollowUpSuggestionContext {
  assistantId: string | null;
  conversationId: string | null;
  /** Id of the completed assistant message the chips follow. */
  messageId: string;
  /**
   * True when the chips stand in place of the composer's ghost text, read from
   * the `follow-up-suggestions` flag rather than assumed. Both surfaces answer
   * "what would you say next", so today the flag decides which one appears and
   * this rides every row as the cohort marker; an arm that shows both stays
   * distinguishable without a second event.
   */
  ghostTextSuppressed: boolean;
}

interface FollowUpSuggestionEventBase {
  daemon_event_id: string;
  recorded_at: number;
  assistant_id: string | null;
  conversation_id: string | null;
  message_id: string;
  ghost_text_suppressed: boolean;
}

export interface FollowUpSuggestionImpressionEvent extends FollowUpSuggestionEventBase {
  type: typeof FOLLOW_UP_SUGGESTION_IMPRESSION_EVENT;
  suggestion_count: number;
  /**
   * The rendered chips' index positions. Redundant with `suggestion_count`
   * while the row is a contiguous prefix, and kept anyway so a click's
   * `suggestion_index` always has a matching impression position to join on.
   */
  suggestion_indexes: number[];
}

export interface FollowUpSuggestionClickEvent extends FollowUpSuggestionEventBase {
  type: typeof FOLLOW_UP_SUGGESTION_CLICK_EVENT;
  suggestion_index: number;
  /** Character length of the picked chip's text. Never the text itself. */
  suggestion_length: number;
}

/**
 * The impression's collapse key. A deterministic id per assistant message, so
 * a reload that re-renders the same reply's chips lands on the row already
 * ingested instead of counting a second impression.
 */
export function followUpSuggestionImpressionEventId(messageId: string): string {
  return `follow_up_suggestion:impression:${messageId}`;
}

function baseEvent(
  context: FollowUpSuggestionContext,
  daemonEventId: string,
): FollowUpSuggestionEventBase {
  return {
    daemon_event_id: daemonEventId,
    recorded_at: Date.now(),
    assistant_id: context.assistantId,
    conversation_id: context.conversationId,
    message_id: context.messageId,
    ghost_text_suppressed: context.ghostTextSuppressed,
  };
}

export function buildFollowUpSuggestionImpressionEvent(
  context: FollowUpSuggestionContext,
  suggestionIndexes: readonly number[],
): FollowUpSuggestionImpressionEvent {
  return {
    ...baseEvent(
      context,
      followUpSuggestionImpressionEventId(context.messageId),
    ),
    type: FOLLOW_UP_SUGGESTION_IMPRESSION_EVENT,
    suggestion_count: suggestionIndexes.length,
    suggestion_indexes: [...suggestionIndexes],
  };
}

/**
 * Builds the click event from the picked chip.
 *
 * Takes the suggestion text and returns only its length, so the one place that
 * touches a chip's words is the one place that drops them.
 */
export function buildFollowUpSuggestionClickEvent(
  context: FollowUpSuggestionContext,
  pick: { index: number; suggestion: string },
): FollowUpSuggestionClickEvent {
  return {
    ...baseEvent(context, crypto.randomUUID()),
    type: FOLLOW_UP_SUGGESTION_CLICK_EVENT,
    suggestion_index: pick.index,
    suggestion_length: pick.suggestion.length,
  };
}

/**
 * Message ids whose impression has already been sent this page load. The
 * claim outlives the component so a remount of the same reply's chips — a
 * transcript re-render, a React StrictMode double-effect — reports once.
 */
const reportedImpressions = new Set<string>();

/**
 * Bound on the claim set. A long conversation would otherwise grow it for the
 * life of the page; a claim is only worth keeping while its reply can still be
 * re-rendered, and the surface only ever renders under the latest one.
 */
const MAX_REPORTED_IMPRESSIONS = 100;

function claimImpression(messageId: string): boolean {
  if (reportedImpressions.has(messageId)) {
    return false;
  }
  reportedImpressions.add(messageId);
  while (reportedImpressions.size > MAX_REPORTED_IMPRESSIONS) {
    const oldest = reportedImpressions.values().next();
    if (oldest.done) {
      break;
    }
    reportedImpressions.delete(oldest.value);
  }
  return true;
}

function canEmit(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return readAnalyticsConsent();
}

/**
 * Report that a reply's chips rendered. At most one event per message id per
 * page load; the ingest-side collapse key covers the rest.
 */
export function emitFollowUpSuggestionImpression(
  context: FollowUpSuggestionContext,
  suggestionIndexes: readonly number[],
): void {
  if (suggestionIndexes.length === 0) {
    return;
  }
  if (!canEmit()) {
    return;
  }
  if (!claimImpression(context.messageId)) {
    return;
  }
  postTelemetryEvents([
    buildFollowUpSuggestionImpressionEvent(context, suggestionIndexes),
  ]);
}

/** Report a chip press. Every press counts, including a retry after a blocked send. */
export function emitFollowUpSuggestionClick(
  context: FollowUpSuggestionContext,
  pick: { index: number; suggestion: string },
): void {
  if (!canEmit()) {
    return;
  }
  postTelemetryEvents([buildFollowUpSuggestionClickEvent(context, pick)]);
}

export function __resetFollowUpSuggestionEventsForTests(): void {
  reportedImpressions.clear();
}
