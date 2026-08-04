/**
 * Mints an opaque id for telemetry grouping keys and client identity.
 *
 * `crypto.randomUUID` is unavailable in non-secure contexts (plain-http LAN
 * dev, self-hosted over http), so fall back rather than throw: client-identity
 * mints on the eager boot import chain, where a throw takes the app down, and
 * client-perf mints on the fire-and-forget telemetry path, where one silently
 * drops every sample.
 *
 * Every field the id lands in is free-form, so a non-UUID is safe:
 * client-identity's `X-Vellum-Client-Id` header and `device_id`, client-perf's
 * `page_load_id` and `daemon_event_id`. The `fallback-` prefix keeps ids minted
 * without `crypto` distinguishable from real UUIDs.
 */
export function mintRandomId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
