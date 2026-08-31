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
 * Ingest failure conditions (`rejected:<status>`, `dropped:<reason>`) already
 * reported for this page load.
 *
 * An ingest failure is systemic, not per-event: it means this client emits
 * something the server contract does not accept (an event type outside the
 * session allowlist, a serializer that has not shipped yet). One report per
 * condition per page load is enough to see it; one per flush would be a flood.
 */
const reportedConditions = new Set<string>();

/**
 * Filters to the conditions not yet reported this page load and marks them,
 * per condition rather than per batch, so a reason that already fired alone
 * cannot fire again by arriving alongside a new one.
 */
function claimUnreported(conditions: readonly string[]): string[] {
  const fresh = conditions.filter(
    (condition) => !reportedConditions.has(condition),
  );
  for (const condition of fresh) {
    reportedConditions.add(condition);
  }
  return fresh;
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
 * it accepts and then discards, reporting the per-reason counts in `dropped`,
 * so an accepted-but-dropped batch is invisible unless the response body is
 * read. Unexpected rejections and drops are therefore reported to Sentry, in
 * every build, once per condition per page load.
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
        const status = response?.status ?? null;
        if (claimUnreported([`rejected:${status ?? "no-response"}`]).length) {
          captureError(
            new Error(
              `telemetry ingest rejected with ${status ?? "no response"}`,
            ),
            {
              context: "telemetry-ingest",
              level: "warning",
              extra: { status },
            },
          );
        }
        return;
      }
      if (!data || data.persisted >= data.accepted) {
        return;
      }
      const unexpected = Object.keys(data.dropped)
        .filter((reason) => !EXPECTED_DROP_REASONS.has(reason))
        .sort();
      const fresh = claimUnreported(
        unexpected.map((reason) => `dropped:${reason}`),
      );
      if (fresh.length === 0) {
        return;
      }
      const freshReasons = fresh.map((condition) =>
        condition.slice("dropped:".length),
      );
      captureError(
        new Error(
          `telemetry ingest dropped events: ${freshReasons.join(", ")}`,
        ),
        {
          context: "telemetry-ingest",
          level: "warning",
          extra: { dropped: data.dropped, accepted: data.accepted },
        },
      );
    })
    .catch(() => {});
}

export function __resetTelemetryIngestForTests(): void {
  reportedConditions.clear();
}
