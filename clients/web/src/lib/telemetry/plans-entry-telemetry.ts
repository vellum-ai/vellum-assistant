import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";

/**
 * Entry attribution for the plans takeover — answers "how did the user get to
 * `/assistant/plans`?".
 *
 * Producers navigate via `plansRouteForSource` (in `plans-entry-source.ts`,
 * kept separate so navigation call sites don't import the ingest transport),
 * which tags the URL with `?source=<tag>`; the plans page consumes the tag
 * once on mount and reports it here as a `type: "billing"` event — the
 * billing-surface funnel family (`BillingTelemetryEventSerializer` on the
 * platform), which is session-allowlisted alongside `onboarding` in
 * `SESSION_INGEST_ALLOWED_EVENT_TYPES`. `step` is `plans_viewed` and
 * `entry_source` carries the tag, so the analytics-side breakdown is
 * `stg_telemetry__billing WHERE step = 'plans_viewed' GROUP BY entry_source`.
 * Both are open strings server-side, so a new source needs no platform
 * change; a new *step* in the family is likewise just a new value.
 *
 * Consent is read through the shared `readAnalyticsConsent()` in `lib/` so
 * every producing domain can route here without a cross-domain import
 * (`local/no-cross-domain-imports`).
 */

/**
 * Per-page-load session id, generated once when this module first loads —
 * mirrors the onboarding funnel's `session_id` semantics.
 */
const SESSION_ID = crypto.randomUUID();

interface BillingTelemetryEvent {
  type: "billing";
  daemon_event_id: string;
  recorded_at: number;
  step: string;
  entry_source: string;
  session_id: string;
}

/**
 * Report a plans-takeover view. `source` arrives from the URL, so it is an
 * open string rather than the `PlansEntrySource` union — an unknown tag
 * should surface in the data, not be dropped. Truncated to the serializer's
 * `entry_source` bound (64); a value exceeding it would fail validation and
 * be silently discarded server-side.
 */
export function emitPlansEntryViewed(source: string): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!readAnalyticsConsent()) {
    return;
  }

  const event: BillingTelemetryEvent = {
    type: "billing",
    daemon_event_id: crypto.randomUUID(),
    recorded_at: Date.now(),
    step: "plans_viewed",
    entry_source: source.slice(0, 64),
    session_id: SESSION_ID,
  };

  postTelemetryEvents([event]);
}
