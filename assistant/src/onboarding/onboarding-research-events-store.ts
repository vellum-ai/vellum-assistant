import { recordTelemetryOutboxEvent } from "../telemetry/telemetry-events-outbox.js";
import type {
  OnboardingResearchClaim,
  OnboardingResearchSuggestion,
  OnboardingResearchTelemetryEvent,
} from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

/** Identity of a recorded outbox row; the full payload lives in the outbox. */
export interface OnboardingResearchEvent {
  id: string;
  createdAt: number;
}

export interface RecordOnboardingResearchEventParams {
  conversationId: string | null;
  status: "done" | "error";
  claims: OnboardingResearchClaim[];
  suggestions: OnboardingResearchSuggestion[];
  /** The model's raw top-level `plugins` picks, before the deterministic-floor merge. */
  plugins: string[];
  /** The final resolved install set (deterministic floor ∪ model picks, catalog-filtered). */
  installedPlugins: string[];
}

function countByConfidence(
  claims: OnboardingResearchClaim[],
  confidence: OnboardingResearchClaim["confidence"],
): number {
  return claims.filter((c) => c.confidence === confidence).length;
}

/**
 * Record the settled result of an onboarding "research me" web-search turn.
 * Client-orchestrated: the web client is the only party that knows when the
 * turn completed and what it produced, so it reports the full payload once
 * via the `telemetry_onboarding_research` route. The conversation id is
 * threaded into the outbox row's dedicated column (unlike the general
 * `onboarding` events, which don't set it) so pending rows redact on
 * conversation deletion via an indexed delete.
 *
 * `daemon_event_id` is a wire-only override keyed on the conversation id
 * (falling back to the row id when absent), the same collapse-on-dbt
 * pattern `buildActivationDaemonEventId` uses for activation-funnel rows:
 * a page refresh mid-poll can re-attach to the same research conversation
 * and re-report it (the client's in-memory "already sent" guard resets on
 * remount), so a stable id lets downstream analytics collapse the retry
 * onto the original attempt instead of double-counting it. The outbox row
 * id stays `id`, so flush acks are unaffected.
 *
 * Returns null when usage data collection is disabled or the telemetry
 * database is unavailable.
 */
export function recordOnboardingResearchEvent(
  params: RecordOnboardingResearchEventParams,
): OnboardingResearchEvent | null {
  return recordTelemetryOutboxEvent(
    "onboarding_research",
    (id, createdAt): OnboardingResearchTelemetryEvent => ({
      type: "onboarding_research",
      daemon_event_id: params.conversationId
        ? `onboarding_research:${params.conversationId}`
        : id,
      recorded_at: createdAt,
      conversation_id: params.conversationId,
      status: params.status,
      claims: params.claims,
      claim_count: params.claims.length,
      claims_confident: countByConfidence(params.claims, "confident"),
      claims_maybe: countByConfidence(params.claims, "maybe"),
      claims_guessing: countByConfidence(params.claims, "guessing"),
      suggestions: params.suggestions,
      suggestion_count: params.suggestions.length,
      plugins: params.plugins,
      installed_plugins: params.installedPlugins,
      assistant_version: APP_VERSION,
    }),
    { conversationId: params.conversationId },
  );
}
