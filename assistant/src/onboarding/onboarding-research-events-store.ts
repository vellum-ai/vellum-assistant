import {
  getCachedShareDiagnostics,
  getCachedShareDiagnosticsVersion,
} from "../platform/consent-cache.js";
import { recordTelemetryOutboxEvent } from "../telemetry/telemetry-events-outbox.js";
import { isDiagnosticsConsentVersionEligible } from "../telemetry/trace-collection-policy.js";
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
 * Gated on `share_diagnostics` (at an eligible accepted version), on top of
 * `recordTelemetryOutboxEvent`'s own `share_analytics` gate: the payload
 * carries the model's raw inferred claims about the user (role, location,
 * employer, hobbies — verbatim text, not just metadata), the same class of
 * conversation-content PII `turnSource` requires `share_diagnostics` for
 * before attaching a trace. Fail-closed, mirroring that gate exactly.
 *
 * Returns null when usage data collection is disabled, diagnostics consent
 * isn't (yet) eligible, or the telemetry database is unavailable.
 */
export function recordOnboardingResearchEvent(
  params: RecordOnboardingResearchEventParams,
): OnboardingResearchEvent | null {
  if (
    !getCachedShareDiagnostics() ||
    !isDiagnosticsConsentVersionEligible(getCachedShareDiagnosticsVersion())
  ) {
    return null;
  }
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
