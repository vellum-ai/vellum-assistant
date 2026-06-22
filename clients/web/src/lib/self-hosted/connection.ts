/**
 * Module-level state for the currently-resolved self-hosted assistant
 * connection.
 *
 * The web app holds exactly one active assistant at a time
 * (`useAssistantLifecycle` is global, `assistantId` is `string | null`),
 * so a single module-level connection slot is sufficient — no per-id
 * registry, no lifecycle table. The lifecycle hook calls
 * `setSelfHostedConnection({url, token})` when an assistant resolves to
 * `{ kind: "self_hosted" }`, and `setSelfHostedConnection(null)` when it
 * leaves that state (or transitions to `active`).
 *
 * The HeyAPI request interceptor reads the two slots independently:
 *   - `getSelfHostedIngressUrl()` to decide whether to rewrite a
 *     runtime-proxied `/v1/assistants/.../...` URL to the gateway.
 *   - `getSelfHostedActorToken()` to decide whether to attach an
 *     `Authorization: Bearer` header to the rewritten request.
 *
 * Both slots are null by default — the interceptor is a no-op until the
 * lifecycle hook primes them, and every request flows to the platform
 * as before.
 */

interface SelfHostedConnection {
  /**
   * The user's gateway hostname for this assistant (from
   * `AssistantSerializer.ingress_url`). May be null briefly between
   * `is_local=true` flipping and the gateway registering its public
   * hostname — runtime calls fall through to the platform's proxy view
   * in that window.
   */
  url: string | null;
  /**
   * The platform's actor token for this assistant (from
   * `AssistantSerializer.platform_actor_token`). May be null briefly
   * after hatch while `bootstrap_platform_actor_token` runs — the
   * interceptor sends the request without `Authorization` in that
   * window and the gateway responds 401, which the chat surface
   * renders as an error state.
   */
  token: string | null;
}

let current: SelfHostedConnection = { url: null, token: null };

export function setSelfHostedConnection(
  connection: SelfHostedConnection | null,
): void {
  current = connection === null
    ? { url: null, token: null }
    : { url: connection.url, token: connection.token };
}

export function getSelfHostedIngressUrl(): string | null {
  return current.url;
}

export function getSelfHostedActorToken(): string | null {
  return current.token;
}
