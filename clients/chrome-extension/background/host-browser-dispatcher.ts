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

import {
  createCdpProxy,
  type CdpDebuggee,
  type CdpProxy,
  type CdpTarget,
} from './cdp-proxy.js';

/**
 * host_browser_request envelope as received over the existing browser-relay
 * WebSocket. Field names are camelCase to match the daemon's ServerMessage
 * discriminator wire format — see
 * `assistant/src/daemon/message-types/host-browser.ts` for the canonical
 * types. Note `timeout_seconds` is the one snake_case field the daemon emits
 * (a holdover from Phase 1) and we preserve it as-is.
 */
export interface HostBrowserRequestEnvelope {
  type: 'host_browser_request';
  requestId: string;
  conversationId: string;
  cdpMethod: string;
  cdpParams?: Record<string, unknown>;
  cdpSessionId?: string;
  timeout_seconds?: number;
}

/** host_browser_cancel envelope sent when the daemon side aborts a request. */
export interface HostBrowserCancelEnvelope {
  type: 'host_browser_cancel';
  requestId: string;
}

/**
 * Result envelope POSTed back to the runtime's /v1/host-browser-result
 * endpoint. Shape mirrors the runtime Zod schema in
 * `assistant/src/runtime/routes/host-browser-routes.ts` (`requestId`,
 * `content`, `isError`): `content` is the stringified CDP result (or error),
 * and `isError` is true if the CDP command reported a JSON-RPC error
 * envelope or if the dispatcher itself threw before it could reach the
 * result frame.
 */
export interface HostBrowserResultEnvelope {
  requestId: string;
  content: string;
  isError: boolean;
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

/**
 * Stable string key for an attach-tracking set. A CdpTarget is either a
 * numeric `tabId` or an opaque `targetId` string — we serialize whichever
 * is set into a prefix-disambiguated key so tabId=123 and targetId="123"
 * can't collide.
 */
function targetKey(target: CdpTarget): string {
  if (target.targetId) return `targetId:${target.targetId}`;
  if (target.tabId !== undefined) return `tabId:${target.tabId}`;
  throw new Error('CdpTarget must have either tabId or targetId');
}

/**
 * Build the same target-key from a `CdpDebuggee` payload as `targetKey`
 * does for a `CdpTarget`. The CDP proxy's `onDetach` callback receives a
 * `CdpDebuggee` (the chrome.debugger Debuggee shape), so we need a helper
 * that produces an identical key from that variant — otherwise the cache
 * deletion on detach would silently miss and the stale entry would persist.
 *
 * Returns `null` when the debuggee shape carries neither a `tabId` nor a
 * `targetId` (e.g. extensionId-only attaches, which the dispatcher does
 * not currently use). Callers treat null as "nothing to invalidate".
 */
function debuggeeKey(debuggee: CdpDebuggee): string | null {
  if (debuggee.targetId) return `targetId:${debuggee.targetId}`;
  if (debuggee.tabId !== undefined) return `tabId:${debuggee.tabId}`;
  return null;
}

export function createHostBrowserDispatcher(
  deps: HostBrowserDispatcherDeps,
): HostBrowserDispatcher {
  const proxy = deps.cdpProxy ?? createCdpProxy();
  const inFlight = new Map<string, AbortController>();
  // Track which targets we've already attached to so repeat commands
  // against the same tab/session don't unnecessarily call attach again.
  // Chrome treats a second attach as a hard failure ("Another debugger is
  // already attached..."), so either we dedupe here or we catch the error.
  // Deduping is cheaper and keeps the happy path clean.
  const attachedTargets = new Set<string>();
  let nextCdpId = 1;

  // Invalidate the attached-targets cache whenever Chrome notifies us that
  // it has detached the debugger from a target. This covers tab close,
  // navigation across security origins, the user clicking "Cancel" on the
  // chrome.debugger infobar, and another debugger taking over via
  // Target.attachToTarget. Without this subscription the cache would hold
  // a stale entry forever and subsequent commands against the same target
  // would skip the re-attach and hit a permanent CDP failure.
  const unsubscribeOnDetach = proxy.onDetach((debuggee) => {
    const key = debuggeeKey(debuggee);
    if (key !== null) attachedTargets.delete(key);
  });

  async function handle(envelope: HostBrowserRequestEnvelope): Promise<void> {
    const abort = new AbortController();
    inFlight.set(envelope.requestId, abort);
    try {
      const target = await deps.resolveTarget(envelope.cdpSessionId);
      const key = targetKey(target);
      if (!attachedTargets.has(key)) {
        try {
          await proxy.attach(target, '1.3');
          attachedTargets.add(key);
        } catch (attachErr) {
          // Tolerate the "already attached" race: Chrome surfaces this as
          // "Another debugger is already attached to the tab with id: N."
          // when a concurrent sibling request or an earlier invocation that
          // predates this dispatcher instance already owns the debuggee.
          // Treat it as success and record the target as attached. The
          // match is case-insensitive because Chrome's wording has shifted
          // across versions and across extensionId/tabId/targetId variants.
          const msg = (
            attachErr instanceof Error ? attachErr.message : String(attachErr)
          ).toLowerCase();
          if (msg.includes('already attached')) {
            attachedTargets.add(key);
          } else {
            throw attachErr;
          }
        }
      }
      const frame = await proxy.send(target, {
        id: nextCdpId++,
        method: envelope.cdpMethod,
        params: envelope.cdpParams,
        sessionId: envelope.cdpSessionId,
      });
      await deps.postResult({
        requestId: envelope.requestId,
        content: JSON.stringify(frame.error ?? frame.result ?? {}),
        isError: frame.error != null,
      });
    } catch (err) {
      // Guard the failure-path postResult in its own try/catch: if the HTTP
      // POST itself fails (e.g. the relay socket is torn down while we're
      // in the error path) we must NOT let that secondary rejection escape
      // to the Chrome service worker as an unhandled promise rejection.
      try {
        await deps.postResult({
          requestId: envelope.requestId,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      } catch (postErr) {
        console.error(
          '[host-browser-dispatcher] Failed to post error result for',
          envelope.requestId,
          postErr,
        );
      }
    } finally {
      inFlight.delete(envelope.requestId);
    }
  }

  function cancel(envelope: HostBrowserCancelEnvelope): void {
    inFlight.get(envelope.requestId)?.abort();
    inFlight.delete(envelope.requestId);
  }

  function dispose(): void {
    for (const abort of inFlight.values()) abort.abort();
    inFlight.clear();
    attachedTargets.clear();
    unsubscribeOnDetach();
    proxy.dispose();
  }

  return { handle, cancel, dispose };
}
