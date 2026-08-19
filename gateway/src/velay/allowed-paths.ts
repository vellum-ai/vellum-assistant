/**
 * Tunnel path allowlist sent to Velay on the WS upgrade request via the
 * {@link VELAY_ALLOWED_PATHS_HEADER} HTTP header. Velay parses the JSON-encoded
 * regex array on the platform side
 * ({@link
 *   https://github.com/vellum-ai/vellum-assistant-platform/blob/main/velay/internal/velay/protocol.go
 *   `RegistrationAllowedPathsHeader`})
 * and enforces it for every inbound HTTP and WebSocket proxy request routed
 * to this tunnel.
 *
 * Each entry is a Go RE2 regex string. Patterns are anchored at the start
 * (`^/...`) and either prefix-bound (trailing `/`) or exactly anchored (`$`)
 * depending on the route shape. Provider-side signature validation is
 * performed by the per-route handlers in the gateway runtime, not by Velay.
 *
 * If you add a new public route to `gateway/src/index.ts` that must be
 * reachable through the Velay tunnel (i.e. anything an external provider
 * calls or any unauthenticated callback endpoint), add a matching pattern
 * here as well. Webhook routes instead go in the webhook ingress registry,
 * which {@link buildVelayAllowedPathsHeaderValue} advertises row by row. The
 * route-table guard test in `allowed-paths.test.ts` enforces symmetry between
 * the allowlist and the gateway's actual public surface.
 */

import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";

/**
 * Public routes outside the webhook namespace:
 *
 *   - `^/v1/audio/`: Twilio fetches generated audio URLs directly on the
 *     public surface (see comment at `gateway/src/index.ts` audio route).
 *   - `^/v1/live-voice$`: the browser live-voice WebSocket (the Twilio
 *     media-stream WebSocket rides the Twilio webhook prefix).
 *   - `^/v1/stt/stream$`: the public STT streaming WebSocket.
 *   - `^/assistant/credentials/enter$`: the gateway-served one-time
 *     credential entry page (self-contained HTML; the single-use token rides
 *     the URL fragment, which never reaches Velay or the gateway logs).
 *   - `^/v1/credential-requests/(peek|submit)$`: the entry page's
 *     unauthenticated API calls; the single-use token travels in the POST
 *     body and is validated by the gateway handlers.
 */
const VELAY_NON_WEBHOOK_ALLOWED_PATHS: readonly string[] = Object.freeze([
  "^/v1/audio/",
  "^/v1/live-voice$",
  "^/v1/stt/stream$",
  "^/assistant/credentials/enter$",
  "^/v1/credential-requests/(peek|submit)$",
]);

/**
 * Twilio reaches the gateway on paths carrying call state in their segments
 * (`/webhooks/twilio/media-stream/<callSessionId>/<token>`), which an
 * exact-match registry row cannot express, so the whole Twilio subtree stays a
 * prefix rule.
 */
const VELAY_TWILIO_WEBHOOKS_PATH = "^/webhooks/twilio/";

/**
 * Every handler under `/webhooks/*`: Twilio voice, status, voice-verify, the
 * media-stream WebSocket upgrade, Telegram, WhatsApp, email, Resend, Mailgun,
 * the OAuth callback, and plugin-declared webhooks.
 */
const VELAY_WEBHOOKS_WILDCARD_PATH = "^/webhooks/";

/** The rules advertised while `velay-webhooks` is off. */
export const VELAY_ALLOWED_PATHS: readonly string[] = Object.freeze([
  VELAY_WEBHOOKS_WILDCARD_PATH,
  ...VELAY_NON_WEBHOOK_ALLOWED_PATHS,
]);

/**
 * The rules that hold whatever the webhook ingress registry contains.
 * {@link buildVelayAllowedPathsHeaderValue} appends one exact-match rule per
 * registered webhook path to these.
 */
export const VELAY_STATIC_ALLOWED_PATHS: readonly string[] = Object.freeze([
  VELAY_TWILIO_WEBHOOKS_PATH,
  ...VELAY_NON_WEBHOOK_ALLOWED_PATHS,
]);

/**
 * HTTP request header set on the WebSocket upgrade to declare the tunnel's
 * path allowlist to Velay. Mirrors `RegistrationAllowedPathsHeader` on the
 * platform side.
 */
export const VELAY_ALLOWED_PATHS_HEADER = "X-Vellum-Velay-Allowed-Paths";

/** Encoded header value advertised while `velay-webhooks` is off. */
export const VELAY_ALLOWED_PATHS_HEADER_VALUE =
  JSON.stringify(VELAY_ALLOWED_PATHS);

/**
 * Gates whether the webhook namespace is advertised as one wildcard rule or as
 * one exact rule per registered path.
 */
export const VELAY_WEBHOOKS_FLAG_KEY = "velay-webhooks";

const RE2_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Escape `value` so it matches only itself under both RE2 and JavaScript. */
function escapeForRe2(value: string): string {
  return value.replace(RE2_METACHARACTERS, "\\$&");
}

/**
 * The header value to advertise for a tunnel serving `registeredPaths`.
 *
 * With `velay-webhooks` off this is the wildcard allowlist. With it on the
 * webhook namespace narrows to exactly the registered paths, so Velay drops
 * anything else under `/webhooks/` before it reaches the gateway.
 */
export function buildVelayAllowedPathsHeaderValue(
  registeredPaths: string[],
): string {
  if (!isFeatureFlagEnabled(VELAY_WEBHOOKS_FLAG_KEY)) {
    return VELAY_ALLOWED_PATHS_HEADER_VALUE;
  }
  return JSON.stringify([
    ...VELAY_STATIC_ALLOWED_PATHS,
    ...registeredPaths.map((path) => `^${escapeForRe2(path)}$`),
  ]);
}
