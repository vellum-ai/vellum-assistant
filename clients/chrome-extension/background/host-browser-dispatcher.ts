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
 */

import {
  createCdpProxy,
  type CdpDebuggee,
  type CdpEventFrame,
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

/**
 * Unsolicited CDP event envelope forwarded from the extension to the
 * runtime. Mirrors the `HostBrowserEvent` client-message type in
 * `assistant/src/daemon/message-types/host-browser.ts`. The dispatcher
 * builds one of these for every `chrome.debugger.onEvent` firing and
 * hands it off to the worker's `onCdpEvent` hook, which is responsible
 * for pushing the frame onto the browser-relay WebSocket.
 */
export interface HostBrowserEventEnvelope {
  type: 'host_browser_event';
  method: string;
  params?: unknown;
  cdpSessionId?: string;
}

/**
 * Session-invalidation envelope forwarded from the extension to the
 * runtime. Mirrors the `HostBrowserSessionInvalidated` client-message
 * type in `assistant/src/daemon/message-types/host-browser.ts`. The
 * dispatcher builds one of these whenever
 * `chrome.debugger.onDetach` fires and hands it off to the worker's
 * `onSessionInvalidated` hook; the worker ships it over the relay
 * WebSocket so the runtime can evict any stale `BrowserSessionManager`
 * session and force a reattach on the next command.
 *
 * `targetId` is the string form of the detached debuggee's `tabId`
 * (most common) or `targetId` (flat-session path). When the detach
 * carries neither the field is omitted — the runtime tolerates the
 * shape but the invalidation becomes advisory.
 */
export interface HostBrowserSessionInvalidatedEnvelope {
  type: 'host_browser_session_invalidated';
  targetId?: string;
  reason?: string;
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
  /**
   * Optional hook invoked for every `chrome.debugger.onEvent` firing.
   * The worker wires this to {@link postHostBrowserEvent} so the
   * envelope is forwarded over the active relay WebSocket. Errors
   * thrown from the hook are caught and logged — a broken forwarder
   * must never take down the dispatcher's event subscription.
   *
   * When omitted, CDP events are observed and dropped. Useful for
   * unit tests that don't care about the forwarding side.
   */
  forwardCdpEvent?: (event: HostBrowserEventEnvelope) => void;
  /**
   * Optional hook invoked for every `chrome.debugger.onDetach` firing
   * after the dispatcher has evicted its local attach cache. The
   * worker wires this to {@link postHostBrowserSessionInvalidated}
   * so the runtime-side session state can be evicted in lockstep.
   * Errors thrown from the hook are caught and logged.
   *
   * When omitted, detach signals still clear the local cache but are
   * not forwarded to the runtime — useful for unit tests that exercise
   * the cache eviction semantics in isolation.
   */
  forwardSessionInvalidated?: (
    event: HostBrowserSessionInvalidatedEnvelope,
  ) => void;
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
  // Track request IDs that were cancelled while in flight so we can
  // suppress the late `postResult` call when the underlying CDP command
  // eventually settles. This is the core deterministic-cancel guarantee:
  // once the daemon has told us an in-flight request is cancelled, we
  // must never deliver a result frame for it — otherwise the daemon can
  // see a "ghost completion" after it has already returned `"Aborted"`
  // to its caller.
  //
  // Invariant: entries are only added by `cancel()` when the requestId
  // is currently present in `inFlight`. Entries are pruned in two
  // places:
  //   1. At the top of `handle()`, where a fresh invocation clears any
  //      stale marker left behind by a prior invocation of the same
  //      requestId — this prevents an overlap-retry from inheriting a
  //      cancelled-by-a-previous-call flag that would silently drop its
  //      legitimate result.
  //   2. In `handle()`'s finally block, guarded on identity: the marker
  //      is removed only when the unwinding invocation still owns the
  //      `inFlight` entry for this requestId (or there is no entry at
  //      all, i.e. the invocation was cancelled and no retry has
  //      arrived). If a later invocation has overwritten the entry with
  //      its own controller, the finally block leaves the marker alone
  //      so that later invocation's cancel state is preserved.
  //
  // Together these bound the set size to at most the current in-flight
  // count, so the set cannot grow unbounded across long-running
  // service-worker lifetimes even under duplicate/late cancel churn
  // around relay reconnects.
  const cancelledRequestIds = new Set<string>();
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
  //
  // PR10: when a `forwardSessionInvalidated` hook is wired in, we ALSO
  // ship a `host_browser_session_invalidated` envelope over the relay
  // WebSocket so the runtime-side `BrowserSessionManager` can evict its
  // own session state in lockstep. The runtime's eviction is advisory —
  // tools create sessions per-invocation and the extension is the
  // source of truth for attach state — but without the forward the
  // runtime cannot know to force a reattach after a cross-origin
  // navigation closed the previous tab under it.
  const unsubscribeOnDetach = proxy.onDetach((debuggee, reason) => {
    const key = debuggeeKey(debuggee);
    if (key !== null) attachedTargets.delete(key);
    if (deps.forwardSessionInvalidated) {
      // Stringify tabId so the wire shape is always a string — the
      // runtime's resolver does not try to coerce between number and
      // string, and tabId is conceptually opaque once it crosses the
      // browser/runtime boundary.
      const targetId = debuggee.targetId
        ? debuggee.targetId
        : debuggee.tabId !== undefined
          ? String(debuggee.tabId)
          : undefined;
      try {
        deps.forwardSessionInvalidated({
          type: 'host_browser_session_invalidated',
          targetId,
          reason,
        });
      } catch (err) {
        console.error(
          '[host-browser-dispatcher] forwardSessionInvalidated threw',
          err,
        );
      }
    }
  });

  // Subscribe to CDP events and forward each one to the worker's
  // `forwardCdpEvent` hook when one is wired. This is the sibling of
  // the session-invalidated forwarding above — together they give the
  // runtime visibility into every chrome.debugger signal the extension
  // sees, even when no `host_browser_request` is currently in flight.
  // When no hook is provided the event subscription is still registered
  // (cdp-proxy only delivers to registered handlers anyway) so there
  // is no cost to the cold path.
  const unsubscribeOnEvent = proxy.onEvent((event: CdpEventFrame) => {
    if (!deps.forwardCdpEvent) return;
    try {
      deps.forwardCdpEvent({
        type: 'host_browser_event',
        method: event.method,
        params: event.params,
        cdpSessionId: event.sessionId,
      });
    } catch (err) {
      console.error(
        '[host-browser-dispatcher] forwardCdpEvent threw',
        err,
      );
    }
  });

  async function handle(envelope: HostBrowserRequestEnvelope): Promise<void> {
    const { requestId } = envelope;
    // Clear any stale cancel marker from a prior invocation of this
    // same requestId before we start processing. This matters for the
    // overlap-retry race: if a previous handle() for `requestId` was
    // cancelled while suspended at an await inside proxy.send(), its
    // finally block has not yet pruned the marker from
    // `cancelledRequestIds`. A fresh handle() for the same id (e.g. a
    // retry frame replayed across a relay reconnect) must not inherit
    // that stale marker — otherwise call B's legitimate result would
    // be suppressed at the postResult site by call A's leftover flag.
    //
    // This delete is safe to pair with the in-flight-only guard in
    // `cancel()`: together they still bound `cancelledRequestIds` by
    // the current in-flight count. cancel() only adds markers for
    // requests present in `inFlight`, so non-in-flight cancels remain
    // no-ops that cannot grow the set. The delete here strictly
    // reduces the set size (or is a no-op if no stale entry exists),
    // and the finally block below still prunes our own entry on unwind
    // to cover the non-overlapping case.
    cancelledRequestIds.delete(requestId);
    const abort = new AbortController();
    // Capture the controller created for THIS invocation so the
    // finally block can tell its own `inFlight` entry apart from one
    // written by a later overlapping invocation. When two calls for
    // the same requestId overlap (call A is suspended at proxy.send
    // while call B starts and overwrites `inFlight[requestId]` with
    // its own controller), the finally block must leave B's live
    // entry alone — otherwise a cancel() arriving after A unwinds
    // would find nothing in `inFlight` and silently no-op, leaving
    // B uncancellable.
    const ownController = abort;
    inFlight.set(requestId, ownController);
    try {
      const target = await deps.resolveTarget(envelope.cdpSessionId);

      // Handle synthetic Vellum.* methods that use chrome extension APIs
      // directly instead of routing through chrome.debugger.
      if (envelope.cdpMethod === 'Vellum.findTab') {
        const urlPattern = (envelope.cdpParams as { urlPattern?: string } | undefined)?.urlPattern;
        if (!urlPattern) {
          await deps.postResult({
            requestId,
            content: JSON.stringify({ error: { code: -32602, message: 'urlPattern is required' } }),
            isError: true,
          });
          return;
        }
        const tabs = await chrome.tabs.query({ url: urlPattern });
        const tab = tabs[0];
        if (!tab?.id) {
          await deps.postResult({
            requestId,
            content: JSON.stringify({ error: { code: -32000, message: `No tab matched URL pattern: ${urlPattern}` } }),
            isError: true,
          });
          return;
        }
        await deps.postResult({
          requestId,
          content: JSON.stringify({ result: { tabId: String(tab.id), url: tab.url, title: tab.title } }),
          isError: false,
        });
        return;
      }

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
      // Recovery hint: if the CDP send returned an error indicating the
      // target is no longer attached (tab closed mid-flight, navigated
      // across origins, another debugger took over, etc.), evict the
      // cache entry so the *next* request triggers a fresh attach. The
      // current request still fails — eviction does not retry, it only
      // unblocks subsequent traffic that would otherwise hit the same
      // stale-cache failure forever.
      //
      // Error matching is intentionally string-based: chrome.debugger
      // surfaces these failures via `chrome.runtime.lastError.message`
      // and the wording varies across Chrome versions. cdp-proxy maps
      // those into `{ code: -32000, message }` JSON-RPC error frames.
      if (frame.error) {
        const errMsg = (frame.error.message ?? '').toLowerCase();
        if (
          errMsg.includes('not attached') ||
          errMsg.includes('detached') ||
          errMsg.includes('target closed') ||
          errMsg.includes('no target with given id')
        ) {
          attachedTargets.delete(key);
        }
      }
      // Deterministic-cancel guarantee: if this specific invocation
      // was cancelled while we were awaiting the CDP round-trip, drop
      // the late result on the floor. The daemon has already resolved
      // its pending entry with `"Aborted"` (see host-browser-proxy.ts),
      // so delivering a frame here would be a ghost completion against
      // an entry that no longer exists.
      //
      // We check this invocation's own `abort.signal.aborted` first so
      // that an overlapping retry (call B starting while call A is
      // still suspended at a later await) does not have call A's
      // suppression leak into call B's result — each call has its own
      // AbortController captured in closure, so the per-call signal is
      // the authoritative "was this specific invocation cancelled?"
      // check. The `cancelledRequestIds.has(...)` fallback still matters
      // for the case where no retry has arrived yet: the set is the
      // mechanism that survives the cancel-to-finally window while the
      // handler unwinds.
      if (abort.signal.aborted || cancelledRequestIds.has(requestId)) return;
      await deps.postResult({
        requestId,
        content: JSON.stringify(frame.error ?? frame.result ?? {}),
        isError: frame.error != null,
      });
    } catch (err) {
      // Same cancellation check as the happy path: a request that was
      // cancelled mid-flight must not deliver its failure envelope to
      // the daemon either. The daemon proxy has already resolved its
      // pending entry, so any late postResult would be a ghost completion.
      if (abort.signal.aborted || cancelledRequestIds.has(requestId)) return;
      // Guard the failure-path postResult in its own try/catch: if the HTTP
      // POST itself fails (e.g. the relay socket is torn down while we're
      // in the error path) we must NOT let that secondary rejection escape
      // to the Chrome service worker as an unhandled promise rejection.
      try {
        await deps.postResult({
          requestId,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      } catch (postErr) {
        console.error(
          '[host-browser-dispatcher] Failed to post error result for',
          requestId,
          postErr,
        );
      }
    } finally {
      // Identity-guarded cleanup: only prune `inFlight` and
      // `cancelledRequestIds` when this invocation still owns the
      // `inFlight` entry for the requestId (or there is no entry at
      // all, which means this invocation was cancelled and no
      // overlapping retry has taken the slot).
      //
      // The overlap-retry scenario is the one this guard exists for:
      //
      //   1. handle(req) — call A creates controllerA, puts it in
      //      inFlight[req], suspends at proxy.send.
      //   2. cancel(req) — aborts controllerA, removes the entry
      //      from inFlight, marks req in cancelledRequestIds.
      //   3. handle(req) — call B clears the marker at the top,
      //      creates controllerB, puts it in inFlight[req], suspends
      //      at its own proxy.send.
      //   4. Call A's proxy.send resolves first (before B's) and A
      //      begins unwinding. The finally block runs while B's
      //      controllerB is the live `inFlight` entry. A unconditional
      //      delete would evict B's entry, and a subsequent cancel(req)
      //      would find nothing to cancel and silently no-op, leaving
      //      B uncancellable.
      //
      // So: leave `inFlight` alone unless this invocation still owns
      // it. And leave `cancelledRequestIds` alone when a later
      // invocation owns the entry — that later invocation's cancel
      // state belongs to it, not to the unwinding invocation. When
      // there is no `inFlight` entry at all (cancel() already removed
      // this invocation's entry and no retry has arrived), prune the
      // marker so it does not leak into a future handle() that races
      // the top-of-handle() cleanup.
      const currentEntry = inFlight.get(requestId);
      if (currentEntry === ownController) {
        inFlight.delete(requestId);
        cancelledRequestIds.delete(requestId);
      } else if (currentEntry === undefined) {
        cancelledRequestIds.delete(requestId);
      }
    }
  }

  function cancel(envelope: HostBrowserCancelEnvelope): void {
    const { requestId } = envelope;
    // Cancellations only apply to requests that are currently in flight.
    // This matches the daemon-side protocol (see host-browser-proxy.ts),
    // which only emits `host_browser_cancel` for a requestId while its
    // pending entry is still live — a cancel that races with a completed
    // handler, a duplicate cancel after a relay reconnect, or a cancel
    // for an id this dispatcher has never seen are all safe no-ops.
    //
    // Recording the cancelled marker only for in-flight requests keeps
    // `cancelledRequestIds` bounded by the current in-flight count and
    // prevents unbounded growth in long-lived service workers when
    // duplicate/late cancels accumulate across reconnects. Non-in-flight
    // cancels have nothing to suppress anyway, so there is no behavioural
    // difference from the caller's point of view.
    const ctl = inFlight.get(requestId);
    if (!ctl) return;
    // Record the cancellation in both the per-id set and the per-call
    // abort signal. The handle() suppression check reads from
    // `abort.signal.aborted` first (per-invocation, survives overlap
    // retries) and falls back to `cancelledRequestIds.has(...)`
    // (per-id, survives the cancel-to-finally window). Updating both
    // here keeps the two paths in sync: the per-id set is what a
    // suspended handler sees while its finally block hasn't yet run,
    // and the per-call signal is what an overlapping retry for the
    // same id uses to tell "am I the cancelled invocation?" apart
    // from "has some invocation of this id been cancelled?".
    //
    // Marking here also makes cancel() idempotent within the
    // in-flight window: a repeat cancel for the same id is a no-op
    // because the controller has already been removed from `inFlight`.
    cancelledRequestIds.add(requestId);
    try {
      ctl.abort();
    } catch {
      // AbortController.abort() is spec'd to never throw, but we
      // belt-and-brace here so a pathological polyfill can't derail
      // the cancel path and leave inFlight in an inconsistent state.
    }
    inFlight.delete(requestId);
  }

  function dispose(): void {
    // Mark every in-flight request as cancelled BEFORE aborting its
    // controller so that any handler currently suspended at an await
    // point unwinds through the same deterministic-cancel suppression
    // path as a regular cancel(). Without this, dispose() would leave
    // `cancelledRequestIds` empty and a handler that resumes post-
    // dispose would happily call postResult into a torn-down service
    // worker (or worse, into a freshly-constructed replacement
    // dispatcher during a hot reload).
    for (const requestId of inFlight.keys()) {
      cancelledRequestIds.add(requestId);
    }
    for (const abort of inFlight.values()) abort.abort();
    inFlight.clear();
    attachedTargets.clear();
    unsubscribeOnDetach();
    unsubscribeOnEvent();
    proxy.dispose();
  }

  return { handle, cancel, dispose };
}
