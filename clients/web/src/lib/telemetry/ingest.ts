import { telemetryIngestCreate } from "@/generated/api/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

import { getClientId } from "./client-identity";

/**
 * Drops keys whose value is `undefined` so they are omitted from the wire
 * payload rather than carried as explicit nulls. Callers stamp optional fields
 * (e.g. `user_id`, `outcome`) as `undefined` when absent and rely on this to
 * keep the ingested event shape stable.
 */
function stripUndefined(event: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined),
  );
}

/**
 * Server drop reasons that are working as designed and must not be reported.
 *
 * `analytics_opt_out` is the platform re-checking consent server-side. Every
 * caller already gates on `readAnalyticsConsent()`, so a drop here means the
 * client's cached view of consent lags the server's, which is expected and
 * self-correcting rather than a defect. Reporting it would fire once per flush
 * for every opted-out user.
 */
const EXPECTED_DROP_REASONS = new Set(["analytics_opt_out"]);

/**
 * Ingest failures already reported for this page load, keyed by the condition
 * rather than the event.
 *
 * An ingest rejection is systemic, not per-event: it means this client is
 * emitting something the server contract does not accept (an event type outside
 * the session allowlist, a check name outside the browser's namespace, a
 * serializer that has not shipped yet). One report per condition per page load
 * is enough to see it; one per flush would be a flood.
 */
const reportedFailures = new Set<string>();

function reportIngestFailure(summary: string, extra: Record<string, unknown>) {
  if (reportedFailures.has(summary)) {
    return;
  }
  reportedFailures.add(summary);
  captureError(new Error(summary), {
    context: "telemetry-ingest",
    level: "warning",
    extra,
  });
}

/**
 * Wraps events in the telemetry envelope and fire-and-forgets them to the
 * platform's `/v1/telemetry/ingest/` endpoint via the generated client. The
 * generated client (not a raw fetch) is required: its interceptors attach the
 * session credentials the ingest endpoint authenticates. `keepalive` lets the
 * request outlive a page unload; transport failures are swallowed since
 * telemetry is best-effort.
 *
 * A *contract* failure is not swallowed. The endpoint answers 200 for a batch
 * it accepts and then discards, reporting the per-reason counts in
 * `dropped`, so a client emitting something the server does not permit looks
 * identical to a healthy one from the outside, and the data is simply gone.
 * That is how the whole `client_*` performance family stayed dark after it
 * shipped. Any unexpected rejection or drop is therefore reported to Sentry,
 * in production too, once per condition per page load.
 *
 * Consent is NOT gated here, each caller applies its own opt-out check before
 * calling, because the funnels read consent from different signals.
 */
export function postTelemetryEvents(events: readonly object[]): void {
  void telemetryIngestCreate({
    body: {
      device_id: getClientId(),
      assistant_version: import.meta.env.VITE_APP_VERSION ?? "web-dev",
      events: events.map(stripUndefined),
    },
    keepalive: true,
  })
    .then(({ data, response }) => {
      if (!response?.ok) {
        reportIngestFailure(
          `telemetry ingest rejected with ${response?.status ?? "no response"}`,
          { status: response?.status ?? null },
        );
        return;
      }
      if (!data || data.persisted >= data.accepted) {
        return;
      }
      const unexpected = Object.entries(data.dropped).filter(
        ([reason]) => !EXPECTED_DROP_REASONS.has(reason),
      );
      if (unexpected.length === 0) {
        return;
      }
      const reasons = unexpected.map(([reason]) => reason).sort();
      reportIngestFailure(
        `telemetry ingest dropped events: ${reasons.join(", ")}`,
        { dropped: data.dropped, accepted: data.accepted },
      );
    })
    .catch(() => {});
}

export function __resetTelemetryIngestForTests(): void {
  reportedFailures.clear();
}
