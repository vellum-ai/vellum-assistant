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
 * depending on the route shape:
 *
 *   - `^/webhooks/` — every webhook handler under `/webhooks/*` (Twilio voice,
 *     status, connect-action, voice-verify, Telegram, WhatsApp, email, Resend,
 *     Mailgun, OAuth callback). Provider-side signature validation is
 *     performed by the per-route handlers in the gateway runtime, not by
 *     Velay.
 *   - `^/v1/audio/` — Twilio fetches generated audio URLs directly on the
 *     public surface (see comment at `gateway/src/index.ts` audio route).
 *   - `^/v1/live-voice` — exact match for the live-voice WebSocket. Its cloud
 *     path authenticates with a short-lived, org+assistant-scoped velay WS
 *     token (validated by velay, attested to the gateway via the per-process
 *     bridge proof — see `live-voice-websocket.ts`), so the long-lived local
 *     actor edge JWT is never carried across the velay edge.
 *
 * `/v1/stt/stream` is intentionally NOT tunnel-public. Unlike live-voice, the
 * STT streaming WebSocket has no velay-attested auth path — it authenticates
 * only with the local actor edge JWT. Routing it through velay would force
 * that long-lived, full-access token across the cross-origin platform edge
 * (in the `?token=` query string), letting the platform exfiltrate it. STT
 * streaming is therefore self-hosted-only (the client connects straight to the
 * user's own gateway ingress); cloud STT, if ever wired, must adopt the
 * live-voice token-exchange model instead of being added back here (ATL-713).
 *
 * If you add a new public route to `gateway/src/index.ts` that must be
 * reachable through the Velay tunnel (i.e. anything an external provider
 * calls or any unauthenticated callback endpoint), add a matching pattern
 * here as well. The route-table guard test in `allowed-paths.test.ts` enforces
 * symmetry between the allowlist and the gateway's actual public surface.
 */
export const VELAY_ALLOWED_PATHS: readonly string[] = Object.freeze([
  "^/webhooks/",
  "^/v1/audio/",
  "^/v1/live-voice$",
]);

/**
 * HTTP request header set on the WebSocket upgrade to declare the tunnel's
 * path allowlist to Velay. The value is `JSON.stringify(VELAY_ALLOWED_PATHS)`.
 * Mirrors `RegistrationAllowedPathsHeader` on the platform side.
 */
export const VELAY_ALLOWED_PATHS_HEADER = "X-Vellum-Velay-Allowed-Paths";

/**
 * Encoded header value to attach to the registration WS upgrade. Cached at
 * module load — the allowlist is static for the lifetime of the gateway
 * process.
 */
export const VELAY_ALLOWED_PATHS_HEADER_VALUE =
  JSON.stringify(VELAY_ALLOWED_PATHS);
