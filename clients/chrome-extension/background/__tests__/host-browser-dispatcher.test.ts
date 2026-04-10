/**
 * Tests for the host_browser envelope dispatcher.
 *
 * Drives the dispatcher against an injected mock `CdpProxy` so we can
 * exercise the happy path, CDP error envelopes, exception propagation,
 * cancellation, and dispose without touching any real chrome.debugger or
 * WebSocket surface.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  createHostBrowserDispatcher,
  type HostBrowserDispatcher,
  type HostBrowserEventEnvelope,
  type HostBrowserRequestEnvelope,
  type HostBrowserCancelEnvelope,
  type HostBrowserResultEnvelope,
  type HostBrowserSessionInvalidatedEnvelope,
} from '../host-browser-dispatcher.js';
import type {
  CdpProxy,
  CdpRequestFrame,
  CdpResultFrame,
  CdpEventFrame,
  CdpTarget,
  CdpDebuggee,
} from '../cdp-proxy.js';

// ── Test fixtures ───────────────────────────────────────────────────

interface MockCdpProxyOptions {
  /** Optional override for the next `send()` call's resolved frame. */
  sendResult?: CdpResultFrame;
  /**
   * Optional FIFO queue of canned `send()` results. Each call to `send()`
   * shifts the head of this queue and returns it. Falls back to
   * `sendResult` (or the default `{ id, result: { ok: true } }`) once the
   * queue is empty. Useful for tests that need to sequence multiple
   * different responses across repeat requests.
   */
  sendResults?: CdpResultFrame[];
  /** If set, the next `send()` call will throw this error. */
  sendThrows?: Error;
  /** If set, `attach()` will reject with this error. */
  attachThrows?: Error;
}

interface MockCdpProxy extends CdpProxy {
  attachCalls: Array<{ target: CdpTarget; requiredVersion: string }>;
  sendCalls: Array<{ target: CdpTarget; frame: CdpRequestFrame }>;
  detachCalls: CdpTarget[];
  disposeCalls: number;
  /**
   * Currently-registered onDetach handlers. Tests fire detach events by
   * calling these directly via the `fireDetach` helper below.
   */
  detachHandlers: Set<(target: CdpDebuggee, reason: string) => void>;
  /**
   * Currently-registered onEvent handlers. Tests fire CDP events by
   * calling these directly via the `fireEvent` helper below.
   */
  eventHandlers: Set<(event: CdpEventFrame) => void>;
  /** Synthetically dispatch a detach event to all registered handlers. */
  fireDetach(target: CdpDebuggee, reason?: string): void;
  /** Synthetically dispatch a CDP event to all registered handlers. */
  fireEvent(event: CdpEventFrame): void;
}

function createMockCdpProxy(options: MockCdpProxyOptions = {}): MockCdpProxy {
  const eventHandlers = new Set<(event: CdpEventFrame) => void>();
  const detachHandlers = new Set<(target: CdpDebuggee, reason: string) => void>();
  const attachCalls: Array<{ target: CdpTarget; requiredVersion: string }> = [];
  const sendCalls: Array<{ target: CdpTarget; frame: CdpRequestFrame }> = [];
  const detachCalls: CdpTarget[] = [];
  let disposeCalls = 0;
  // Mutable copy so each `send()` invocation can shift one off the front.
  const queuedSendResults: CdpResultFrame[] = options.sendResults
    ? [...options.sendResults]
    : [];

  const proxy: MockCdpProxy = {
    attachCalls,
    sendCalls,
    detachCalls,
    detachHandlers,
    eventHandlers,
    get disposeCalls() {
      return disposeCalls;
    },
    async attach(target, requiredVersion) {
      attachCalls.push({ target, requiredVersion });
      if (options.attachThrows) throw options.attachThrows;
    },
    async detach(target) {
      detachCalls.push(target);
    },
    async send(target, frame) {
      sendCalls.push({ target, frame });
      if (options.sendThrows) throw options.sendThrows;
      const queued = queuedSendResults.shift();
      if (queued) {
        // Re-tag the queued frame's id with the actual request id so the
        // dispatcher's monotonic counter doesn't drift in the test view.
        return { ...queued, id: frame.id };
      }
      return options.sendResult ?? { id: frame.id, result: { ok: true } };
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onDetach(handler) {
      detachHandlers.add(handler);
      return () => detachHandlers.delete(handler);
    },
    fireDetach(target, reason = 'target_closed') {
      for (const h of detachHandlers) h(target, reason);
    },
    fireEvent(event) {
      for (const h of eventHandlers) h(event);
    },
    dispose() {
      disposeCalls += 1;
      eventHandlers.clear();
      detachHandlers.clear();
    },
  };
  return proxy;
}

interface DispatcherTestHarness {
  dispatcher: HostBrowserDispatcher;
  proxy: MockCdpProxy;
  results: HostBrowserResultEnvelope[];
  forwardedEvents: HostBrowserEventEnvelope[];
  forwardedInvalidations: HostBrowserSessionInvalidatedEnvelope[];
  resolveTargetCalls: Array<string | undefined>;
  /** Override this to throw from resolveTarget. */
  resolveTargetImpl: (
    cdpSessionId: string | undefined,
  ) => Promise<{ tabId?: number; targetId?: string }>;
  /** Override this to throw from postResult. */
  postResultImpl: (result: HostBrowserResultEnvelope) => Promise<void>;
  /** Optional override that lets a test simulate forwardCdpEvent throwing. */
  forwardCdpEventImpl?: (event: HostBrowserEventEnvelope) => void;
  /** Optional override that lets a test simulate forwardSessionInvalidated throwing. */
  forwardSessionInvalidatedImpl?: (
    event: HostBrowserSessionInvalidatedEnvelope,
  ) => void;
}

function createHarness(options: MockCdpProxyOptions = {}): DispatcherTestHarness {
  const proxy = createMockCdpProxy(options);
  const results: HostBrowserResultEnvelope[] = [];
  const forwardedEvents: HostBrowserEventEnvelope[] = [];
  const forwardedInvalidations: HostBrowserSessionInvalidatedEnvelope[] = [];
  const resolveTargetCalls: Array<string | undefined> = [];

  const harness: DispatcherTestHarness = {
    dispatcher: null as unknown as HostBrowserDispatcher,
    proxy,
    results,
    forwardedEvents,
    forwardedInvalidations,
    resolveTargetCalls,
    resolveTargetImpl: async (cdpSessionId) => {
      if (cdpSessionId) return { targetId: cdpSessionId };
      return { tabId: 42 };
    },
    postResultImpl: async (result) => {
      results.push(result);
    },
  };

  harness.dispatcher = createHostBrowserDispatcher({
    cdpProxy: proxy,
    resolveTarget: async (cdpSessionId) => {
      resolveTargetCalls.push(cdpSessionId);
      return harness.resolveTargetImpl(cdpSessionId);
    },
    postResult: async (result) => {
      await harness.postResultImpl(result);
    },
    forwardCdpEvent: (event) => {
      if (harness.forwardCdpEventImpl) {
        harness.forwardCdpEventImpl(event);
        return;
      }
      forwardedEvents.push(event);
    },
    forwardSessionInvalidated: (event) => {
      if (harness.forwardSessionInvalidatedImpl) {
        harness.forwardSessionInvalidatedImpl(event);
        return;
      }
      forwardedInvalidations.push(event);
    },
  });

  return harness;
}

const sampleRequest: HostBrowserRequestEnvelope = {
  type: 'host_browser_request',
  requestId: 'req-1',
  conversationId: 'conv-1',
  cdpMethod: 'Browser.getVersion',
  cdpParams: { foo: 'bar' },
};

/**
 * Poll-based wait helper used by the cancel-race tests to synchronise
 * on dispatcher internals (e.g. "wait until proxy.send has been called")
 * without reaching into private state. Falls back to a wall-clock
 * deadline so a broken dispatcher can't hang the test suite forever.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor: predicate did not become true within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createHostBrowserDispatcher', () => {
  let harness: DispatcherTestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  describe('handle — happy path', () => {
    test('attaches, sends CDP command, and posts a success result', async () => {
      harness = createHarness({
        sendResult: {
          id: 1,
          result: { product: 'Chrome/120', protocolVersion: '1.3' },
        },
      });

      await harness.dispatcher.handle(sampleRequest);

      // resolveTarget was called once with no session id → active tab.
      expect(harness.resolveTargetCalls).toEqual([undefined]);

      // Proxy attach + send happened with the resolved target.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.attachCalls[0].target).toEqual({ tabId: 42 });
      expect(harness.proxy.attachCalls[0].requiredVersion).toBe('1.3');

      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.proxy.sendCalls[0].target).toEqual({ tabId: 42 });
      expect(harness.proxy.sendCalls[0].frame.method).toBe('Browser.getVersion');
      expect(harness.proxy.sendCalls[0].frame.params).toEqual({ foo: 'bar' });

      // A single success result was posted with the stringified CDP result.
      expect(harness.results.length).toBe(1);
      expect(harness.results[0].requestId).toBe('req-1');
      expect(harness.results[0].isError).toBe(false);
      expect(harness.results[0].content).toBe(
        JSON.stringify({ product: 'Chrome/120', protocolVersion: '1.3' }),
      );
    });

    test('routes via targetId when cdpSessionId is provided but does not forward it as frame.sessionId', async () => {
      harness = createHarness({
        sendResult: { id: 1, result: {} },
      });

      const withSession: HostBrowserRequestEnvelope = {
        ...sampleRequest,
        cdpSessionId: 'target-xyz',
      };
      await harness.dispatcher.handle(withSession);

      expect(harness.resolveTargetCalls).toEqual(['target-xyz']);
      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: 'target-xyz' });
      // cdpSessionId must NOT be forwarded as frame.sessionId — it is used
      // only for target resolution. Forwarding it would cause
      // chrome.debugger.sendCommand to look up a non-existent flat session.
      expect(harness.proxy.sendCalls[0].frame.sessionId).toBeUndefined();
    });
  });

  describe('handle — cdpSessionId target resolution vs flat-session separation', () => {
    test('cdpSessionId is passed to resolveTarget but NOT forwarded as frame.sessionId', async () => {
      harness = createHarness({
        sendResult: { id: 1, result: {} },
      });
      // Override resolveTarget to record calls and return a targetId.
      harness.resolveTargetImpl = async (cdpSessionId) => {
        return { targetId: 'test-target-id' };
      };

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: 'test-target-id',
      });

      // resolveTarget was called with the cdpSessionId.
      expect(harness.resolveTargetCalls).toEqual(['test-target-id']);

      // The proxy.send() call's frame must NOT carry sessionId — cdpSessionId
      // is used only for target resolution, not as a CDP flat-session qualifier.
      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.proxy.sendCalls[0].frame.sessionId).toBeUndefined();
    });

    test('when cdpSessionId is omitted, resolveTarget receives undefined and frame.sessionId is also undefined', async () => {
      harness = createHarness({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle(sampleRequest);

      // resolveTarget was called with undefined (active-tab fallback path).
      expect(harness.resolveTargetCalls).toEqual([undefined]);

      // frame.sessionId is also undefined — the active-tab path never sets
      // a flat-session qualifier.
      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.proxy.sendCalls[0].frame.sessionId).toBeUndefined();
    });
  });

  describe('handle — attach deduplication', () => {
    test('skips proxy.attach on repeat requests against the same target', async () => {
      harness = createHarness({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle(sampleRequest);
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-2' });
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-3' });

      // Only the first request should have attached; the subsequent two
      // reuse the cached attachment.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.sendCalls.length).toBe(3);
      expect(harness.results.length).toBe(3);
      expect(harness.results.every((r) => r.isError === false)).toBe(true);
    });

    test('tolerates "Already attached" errors from proxy.attach and caches success', async () => {
      harness = createHarness({
        attachThrows: new Error(
          'Another debugger is already attached to the tab with id: 42.',
        ),
      });

      await harness.dispatcher.handle(sampleRequest);

      // Send proceeded despite the attach error — the dispatcher treated
      // "Already attached" as a non-fatal success.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(false);
    });

    test('routes different targetIds to distinct attach entries', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: 'target-A',
      });
      await harness.dispatcher.handle({
        ...sampleRequest,
        requestId: 'req-2',
        cdpSessionId: 'target-B',
      });
      // Second call to target-A should reuse the cached attachment.
      await harness.dispatcher.handle({
        ...sampleRequest,
        requestId: 'req-3',
        cdpSessionId: 'target-A',
      });

      expect(harness.proxy.attachCalls.length).toBe(2);
      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: 'target-A' });
      expect(harness.proxy.attachCalls[1].target).toEqual({ targetId: 'target-B' });
    });
  });

  describe('handle — onDetach cache invalidation', () => {
    test('re-attaches after Chrome fires onDetach for a tabId target', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      // First call attaches.
      await harness.dispatcher.handle(sampleRequest);
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.attachCalls[0].target).toEqual({ tabId: 42 });

      // Second call (no detach yet) reuses the cached attachment — proves
      // the entry is in the cache.
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-2' });
      expect(harness.proxy.attachCalls.length).toBe(1);

      // Chrome fires onDetach for the tab — e.g. user closed it, navigated
      // away, clicked Cancel on the chrome.debugger infobar, or another
      // debugger took over via Target.attachToTarget.
      harness.proxy.fireDetach({ tabId: 42 }, 'target_closed');

      // Next call must re-attach because the cache entry was invalidated.
      // Otherwise we'd silently send a CDP command against a torn-down
      // session and hit a permanent failure.
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-3' });
      expect(harness.proxy.attachCalls.length).toBe(2);
      expect(harness.proxy.attachCalls[1].target).toEqual({ tabId: 42 });
    });

    test('re-attaches after Chrome fires onDetach for a targetId target', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      const withSession: HostBrowserRequestEnvelope = {
        ...sampleRequest,
        cdpSessionId: 'target-xyz',
      };

      await harness.dispatcher.handle(withSession);
      expect(harness.proxy.attachCalls.length).toBe(1);

      // Cache hit — second call must NOT re-attach.
      await harness.dispatcher.handle({ ...withSession, requestId: 'req-2' });
      expect(harness.proxy.attachCalls.length).toBe(1);

      harness.proxy.fireDetach({ targetId: 'target-xyz' }, 'target_closed');

      await harness.dispatcher.handle({ ...withSession, requestId: 'req-3' });
      expect(harness.proxy.attachCalls.length).toBe(2);
      expect(harness.proxy.attachCalls[1].target).toEqual({
        targetId: 'target-xyz',
      });
    });

    test('detach for an unrelated target does not invalidate other entries', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      // Attach two distinct targets.
      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: 'target-A',
      });
      await harness.dispatcher.handle({
        ...sampleRequest,
        requestId: 'req-2',
        cdpSessionId: 'target-B',
      });
      expect(harness.proxy.attachCalls.length).toBe(2);

      // Detach only target-A. target-B's cached attachment must survive.
      harness.proxy.fireDetach({ targetId: 'target-A' }, 'target_closed');

      await harness.dispatcher.handle({
        ...sampleRequest,
        requestId: 'req-3',
        cdpSessionId: 'target-B',
      });
      // No new attach for target-B.
      expect(harness.proxy.attachCalls.length).toBe(2);

      // But target-A re-attaches.
      await harness.dispatcher.handle({
        ...sampleRequest,
        requestId: 'req-4',
        cdpSessionId: 'target-A',
      });
      expect(harness.proxy.attachCalls.length).toBe(3);
      expect(harness.proxy.attachCalls[2].target).toEqual({ targetId: 'target-A' });
    });

    test('detach for a debuggee shape with neither tabId nor targetId is a no-op', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      await harness.dispatcher.handle(sampleRequest);
      expect(harness.proxy.attachCalls.length).toBe(1);

      // Defensive: a malformed detach payload (e.g. extensionId-only) must
      // not throw and must not invalidate anything we care about.
      harness.proxy.fireDetach({}, 'target_closed');

      // Cache entry for tabId 42 is still there → no new attach.
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-2' });
      expect(harness.proxy.attachCalls.length).toBe(1);
    });
  });

  describe('handle — send-error cache eviction', () => {
    test('evicts the cache when send returns a detach-style error so the next request re-attaches', async () => {
      // Two requests against the same target. The first send returns a
      // "Target closed" error frame; the dispatcher must surface that
      // error to the caller AND evict the cached attach so the second
      // request re-runs proxy.attach instead of silently re-using a
      // dead session.
      harness = createHarness({
        sendResults: [
          { id: 0, error: { code: -32000, message: 'Target closed' } },
          { id: 0, result: { ok: true } },
        ],
      });

      await harness.dispatcher.handle(sampleRequest);
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-2' });

      // Two attaches: one before the first request, one before the second
      // after the cache was evicted by the detach-style error response.
      expect(harness.proxy.attachCalls.length).toBe(2);
      expect(harness.proxy.attachCalls[0].target).toEqual({ tabId: 42 });
      expect(harness.proxy.attachCalls[1].target).toEqual({ tabId: 42 });

      // Both sends fired against the same resolved target.
      expect(harness.proxy.sendCalls.length).toBe(2);

      // The first request still surfaces the error frame to the caller —
      // eviction is a recovery hint, not a retry. The second succeeds.
      expect(harness.results.length).toBe(2);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe(
        JSON.stringify({ code: -32000, message: 'Target closed' }),
      );
      expect(harness.results[1].isError).toBe(false);
    });

    test('does not evict the cache when send returns a non-detach error', async () => {
      // A "Method not implemented" failure is unrelated to the attach
      // lifecycle — re-attaching wouldn't help and would be wasteful.
      // The dispatcher must keep the cache entry intact and the next
      // request must reuse the cached attach.
      harness = createHarness({
        sendResults: [
          {
            id: 0,
            error: { code: -32601, message: 'Method not implemented' },
          },
          { id: 0, result: { ok: true } },
        ],
      });

      await harness.dispatcher.handle(sampleRequest);
      await harness.dispatcher.handle({ ...sampleRequest, requestId: 'req-2' });

      // Only one attach: the cache survived the non-detach error.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.sendCalls.length).toBe(2);

      expect(harness.results.length).toBe(2);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe(
        JSON.stringify({ code: -32601, message: 'Method not implemented' }),
      );
      expect(harness.results[1].isError).toBe(false);
    });
  });

  describe('handle — CDP error envelope', () => {
    test('posts isError: true with the stringified error object', async () => {
      harness = createHarness({
        sendResult: {
          id: 1,
          error: { code: -32000, message: 'cannot find context with specified id' },
        },
      });

      await harness.dispatcher.handle(sampleRequest);

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe(
        JSON.stringify({ code: -32000, message: 'cannot find context with specified id' }),
      );
    });
  });

  describe('handle — exception path', () => {
    test('posts isError: true when resolveTarget throws', async () => {
      harness.resolveTargetImpl = async () => {
        throw new Error('no active tab');
      };

      await harness.dispatcher.handle(sampleRequest);

      expect(harness.proxy.attachCalls.length).toBe(0);
      expect(harness.proxy.sendCalls.length).toBe(0);
      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe('no active tab');
      expect(harness.results[0].requestId).toBe('req-1');
    });

    test('posts isError: true when proxy.attach throws a non-"Already attached" error', async () => {
      harness = createHarness({
        attachThrows: new Error('Cannot access a chrome:// URL'),
      });

      await harness.dispatcher.handle(sampleRequest);

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe('Cannot access a chrome:// URL');
    });

    test('posts isError: true when proxy.send throws', async () => {
      harness = createHarness({
        sendThrows: new Error('debugger detached mid-command'),
      });

      await harness.dispatcher.handle(sampleRequest);

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe('debugger detached mid-command');
    });

    test('stringifies non-Error thrown values', async () => {
      harness.resolveTargetImpl = async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'raw string rejection';
      };

      await harness.dispatcher.handle(sampleRequest);

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(true);
      expect(harness.results[0].content).toBe('raw string rejection');
    });

    test('swallows postResult failures inside the catch handler (no unhandled rejection)', async () => {
      // Force the handler into the error path AND make postResult itself
      // throw. If the dispatcher does not guard the catch-block postResult,
      // this rejection will escape and trip `handle()`.
      harness = createHarness({
        sendThrows: new Error('boom from send'),
      });
      let postResultCalls = 0;
      harness.postResultImpl = async () => {
        postResultCalls += 1;
        throw new Error('relay socket torn down');
      };

      // Must not reject.
      let rejected: unknown = null;
      try {
        await harness.dispatcher.handle(sampleRequest);
      } catch (err) {
        rejected = err;
      }
      expect(rejected).toBeNull();

      // We still attempted to post the error envelope once.
      expect(postResultCalls).toBe(1);
    });
  });

  describe('cancel', () => {
    test('suppresses late postResult delivery for a cancelled request (deterministic-cancel guarantee)', async () => {
      // Regression: the dispatcher must NOT deliver a result envelope
      // after the daemon has sent a host_browser_cancel. The daemon
      // has already resolved the caller with "Aborted" — a late post
      // would be a ghost completion and trip the daemon's "No pending
      // host browser request" warning. Gate resolveTarget so we can
      // issue the cancel mid-flight, then release the gate and verify
      // that the handler runs to completion without posting anything.
      let releaseResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });

      harness.resolveTargetImpl = async () => {
        await gate;
        return { tabId: 7 };
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);

      // Mid-flight cancel — arrives BEFORE resolveTarget settles, so the
      // handler is still awaiting its first internal await.
      const cancelEnvelope: HostBrowserCancelEnvelope = {
        type: 'host_browser_cancel',
        requestId: 'req-1',
      };
      harness.dispatcher.cancel(cancelEnvelope);

      // Release the gate so the handler can finish its internal work
      // (proxy.send will still be invoked because resolveTarget runs
      // before the cancellation check at the postResult site).
      releaseResolve();
      await handlePromise;

      // Critical assertion: no result envelope was posted. The cancelled
      // request is dropped on the floor at the postResult site.
      expect(harness.results.length).toBe(0);
    });

    test('suppresses late postResult when cancel races with proxy.send resolution', async () => {
      // Simulates the window where proxy.send has already been called
      // but hasn't resolved yet. The cancel lands between send() and
      // the postResult call. This is the tightest race the dispatcher
      // needs to handle deterministically.
      let releaseSend: (frame: {
        id: number;
        result: unknown;
      }) => void = () => {};
      const sendGate = new Promise<{ id: number; result: unknown }>(
        (resolve) => {
          releaseSend = resolve;
        },
      );
      const proxy = harness.proxy;
      // Override send on the existing mock proxy so we can externally
      // control when the CDP round-trip resolves.
      proxy.send = async (target, frame) => {
        proxy.sendCalls.push({ target, frame });
        const result = await sendGate;
        return { ...result, id: frame.id };
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);

      // Wait for the handler to reach proxy.send before cancelling.
      await waitFor(() => proxy.sendCalls.length === 1);

      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      // Resolve the CDP round-trip — the dispatcher must now notice
      // the request was cancelled and drop the result instead of
      // calling postResult.
      releaseSend({ id: 0, result: { ok: true } });
      await handlePromise;

      expect(harness.results.length).toBe(0);
    });

    test('suppresses late postResult when cancel races with a send() that returned an error frame', async () => {
      // Mirror the previous race test but with the CDP round-trip
      // returning a JSON-RPC error envelope. The dispatcher must still
      // drop the error envelope on the floor — both the success and
      // the error branches of handle() route through the same
      // postResult call site and must honour the cancellation check.
      let releaseSend: (frame: {
        id: number;
        error: { code: number; message: string };
      }) => void = () => {};
      const sendGate = new Promise<{
        id: number;
        error: { code: number; message: string };
      }>((resolve) => {
        releaseSend = resolve;
      });
      const proxy = harness.proxy;
      proxy.send = async (target, frame) => {
        proxy.sendCalls.push({ target, frame });
        const result = await sendGate;
        return { ...result, id: frame.id };
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);
      await waitFor(() => proxy.sendCalls.length === 1);

      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      releaseSend({
        id: 0,
        error: { code: -32000, message: 'cannot find context with specified id' },
      });
      await handlePromise;

      expect(harness.results.length).toBe(0);
    });

    test('suppresses the error envelope when cancel races with a thrown send', async () => {
      // Error path: the CDP send throws *after* cancel has arrived.
      // The catch block in handle() must honour the cancelled set and
      // skip its postResult call.
      let rejectSend: (err: Error) => void = () => {};
      const sendGate = new Promise<never>((_, reject) => {
        rejectSend = reject;
      });
      const proxy = harness.proxy;
      proxy.send = async (target, frame) => {
        proxy.sendCalls.push({ target, frame });
        return sendGate;
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);
      await waitFor(() => proxy.sendCalls.length === 1);

      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      rejectSend(new Error('debugger detached mid-command'));
      await handlePromise;

      expect(harness.results.length).toBe(0);
    });

    test('cancel is idempotent: repeat cancels for the same request id are safe', async () => {
      // Issue the same cancel twice, then a third time after the
      // handler has already unwound. None of them must throw, and no
      // result envelope must be posted for the original request.
      let releaseResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });

      harness.resolveTargetImpl = async () => {
        await gate;
        return { tabId: 7 };
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);

      const cancelEnvelope: HostBrowserCancelEnvelope = {
        type: 'host_browser_cancel',
        requestId: 'req-1',
      };
      expect(() => harness.dispatcher.cancel(cancelEnvelope)).not.toThrow();
      expect(() => harness.dispatcher.cancel(cancelEnvelope)).not.toThrow();

      releaseResolve();
      await handlePromise;

      // Post-handler cancel must also be a no-op: cancel() only records
      // markers for requests currently in `inFlight`, and the previous
      // handler has already unwound and removed its entry, so this
      // third cancel short-circuits without touching cancelledRequestIds.
      expect(() => harness.dispatcher.cancel(cancelEnvelope)).not.toThrow();

      expect(harness.results.length).toBe(0);
    });

    test('cancel for a finished request does not affect a subsequent request with the same id', async () => {
      // A cancelled request marks its id in the internal cancelled set,
      // and handle()'s finally block prunes the entry. A subsequent
      // handle() call for the *same* requestId (e.g. a retry across a
      // relay reconnect) must NOT inherit the cancelled flag from the
      // previous invocation — otherwise the retry would silently drop
      // its result.
      harness = createHarness({
        sendResult: { id: 1, result: { ok: true } },
      });

      // First invocation — cancel it mid-flight.
      let releaseResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      harness.resolveTargetImpl = async () => {
        await gate;
        return { tabId: 42 };
      };

      const firstPromise = harness.dispatcher.handle(sampleRequest);
      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });
      releaseResolve();
      await firstPromise;
      expect(harness.results.length).toBe(0);

      // Second invocation with the same requestId — must run to
      // completion and post its result.
      harness.resolveTargetImpl = async () => ({ tabId: 42 });
      await harness.dispatcher.handle(sampleRequest);

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].requestId).toBe('req-1');
      expect(harness.results[0].isError).toBe(false);
    });

    test('overlap-retry: cancelled call A cannot suppress call B retrying the same requestId', async () => {
      // Regression: there is a race where a cancelled-but-still-
      // suspended call A can leak its cancel marker onto an overlapping
      // retry (call B) for the same requestId. The ordering is:
      //
      //   1. handle("req-1") — call A, suspends inside proxy.send at gate_A
      //   2. cancel("req-1") — marks req-1 cancelled, aborts A's
      //      controller, removes A from inFlight (A is still suspended)
      //   3. handle("req-1") — call B, retry arrives before A unwinds
      //   4. B's proxy.send resolves first (gate_B released) — B must
      //      deliver its legitimate result
      //   5. A's proxy.send resolves later (gate_A released) — A must
      //      still be suppressed (it was cancelled)
      //
      // Before the fix, A's cancel marker lived in `cancelledRequestIds`
      // past the start of call B, so B's happy path would see the stale
      // marker and silently drop the result. The fix:
      //   (a) clears any stale marker at the top of handle(), so B's
      //       post-send check sees a clean state
      //   (b) uses the per-invocation AbortController signal to
      //       authoritatively suppress call A without relying on a
      //       shared-by-id flag that B would stomp on
      harness = createHarness();

      // Per-invocation send gates, one for call A and one for call B.
      // The dispatcher's proxy.send override shifts the next gate off
      // the FIFO queue each time it fires, so call A awaits gateA
      // (index 0) and call B awaits gateB (index 1).
      type SendFrame = { id: number; result: unknown };
      let resolveGateA: (frame: SendFrame) => void = () => {};
      let resolveGateB: (frame: SendFrame) => void = () => {};
      const gateA = new Promise<SendFrame>((resolve) => {
        resolveGateA = resolve;
      });
      const gateB = new Promise<SendFrame>((resolve) => {
        resolveGateB = resolve;
      });
      const gates: Array<Promise<SendFrame>> = [gateA, gateB];

      const proxy = harness.proxy;
      proxy.send = async (target, frame) => {
        proxy.sendCalls.push({ target, frame });
        const gate = gates.shift();
        if (!gate) {
          throw new Error('unexpected additional proxy.send call');
        }
        const result = await gate;
        return { ...result, id: frame.id };
      };

      // Start call A and wait for it to suspend inside proxy.send.
      const callA = harness.dispatcher.handle(sampleRequest);
      await waitFor(() => proxy.sendCalls.length === 1);

      // Cancel call A. At this point A is still suspended at gateA.
      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      // Start call B with the SAME requestId. B is a retry that
      // arrives before A has unwound through its finally block — the
      // exact overlap the race test exercises.
      const callB = harness.dispatcher.handle(sampleRequest);
      await waitFor(() => proxy.sendCalls.length === 2);

      // Resolve call B's proxy.send FIRST with a legitimate success
      // frame. B must deliver this result via postResult.
      resolveGateB({ id: 0, result: { fromRetry: true } });
      await callB;

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].requestId).toBe('req-1');
      expect(harness.results[0].isError).toBe(false);
      expect(harness.results[0].content).toBe(
        JSON.stringify({ fromRetry: true }),
      );

      // Now release call A's gate. A's happy path must notice its own
      // AbortController is aborted and drop the result on the floor —
      // i.e. we should still only have B's single result in the log.
      resolveGateA({ id: 0, result: { fromCancelledA: true } });
      await callA;

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].content).toBe(
        JSON.stringify({ fromRetry: true }),
      );
    });

    test('overlap-retry reverse ordering: cancelled call A unwinding does not evict call B from inFlight', async () => {
      // Companion to the overlap-retry test above, exercising the
      // reverse ordering: call A's proxy.send resolves BEFORE call
      // B's, i.e. the cancelled invocation unwinds while the live
      // retry is still suspended. The dispatcher's finally block
      // guards `inFlight.delete` on identity: A must not evict B's
      // controller from inFlight, otherwise a subsequent `cancel("req-1")`
      // would find nothing and silently no-op, leaving B uncancellable.
      //
      // Ordering:
      //   1. handle("req-1") — call A, suspends inside proxy.send at gateA
      //   2. cancel("req-1") — marks req-1 cancelled, aborts A's
      //      controller, removes A from inFlight (A still suspended)
      //   3. handle("req-1") — call B, retry starts, inserts controllerB
      //      into inFlight, suspends inside proxy.send at gateB
      //   4. Release gateA FIRST — call A resumes, sees its own
      //      AbortController is aborted, drops the result, and runs
      //      its finally block while B is still suspended. The guard
      //      must leave inFlight[req-1] pointing at controllerB.
      //   5. cancel("req-1") — must find B's controller in inFlight
      //      and abort it. B then unwinds and drops its (cancelled)
      //      result on the floor.
      harness = createHarness();

      type SendFrame = { id: number; result: unknown };
      let resolveGateA: (frame: SendFrame) => void = () => {};
      let resolveGateB: (frame: SendFrame) => void = () => {};
      const gateA = new Promise<SendFrame>((resolve) => {
        resolveGateA = resolve;
      });
      const gateB = new Promise<SendFrame>((resolve) => {
        resolveGateB = resolve;
      });
      const gates: Array<Promise<SendFrame>> = [gateA, gateB];

      const proxy = harness.proxy;
      proxy.send = async (target, frame) => {
        proxy.sendCalls.push({ target, frame });
        const gate = gates.shift();
        if (!gate) {
          throw new Error('unexpected additional proxy.send call');
        }
        const result = await gate;
        return { ...result, id: frame.id };
      };

      // Start call A and wait for it to suspend inside proxy.send.
      const callA = harness.dispatcher.handle(sampleRequest);
      await waitFor(() => proxy.sendCalls.length === 1);

      // Cancel call A while it is still suspended at gateA.
      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      // Start call B with the same requestId — the retry inserts its
      // own controller into inFlight[req-1] and suspends at gateB.
      const callB = harness.dispatcher.handle(sampleRequest);
      await waitFor(() => proxy.sendCalls.length === 2);

      // Release call A's gate FIRST so A unwinds while B is still
      // suspended. A's finally runs against an inFlight entry that
      // now belongs to B; the identity guard must leave it in place.
      resolveGateA({ id: 0, result: { fromCancelledA: true } });
      await callA;

      // A dropped its result on the floor (cancelled-invocation
      // suppression), so no envelope has been posted yet.
      expect(harness.results.length).toBe(0);

      // Issuing a cancel for B must still find B's controller live
      // in inFlight — if A's finally had evicted B, this cancel
      // would be a silent no-op and B would deliver its result on
      // gateB release. We want the opposite: B must be cancelled.
      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      // Release B's gate. B's happy path must notice its own
      // AbortController is aborted and drop the result instead of
      // posting it — proving the cancel above reached B's live
      // controller rather than no-oping against an evicted entry.
      resolveGateB({ id: 0, result: { fromRetry: true } });
      await callB;

      expect(harness.results.length).toBe(0);
    });

    test('aborts the in-flight controller and removes it from the inFlight map', async () => {
      // Sanity check on the cancel path's bookkeeping: after cancel()
      // returns, the in-flight map no longer holds the cancelled entry,
      // and disposing the dispatcher afterwards must not throw even
      // though the cancelled handler is still technically awaiting its
      // internal gate.
      let releaseResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      harness.resolveTargetImpl = async () => {
        await gate;
        return { tabId: 7 };
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);
      harness.dispatcher.cancel({
        type: 'host_browser_cancel',
        requestId: 'req-1',
      });

      // Dispose while the cancelled handler is still in flight — this
      // is the same path the service worker takes on shutdown.
      harness.dispatcher.dispose();

      // Release the gate so the promise can settle cleanly.
      releaseResolve();
      await handlePromise;

      expect(harness.results.length).toBe(0);
    });

    test('is a no-op for unknown request ids', () => {
      expect(() =>
        harness.dispatcher.cancel({
          type: 'host_browser_cancel',
          requestId: 'unknown',
        }),
      ).not.toThrow();
    });
  });

  describe('dispose', () => {
    test('disposes the CDP proxy and clears any in-flight state', async () => {
      // Start a long-running request so there's something in the in-flight map.
      let releaseResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      harness.resolveTargetImpl = async () => {
        await gate;
        return { tabId: 1 };
      };

      const pending = harness.dispatcher.handle(sampleRequest);

      // Dispose the dispatcher — this should dispose the CDP proxy and abort
      // the in-flight controller.
      harness.dispatcher.dispose();
      expect(harness.proxy.disposeCalls).toBe(1);

      // Release the gate so the awaited Promise can settle.
      releaseResolve();
      await pending;
    });

    test('is safe to call multiple times (proxy is disposed each time)', () => {
      harness.dispatcher.dispose();
      harness.dispatcher.dispose();
      expect(harness.proxy.disposeCalls).toBe(2);
    });

    test('clears attached-target cache so the next attach happens fresh', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      // Attach once.
      await harness.dispatcher.handle(sampleRequest);
      expect(harness.proxy.attachCalls.length).toBe(1);

      // Dispose clears the attached set (and the proxy).
      harness.dispatcher.dispose();

      // A new dispatcher built on a *fresh* proxy should attach again on
      // first use — we can't reuse the disposed dispatcher, so this test
      // verifies the semantic by starting over.
      harness = createHarness({ sendResult: { id: 1, result: {} } });
      await harness.dispatcher.handle(sampleRequest);
      expect(harness.proxy.attachCalls.length).toBe(1);
    });

    test('unsubscribes the onDetach handler', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      // Subscribing happens at construction time. The mock proxy exposes
      // its handler set so we can directly observe registration/teardown.
      expect(harness.proxy.detachHandlers.size).toBe(1);

      harness.dispatcher.dispose();

      // After dispose the dispatcher must release its detach handler so
      // the proxy isn't left holding a stale closure that references the
      // disposed dispatcher's `attachedTargets` set.
      expect(harness.proxy.detachHandlers.size).toBe(0);
    });

    test('unsubscribes the onEvent handler', async () => {
      harness = createHarness({ sendResult: { id: 1, result: {} } });

      // PR10: the dispatcher subscribes to proxy.onEvent so it can
      // forward CDP events to the runtime. After dispose, the
      // subscription must be released — otherwise the proxy keeps
      // a stale closure referencing the disposed dispatcher's hooks.
      expect(harness.proxy.eventHandlers.size).toBe(1);

      harness.dispatcher.dispose();

      expect(harness.proxy.eventHandlers.size).toBe(0);
    });
  });

  // ── resolveHostBrowserTarget: numeric tab ID vs CDP targetId routing ──

  describe('handle — resolveHostBrowserTarget numeric vs non-numeric routing', () => {
    /**
     * These tests wire a resolveTarget that mirrors the real
     * resolveHostBrowserTarget logic from worker.ts: numeric strings
     * (positive integers) route as { tabId }, non-numeric strings
     * route as { targetId }, and undefined falls back to the active
     * tab (simulated as tabId 42 here).
     */
    function createHarnessWithRealResolveTarget(
      options: MockCdpProxyOptions = {},
    ): DispatcherTestHarness {
      const h = createHarness(options);
      h.resolveTargetImpl = async (cdpSessionId) => {
        if (cdpSessionId) {
          const asNumber = Number(cdpSessionId);
          if (Number.isInteger(asNumber) && asNumber > 0) {
            return { tabId: asNumber };
          }
          return { targetId: cdpSessionId };
        }
        // Simulate active-tab fallback.
        return { tabId: 42 };
      };
      return h;
    }

    test('numeric cdpSessionId "12345" resolves to { tabId: 12345 }', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: '12345',
      });

      // resolveTarget was called with the numeric string.
      expect(harness.resolveTargetCalls).toEqual(['12345']);

      // The proxy should have attached using tabId, not targetId.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.attachCalls[0].target).toEqual({ tabId: 12345 });

      // send also uses the tabId target.
      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.proxy.sendCalls[0].target).toEqual({ tabId: 12345 });

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(false);
    });

    test('non-numeric cdpSessionId "ABC123DEF456" resolves to { targetId: "ABC123DEF456" }', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: 'ABC123DEF456',
      });

      expect(harness.resolveTargetCalls).toEqual(['ABC123DEF456']);

      // Non-numeric strings route through the CDP targetId path.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.attachCalls[0].target).toEqual({
        targetId: 'ABC123DEF456',
      });

      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.proxy.sendCalls[0].target).toEqual({
        targetId: 'ABC123DEF456',
      });

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(false);
    });

    test('UUID-style cdpSessionId routes as targetId', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      const uuidTarget = '550e8400-e29b-41d4-a716-446655440000';
      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: uuidTarget,
      });

      expect(harness.resolveTargetCalls).toEqual([uuidTarget]);
      expect(harness.proxy.attachCalls[0].target).toEqual({
        targetId: uuidTarget,
      });
    });

    test('undefined cdpSessionId falls back to active tab (tabId: 42)', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle(sampleRequest);

      // sampleRequest has no cdpSessionId → undefined.
      expect(harness.resolveTargetCalls).toEqual([undefined]);

      // Falls back to the simulated active tab.
      expect(harness.proxy.attachCalls.length).toBe(1);
      expect(harness.proxy.attachCalls[0].target).toEqual({ tabId: 42 });

      expect(harness.proxy.sendCalls.length).toBe(1);
      expect(harness.proxy.sendCalls[0].target).toEqual({ tabId: 42 });

      expect(harness.results.length).toBe(1);
      expect(harness.results[0].isError).toBe(false);
    });

    test('"0" is not a valid Chrome tab ID and routes as targetId', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: '0',
      });

      // 0 is not a positive integer, so it routes as targetId.
      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: '0' });
    });

    test('negative number string routes as targetId', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: '-5',
      });

      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: '-5' });
    });

    test('floating point string routes as targetId', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: '12.5',
      });

      expect(harness.proxy.attachCalls[0].target).toEqual({
        targetId: '12.5',
      });
    });

    test('exponential notation "1e3" routes as targetId, not tabId 1000', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: '1e3',
      });

      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: '1e3' });
    });

    test('hex literal "0x10" routes as targetId, not tabId 16', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: '0x10',
      });

      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: '0x10' });
    });

    test('whitespace-padded " 42 " routes as targetId', async () => {
      harness = createHarnessWithRealResolveTarget({
        sendResult: { id: 1, result: {} },
      });

      await harness.dispatcher.handle({
        ...sampleRequest,
        cdpSessionId: ' 42 ',
      });

      expect(harness.proxy.attachCalls[0].target).toEqual({ targetId: ' 42 ' });
    });
  });

  // ── PR10: CDP event forwarding ─────────────────────────────────────

  describe('forwardCdpEvent — chrome.debugger.onEvent forwarding', () => {
    test('forwards CDP events to the worker hook with method, params, and sessionId', () => {
      // Fire a flat-session event from chrome.debugger and assert
      // that the dispatcher's `forwardCdpEvent` hook was invoked
      // with a host_browser_event envelope carrying the same fields.
      // The CdpEventFrame's `sessionId` field maps to the envelope's
      // `cdpSessionId` field — see host-browser-dispatcher.ts for
      // the rationale on the rename.
      harness.proxy.fireEvent({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'frame-1', url: 'https://example.com' } },
        sessionId: 'flat-session-xyz',
      });

      expect(harness.forwardedEvents.length).toBe(1);
      expect(harness.forwardedEvents[0]).toEqual({
        type: 'host_browser_event',
        method: 'Page.frameNavigated',
        params: { frame: { id: 'frame-1', url: 'https://example.com' } },
        cdpSessionId: 'flat-session-xyz',
      });
    });

    test('forwards events with no params and no sessionId', () => {
      harness.proxy.fireEvent({ method: 'Target.targetDestroyed' });

      expect(harness.forwardedEvents.length).toBe(1);
      expect(harness.forwardedEvents[0]).toEqual({
        type: 'host_browser_event',
        method: 'Target.targetDestroyed',
        params: undefined,
        cdpSessionId: undefined,
      });
    });

    test('multiple events fired in sequence are forwarded in order', () => {
      harness.proxy.fireEvent({ method: 'Page.loadEventFired' });
      harness.proxy.fireEvent({ method: 'Network.responseReceived' });
      harness.proxy.fireEvent({ method: 'Runtime.consoleAPICalled' });

      expect(harness.forwardedEvents.length).toBe(3);
      expect(harness.forwardedEvents.map((e) => e.method)).toEqual([
        'Page.loadEventFired',
        'Network.responseReceived',
        'Runtime.consoleAPICalled',
      ]);
    });

    test('a throwing forwardCdpEvent hook does not crash the dispatcher', () => {
      harness.forwardCdpEventImpl = () => {
        throw new Error('forwarder exploded');
      };

      // Must not throw out of the proxy's onEvent firing path —
      // otherwise an unhandled exception in the worker's relay
      // helper would tear down the chrome.debugger.onEvent listener
      // and silently break event forwarding.
      expect(() =>
        harness.proxy.fireEvent({ method: 'Page.frameNavigated' }),
      ).not.toThrow();
    });

    test('a dispatcher with no forwardCdpEvent hook still tolerates events', () => {
      // Build a fresh dispatcher that omits the hook entirely. The
      // proxy still notifies its event handlers (since the dispatcher
      // subscribes unconditionally so unsubscribe is symmetric on
      // dispose) — the handler must short-circuit when no hook is
      // wired.
      const proxy = createMockCdpProxy();
      const dispatcher = createHostBrowserDispatcher({
        cdpProxy: proxy,
        resolveTarget: async () => ({ tabId: 1 }),
        postResult: async () => {},
      });
      expect(() =>
        proxy.fireEvent({ method: 'Page.frameNavigated' }),
      ).not.toThrow();
      dispatcher.dispose();
    });
  });

  // ── PR10: detach → host_browser_session_invalidated forwarding ────

  describe('forwardSessionInvalidated — chrome.debugger.onDetach forwarding', () => {
    test('forwards a tabId detach as a stringified targetId envelope', () => {
      // Sanity-check the runtime's expectation: the wire envelope
      // always carries `targetId` as a string, even when the
      // underlying detach was for a numeric tabId.
      harness.proxy.fireDetach({ tabId: 42 }, 'target_closed');

      expect(harness.forwardedInvalidations.length).toBe(1);
      expect(harness.forwardedInvalidations[0]).toEqual({
        type: 'host_browser_session_invalidated',
        targetId: '42',
        reason: 'target_closed',
      });
    });

    test('forwards a targetId detach with the targetId preserved verbatim', () => {
      harness.proxy.fireDetach(
        { targetId: 'target-xyz' },
        'canceled_by_user',
      );

      expect(harness.forwardedInvalidations.length).toBe(1);
      expect(harness.forwardedInvalidations[0]).toEqual({
        type: 'host_browser_session_invalidated',
        targetId: 'target-xyz',
        reason: 'canceled_by_user',
      });
    });

    test('forwards detaches with neither tabId nor targetId as advisory envelopes', () => {
      // The dispatcher tolerates this shape (e.g. an extensionId-only
      // detach) and surfaces it without a targetId so the runtime
      // logger has visibility into the signal.
      harness.proxy.fireDetach({}, 'extension_unloaded');

      expect(harness.forwardedInvalidations.length).toBe(1);
      expect(harness.forwardedInvalidations[0]).toEqual({
        type: 'host_browser_session_invalidated',
        targetId: undefined,
        reason: 'extension_unloaded',
      });
    });

    test('still clears the local attach cache when forwarding fails', async () => {
      // Wire a forwarder that throws to assert that local cache
      // eviction on onDetach is unaffected by a broken runtime
      // forwarder. The forward and the local bookkeeping must be
      // independent.
      harness = createHarness({ sendResult: { id: 1, result: {} } });
      harness.forwardSessionInvalidatedImpl = () => {
        throw new Error('forwarder exploded');
      };

      await harness.dispatcher.handle(sampleRequest);
      expect(harness.proxy.attachCalls.length).toBe(1);

      // The fire-detach call must NOT throw despite the forwarder
      // exploding internally — the dispatcher catches and logs.
      expect(() =>
        harness.proxy.fireDetach({ tabId: 42 }, 'target_closed'),
      ).not.toThrow();

      // The next request should still re-attach because the local
      // attachedTargets cache was cleared by onDetach.
      await harness.dispatcher.handle({
        ...sampleRequest,
        requestId: 'req-2',
      });
      expect(harness.proxy.attachCalls.length).toBe(2);
    });
  });
});
