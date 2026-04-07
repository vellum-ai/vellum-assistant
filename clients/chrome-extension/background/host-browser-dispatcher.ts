/**
 * host_browser envelope dispatcher.
 *
 * Consumes `host_browser_request` / `host_browser_cancel` envelopes received
 * over the existing browser-relay WebSocket, drives a CdpProxy to execute the
 * CDP command against a resolved debuggee target, and POSTs a result envelope
 * back to the daemon's `/v1/host-browser-result` HTTP endpoint.
 *
 * This module is deliberately transport-agnostic: the `worker.ts` service
 * worker is responsible for pulling envelopes off the WebSocket and calling
 * `handle()` / `cancel()`, and for providing the `resolveTarget` + `postResult`
 * dependency closures. That keeps the dispatcher easy to unit-test in
 * isolation against a mock CdpProxy.
 *
 * Phase 2 / PR 9: this dispatcher is only wired up when the
 * `vellum.cdpProxyEnabled` feature flag is set in `chrome.storage.local`.
 * With the flag off, the legacy `ExtensionCommand` handlers in worker.ts
 * continue to service browser tools exactly as before.
 */

import { createCdpProxy, type CdpProxy } from './cdp-proxy.js';

/**
 * host_browser_request envelope as received over the existing browser-relay
 * WebSocket. Field names use snake_case to match the daemon's ServerMessage
 * discriminator wire format; the canonical Swift + TypeScript types live in
 * their respective message-protocol files.
 */
export interface HostBrowserRequestEnvelope {
  type: 'host_browser_request';
  request_id: string;
  conversation_id: string;
  cdp_method: string;
  cdp_params?: Record<string, unknown>;
  cdp_session_id?: string;
  timeout_seconds?: number;
}

/** host_browser_cancel envelope sent when the daemon side aborts a request. */
export interface HostBrowserCancelEnvelope {
  type: 'host_browser_cancel';
  request_id: string;
}

/**
 * Result envelope POSTed back to the runtime's /v1/host-browser-result
 * endpoint. Shape mirrors the HostBrowserProxy `resolve()` contract on the
 * daemon side: `content` is the stringified CDP result (or error), and
 * `is_error` is true if the CDP command reported a JSON-RPC error envelope
 * or if the dispatcher itself threw before it could reach the result frame.
 */
export interface HostBrowserResultEnvelope {
  request_id: string;
  content: string;
  is_error: boolean;
}

export interface HostBrowserDispatcherDeps {
  /**
   * Target resolver. When `cdpSessionId` is provided it is treated as an
   * opaque `targetId` (matching how the CdpProxy addresses flat sessions via
   * the DebuggerSession target field). Otherwise the resolver should fall
   * back to "most recently active tab".
   */
  resolveTarget(
    cdpSessionId: string | undefined,
  ): Promise<{ tabId?: number; targetId?: string }>;
  /** POST result envelope back to /v1/host-browser-result. */
  postResult(result: HostBrowserResultEnvelope): Promise<void>;
  /** Optional injected CdpProxy for tests. Defaults to a real proxy at runtime. */
  cdpProxy?: CdpProxy;
}

export interface HostBrowserDispatcher {
  handle(envelope: HostBrowserRequestEnvelope): Promise<void>;
  cancel(envelope: HostBrowserCancelEnvelope): void;
  dispose(): void;
}

export function createHostBrowserDispatcher(
  deps: HostBrowserDispatcherDeps,
): HostBrowserDispatcher {
  const proxy = deps.cdpProxy ?? createCdpProxy();
  const inFlight = new Map<string, AbortController>();
  let nextCdpId = 1;

  async function handle(envelope: HostBrowserRequestEnvelope): Promise<void> {
    const abort = new AbortController();
    inFlight.set(envelope.request_id, abort);
    try {
      const target = await deps.resolveTarget(envelope.cdp_session_id);
      await proxy.attach(target, '1.3');
      const frame = await proxy.send(target, {
        id: nextCdpId++,
        method: envelope.cdp_method,
        params: envelope.cdp_params,
        sessionId: envelope.cdp_session_id,
      });
      await deps.postResult({
        request_id: envelope.request_id,
        content: JSON.stringify(frame.error ?? frame.result ?? {}),
        is_error: frame.error != null,
      });
    } catch (err) {
      await deps.postResult({
        request_id: envelope.request_id,
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
    } finally {
      inFlight.delete(envelope.request_id);
    }
  }

  function cancel(envelope: HostBrowserCancelEnvelope): void {
    inFlight.get(envelope.request_id)?.abort();
    inFlight.delete(envelope.request_id);
  }

  function dispose(): void {
    for (const abort of inFlight.values()) abort.abort();
    inFlight.clear();
    proxy.dispose();
  }

  return { handle, cancel, dispose };
}
