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
 * Wraps events in the telemetry envelope and fire-and-forgets them to the
 * platform's `/v1/telemetry/ingest/` endpoint. `keepalive` lets the request
 * outlive a page unload, and failures are swallowed since telemetry is
 * best-effort.
 *
 * Consent is NOT gated here — each caller applies its own opt-out check before
 * calling, because the funnels read consent from different signals.
 */
export function postTelemetryEvents(events: readonly object[]): void {
  const payload = JSON.stringify({
    device_id: getClientId(),
    assistant_version: import.meta.env.VITE_APP_VERSION ?? "web-dev",
    events: events.map(stripUndefined),
  });

  void fetch("/v1/telemetry/ingest/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}
