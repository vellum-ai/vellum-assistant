/**
 * Module-level event bus for out-of-band browser-session signals.
 *
 * The `host_browser_event` and `host_browser_session_invalidated`
 * envelopes (see `assistant/src/daemon/message-types/host-browser.ts`)
 * carry unsolicited CDP events and detach notifications from the
 * chrome extension to the daemon. Unlike `host_browser_result`, these
 * frames are not tied to a specific in-flight request and cannot be
 * routed through `pending-interactions`. Instead they publish into
 * this bus, where tool-side consumers subscribe to react to the signal.
 *
 * Two distinct surfaces:
 *
 *   1. **CDP event listeners** — free-form subscribers that observe
 *      every incoming `host_browser_event`. Primarily a seam for
 *      future work (event-driven session tracking, lifecycle
 *      instrumentation, tool-side reactive hooks) and for tests that
 *      need to assert that events were routed.
 *
 *   2. **Invalidated target registry** — a short-lived set of target
 *      ids that the extension has reported as detached. The
 *      `BrowserSessionManager` checks this set on its next `send()`
 *      and evicts any matching session before dispatch so the
 *      extension dispatcher can re-attach fresh. Entries are
 *      consumed on first lookup to keep the set from growing
 *      unbounded across long-running processes.
 *
 * Both surfaces are intentionally transport-agnostic — the WS and
 * HTTP paths both publish through the same module so the routing
 * semantics stay in lockstep.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("browser-session-events");

// ---------------------------------------------------------------------------
// CDP event listener surface
// ---------------------------------------------------------------------------

/**
 * A forwarded CDP event as consumed by runtime-side subscribers. The
 * wire shape comes from `HostBrowserEvent` in
 * `assistant/src/daemon/message-types/host-browser.ts` and is stripped
 * of its `type` discriminator here for ergonomic subscriber code.
 */
export interface ForwardedCdpEvent {
  /** CDP event method name, e.g. "Page.frameNavigated". */
  method: string;
  /** CDP event params forwarded verbatim. Opaque to the bus. */
  params?: unknown;
  /**
   * Optional CDP session id — present for flat child sessions routed
   * through `Target.attachToTarget` with `flatten: true`.
   */
  cdpSessionId?: string;
}

export type CdpEventListener = (event: ForwardedCdpEvent) => void;

const cdpEventListeners = new Set<CdpEventListener>();

/**
 * Subscribe to forwarded CDP events. Returns an unsubscribe function;
 * callers MUST invoke it at end-of-lifecycle to avoid leaking closures
 * into the module-level set. Listener errors are caught and logged so
 * a broken subscriber cannot take down the WS dispatch path.
 */
export function onCdpEvent(listener: CdpEventListener): () => void {
  cdpEventListeners.add(listener);
  return () => {
    cdpEventListeners.delete(listener);
  };
}

/**
 * Fan an incoming CDP event out to all registered listeners. Called
 * by the WS frame dispatcher in
 * `assistant/src/runtime/routes/host-browser-routes.ts` after a
 * `host_browser_event` envelope has been validated.
 */
export function publishCdpEvent(event: ForwardedCdpEvent): void {
  for (const listener of cdpEventListeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn(
        { err, method: event.method },
        "CDP event listener threw — suppressing to protect dispatcher",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Invalidated target registry
// ---------------------------------------------------------------------------

/**
 * Short-lived set of target ids the chrome extension has reported as
 * detached since the last `consumeInvalidatedTargetId` lookup. The
 * `BrowserSessionManager.invalidateByTargetId` path reads entries
 * out of this set on each `send()` and evicts any matching session
 * before dispatch.
 *
 * Entries are consumed on first read so the set never grows
 * unbounded. If a future consumer needs multiple reads of the same
 * invalidation, a separate long-lived registry should be introduced
 * — this set is scoped to the minimum viable behaviour for
 * "next command forces reattach".
 */
const invalidatedTargetIds = new Set<string>();

/**
 * Record that the chrome extension has reported a target as
 * detached. Idempotent — re-marking a target is a no-op. Logs at
 * debug because the signal is benign (just a lifecycle notification)
 * and noisy in high-churn workloads.
 */
export function markTargetInvalidated(targetId: string, reason?: string): void {
  invalidatedTargetIds.add(targetId);
  log.debug({ targetId, reason }, "browser-session target invalidated");
}

/**
 * Peek at whether a given target id is currently marked invalidated
 * without consuming the entry. Primarily used by tests — production
 * consumers should call {@link consumeInvalidatedTargetId} so the
 * set stays bounded.
 */
export function isTargetInvalidated(targetId: string): boolean {
  return invalidatedTargetIds.has(targetId);
}

/**
 * Atomically remove and return a target id from the invalidated set.
 * Returns `true` when the id was present (and has now been removed),
 * `false` otherwise. Designed to be called by
 * `BrowserSessionManager.send()` so the first dispatch after a
 * detach forces a reattach and subsequent dispatches proceed normally.
 */
export function consumeInvalidatedTargetId(targetId: string): boolean {
  return invalidatedTargetIds.delete(targetId);
}

/**
 * Test-only helper: clear the entire invalidated set. Not exported
 * from any public index — used by unit tests that need a clean slate
 * between cases. Not safe to call from production code because it
 * would race against concurrent invalidations.
 */
export function __resetBrowserSessionEventsForTests(): void {
  cdpEventListeners.clear();
  invalidatedTargetIds.clear();
}
