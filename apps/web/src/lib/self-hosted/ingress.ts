/**
 * Module-level state for the currently-resolved self-hosted ingress URL.
 *
 * The web app holds exactly one active assistant at a time
 * (`useAssistantLifecycle` is global, `assistantId` is `string | null`),
 * so a single module-level slot is sufficient — no per-id registry, no
 * lifecycle table. The lifecycle hook calls `setSelfHostedIngressUrl`
 * with the assistant's `ingress_url` when it resolves to
 * `{ kind: "self_hosted" }`, and with `null` when it leaves that state.
 *
 * The HeyAPI request interceptor reads this at request time to decide
 * whether to rewrite a runtime-proxied `/v1/assistants/.../...` URL to
 * the user's gateway. With a `null` URL the interceptor is a no-op and
 * every request flows to the platform as before.
 */

let currentIngressUrl: string | null = null;

export function setSelfHostedIngressUrl(url: string | null): void {
  currentIngressUrl = url;
}

export function getSelfHostedIngressUrl(): string | null {
  return currentIngressUrl;
}
