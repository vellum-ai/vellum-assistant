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
  /**
   * The onboarding-form values the research turn was run ON — its INPUT, as
   * distinct from the claims/suggestions below (its OUTPUT). Without these a
   * claim cannot be told apart from the form value it merely echoed back, and
   * `installedPlugins` is unattributable (the deterministic floor is keyed on
   * occupation). Excludes the user's name by design: directly identifying, and
   * not needed to judge research quality. Optional throughout — an older web
   * client omits them.
   */
  selfReportedOccupation?: string;
  selfReportedHobbies?: string[];
  selfReportedTimezone?: string;
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
 * `daemon_event_id` is a wire-only override keyed on the conversation id,
 * the same collapse-on-dbt pattern `buildActivationDaemonEventId` uses for
 * activation-funnel rows: a page refresh mid-poll can re-attach to the same
 * research conversation and re-report it (the client's in-memory "already
 * sent" guard resets on remount), so a stable id lets downstream analytics
 * collapse the retry onto the original attempt instead of double-counting
 * it. Scoped to `status: "done"` only: a conversation that timed out client-
 * side is still resumable and may go on to genuinely complete later, and
 * that eventual success must NOT collapse onto (and get masked by) its own
 * earlier provisional timeout report — so a timeout always gets a fresh id
 * (falling back to the row id, same as when there's no conversation at
 * all). The outbox row id stays `id` either way, so flush acks are
 * unaffected.
 *
 * Gated solely by `recordTelemetryOutboxEvent`'s own `share_analytics`
 * consent, like every other outbox-backed event. It carries the model's
 * inferred claims about the user, but the platform re-checks the owner's
 * consent server-side at ingest before persisting, so the daemon does not
 * layer an extra diagnostics gate on top.
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
      daemon_event_id:
        params.status === "done" && params.conversationId
          ? `onboarding_research:${params.conversationId}`
          : id,
      recorded_at: createdAt,
      conversation_id: params.conversationId,
      status: params.status,
      self_reported_occupation: params.selfReportedOccupation,
      self_reported_hobbies: params.selfReportedHobbies,
      self_reported_timezone: params.selfReportedTimezone,
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
