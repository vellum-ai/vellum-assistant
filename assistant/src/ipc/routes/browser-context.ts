/**
 * Shared context resolver for `browser_execute` IPC calls.
 *
 * The browser CLI can optionally pass a live conversation ID (for example
 * from `__CONVERSATION_ID` in a nested `bash` tool invocation). When that
 * conversation is currently active in daemon memory, we can reuse its
 * host-browser proxy wiring so browser operations (including `status`) see
 * extension connectivity exactly as the parent turn does.
 *
 * If no resolver is registered, or the requested conversation isn't active,
 * callers fall back to the deterministic `browser-cli:<sessionId>` context.
 */

import type { InterfaceId } from "../../channels/types.js";
import type { HostBrowserProxy } from "../../daemon/host-browser-proxy.js";
import type { TrustClass } from "../../runtime/actor-trust-resolver.js";

export interface BrowserIpcContextResolution {
  conversationId: string;
  trustClass: TrustClass;
  hostBrowserProxy?: HostBrowserProxy;
  transportInterface?: InterfaceId;
}

export type BrowserIpcContextResolver = (
  conversationId: string,
) => BrowserIpcContextResolution | null;

let resolver: BrowserIpcContextResolver | null = null;

export function registerBrowserIpcContextResolver(
  nextResolver: BrowserIpcContextResolver,
): void {
  resolver = nextResolver;
}

/**
 * Test-only helper to clear the module-level resolver.
 *
 * @internal
 */
export function resetBrowserIpcContextResolverForTests(): void {
  resolver = null;
}

export function resolveBrowserIpcContext(params: {
  requestedConversationId?: string;
  fallbackConversationId: string;
}): BrowserIpcContextResolution {
  const { requestedConversationId, fallbackConversationId } = params;

  if (requestedConversationId && resolver) {
    const resolved = resolver(requestedConversationId);
    if (resolved) return resolved;
  }

  return {
    conversationId: fallbackConversationId,
    trustClass: "guardian",
  };
}
