/**
 * In-memory routing table for self-hosted assistants.
 *
 * The HeyAPI clients (`@/generated/api/client.gen.js`,
 * `@/generated/auth/client.gen.js`) are configured against the platform's
 * base URL — that's correct for managed assistants, where the platform's
 * `RuntimeProxyView` forwards runtime calls to the assistant's pod via
 * vembda.
 *
 * For self-hosted assistants the runtime lives on the user's machine and
 * is reachable at `assistant.ingress_url`. The platform's proxy view
 * explicitly filters self-hosted assistants out of its queryset
 * (`_AssistantAPIView.get_queryset` in
 * `vellum-assistant-platform/django/app/assistant/views.py`), so any
 * runtime-proxied call against the platform 404s. The SPA has to talk
 * to the user's gateway directly instead.
 *
 * This module owns that routing decision. The lifecycle hook
 * (`use-assistant-lifecycle.ts`) registers the assistant's `ingress_url`
 * here when the assistant resolves to `{ kind: "self_hosted" }`; the
 * request interceptor (`api-interceptors.ts`) consults the registry on
 * every outbound request to decide whether to forward to the platform
 * (default) or rewrite to the self-hosted ingress.
 *
 * State is intentionally in-memory only — there is no persistence and no
 * cross-tab sync. The lifecycle hook re-populates the registry on every
 * page load, so a stale ingress URL is corrected within one assistant
 * status fetch.
 */

export interface SelfHostedRouting {
  assistantId: string;
  ingressUrl: string;
}

const routingByAssistantId = new Map<string, SelfHostedRouting>();

/**
 * Record that requests for the given assistant should be routed to its
 * self-hosted ingress. Overwrites any previous entry for the same id.
 */
export function registerSelfHostedAssistant(
  assistantId: string,
  ingressUrl: string,
): void {
  routingByAssistantId.set(assistantId, { assistantId, ingressUrl });
}

/**
 * Remove the routing entry for the given assistant. The lifecycle hook
 * calls this when an assistant flips from `self_hosted` back to
 * managed-active — without it, a stale entry would keep rerouting
 * runtime calls to a gateway that no longer owns the assistant.
 */
export function unregisterSelfHostedAssistant(assistantId: string): void {
  routingByAssistantId.delete(assistantId);
}

/**
 * Returns the routing entry for `assistantId` if one is registered.
 */
export function getSelfHostedRouting(
  assistantId: string,
): SelfHostedRouting | undefined {
  return routingByAssistantId.get(assistantId);
}

/**
 * Test-only — drops every entry from the registry. Production code paths
 * should never call this; the lifecycle hook owns lifetime management.
 */
export function __resetSelfHostedRegistryForTests(): void {
  routingByAssistantId.clear();
}
