/**
 * Mints an opaque id for telemetry grouping keys and client identity.
 *
 * `crypto.randomUUID` is unavailable in non-secure contexts (plain-http LAN
 * dev, self-hosted over http), so fall back rather than throw. The callers sit
 * on the eager boot import chain and on the fire-and-forget telemetry path,
 * where a throw either takes the app down or silently drops every sample.
 *
 * Both consumers treat the result as an opaque string: the daemon reads
 * `X-Vellum-Client-Id` as a free-form header and the platform's ingest
 * endpoint stores `device_id` as a free-form field. The `fallback-` prefix
 * marks ids minted without `crypto` so they stay distinguishable downstream
 * from real UUIDs.
 */
export function mintRandomId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
