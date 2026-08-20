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
 *     status, voice-verify, the media-stream WebSocket upgrade, Telegram,
 *     WhatsApp, email, Resend, Mailgun, OAuth callback).
 *     Provider-side signature validation is performed by the per-route
 *     handlers in the gateway runtime, not by Velay.
 *   - `^/v1/audio/` — Twilio fetches generated audio URLs directly on the
 *     public surface (see comment at `gateway/src/index.ts` audio route).
 *   - `^/v1/live-voice` — exact match for the browser live-voice WebSocket
 *     (the Twilio media-stream WebSocket rides `^/webhooks/`).
 *   - `^/v1/stt/stream` — exact match for the public STT streaming WebSocket.
 *   - `^/assistant/credentials/enter$` — the gateway-served one-time
 *     credential entry page (self-contained HTML; the single-use token rides
 *     the URL fragment, which never reaches Velay or the gateway logs).
 *   - `^/v1/credential-requests/(peek|submit)$` — the entry page's
 *     unauthenticated API calls; the single-use token travels in the POST
 *     body and is validated by the gateway handlers.
 *
 *   - `^/v1/watch/stream` — exact match for the browser watch-session
 *     WebSocket, which carries a session's narration audio.
 *
 * `/v1/watch/stream` was deliberately absent until the client could use it.
 * The note that stood here argued the entry was premature on its own, and it
 * was right: an allowlist pattern with no client that dials the route opens a
 * public managed route which still cannot carry a session, and nothing fails
 * to say so. That is no longer the case. `resolveWatchStreamWsUrl` picks the
 * velay transport for a managed assistant, and velay validates the minted
 * token on this path the way it does live voice's, so the entry is now the
 * last step of the work rather than the first.
 *
 * One claim in that note was wrong and is worth not repeating: it read as
 * though a managed assistant could not have a locally connected `host_cu`
 * desktop client. Managed assistants reach the user's machine through the
 * desktop host proxy, which is how computer use already works for them. What
 * genuinely has no transport is a *paired* assistant, whose gateway proxy is
 * HTTP-only, and the client still refuses those outright
 * (`isPairedGatewayIngress` in
 * `clients/web/src/domains/chat/voice/live-voice/connection.ts`).
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
  "^/v1/stt/stream$",
  "^/v1/watch/stream$",
  "^/assistant/credentials/enter$",
  "^/v1/credential-requests/(peek|submit)$",
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
