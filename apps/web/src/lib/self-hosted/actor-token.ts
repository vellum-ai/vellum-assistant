/**
 * Resolve an actor-audience JWT for a self-hosted assistant.
 *
 * The macOS app obtains this token by completing a `guardian/pair`
 * handshake against the user's gateway (see
 * `clients/shared/Network/GatewayHTTPClient.swift` and
 * `gateway/src/auth/token-exchange.ts`). The token is HMAC-SHA256-signed
 * with claims `aud=vellum-gateway`, `scope_profile=actor_client_v1`, and
 * `sub=actor:{assistant}:{guardian_principal}`. It rides as
 * `Authorization: Bearer <jwt>` on every request to the gateway.
 *
 * The web app will eventually pair the same way — the gateway's
 * `/v1/guardian/init` already accepts `platform: "web"` (see
 * `gateway/src/http/routes/channel-verification-session-proxy.ts`). The
 * pairing UI and the token-storage layer are not yet built. Until they
 * are, this is a stub that returns `null`.
 *
 * With a `null` token the request interceptor still rewrites self-hosted
 * runtime calls to the assistant's ingress, but sends them without an
 * `Authorization` header. The gateway responds 401, the chat surface's
 * conversation list query lands on an error state, and the user sees a
 * clear "couldn't reach your self-hosted assistant" message instead of
 * the indefinite spinner the runtime-proxy 404 produces today.
 *
 * TODO(LUM-XXXX): Replace with the real pairing-bound token retrieval
 * once the web pair flow lands.
 */
export async function getSelfHostedActorToken(
  _assistantId: string,
): Promise<string | null> {
  return null;
}
