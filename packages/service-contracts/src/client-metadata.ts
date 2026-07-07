/**
 * Client-metadata analytics headers.
 *
 * The web client attaches these to every daemon request via
 * `getClientRegistrationHeaders()` (`clients/web/src/lib/telemetry/
 * client-identity.ts`), the gateway allows them through webview CORS
 * (`gateway/src/http/middleware/cors.ts`) and forwards them to the daemon
 * by `x-vellum-*` prefix, and the daemon persists them under
 * `metadata.client` on user messages (`handleSendMessage`), where
 * `turn-events-store` projects them onto `TurnTelemetryEvent.client` for
 * downstream analytics.
 *
 * Keys are the persisted `metadata.client` field names; values are the
 * lowercase HTTP header names (HTTP header matching is case-insensitive).
 */
export const CLIENT_METADATA_HEADERS = {
  browser_family: "x-vellum-browser-family",
  browser_version: "x-vellum-browser-version",
  os: "x-vellum-client-os",
  interface_version: "x-vellum-interface-version",
} as const;

export type ClientMetadataField = keyof typeof CLIENT_METADATA_HEADERS;

/**
 * Bound on client-metadata header values: lowercase alphanumerics plus
 * dot / underscore / dash, at most 64 chars. Enforced identically by the
 * sender (web client) and the reader (daemon) so malformed or oversized
 * values are dropped rather than transmitted or persisted.
 */
const CLIENT_METADATA_VALUE_RE = /^[a-z0-9._-]{1,64}$/;

/**
 * Normalize a candidate client-metadata value (trim + lowercase) and
 * validate it against {@link CLIENT_METADATA_VALUE_RE}. Returns `undefined`
 * for empty or out-of-bounds values.
 */
export function sanitizeClientMetadataValue(
  value: string | undefined | null,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return CLIENT_METADATA_VALUE_RE.test(normalized) ? normalized : undefined;
}
