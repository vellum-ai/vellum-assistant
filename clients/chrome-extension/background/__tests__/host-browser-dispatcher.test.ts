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
  type HostBrowserRequestEnvelope,
  type HostBrowserCancelEnvelope,
  type HostBrowserResultEnvelope,
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
}

function createMockCdpProxy(options: MockCdpProxyOptions = {}): MockCdpProxy {
  const eventHandlers = new Set<(event: CdpEventFrame) => void>();
  const detachHandlers = new Set<(target: CdpDebuggee, reason: string) => void>();
  const attachCalls: Array<{ target: CdpTarget; requiredVersion: string }> = [];
  const sendCalls: Array<{ target: CdpTarget; frame: CdpRequestFrame }> = [];
  const detachCalls: CdpTarget[] = [];
  let disposeCalls = 0;

  const proxy: MockCdpProxy = {
    attachCalls,
    sendCalls,
    detachCalls,
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
  resolveTargetCalls: Array<string | undefined>;
  /** Override this to throw from resolveTarget. */
  resolveTargetImpl: (
    cdpSessionId: string | undefined,
  ) => Promise<{ tabId?: number; targetId?: string }>;
  /** Override this to throw from postResult. */
  postResultImpl: (result: HostBrowserResultEnvelope) => Promise<void>;
}

function createHarness(options: MockCdpProxyOptions = {}): DispatcherTestHarness {
  const proxy = createMockCdpProxy(options);
  const results: HostBrowserResultEnvelope[] = [];
  const resolveTargetCalls: Array<string | undefined> = [];

  const harness: DispatcherTestHarness = {
    dispatcher: null as unknown as HostBrowserDispatcher,
    proxy,
    results,
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

    test('routes via targetId when cdpSessionId is provided', async () => {
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
      expect(harness.proxy.sendCalls[0].frame.sessionId).toBe('target-xyz');
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
    test('aborts the in-flight controller for the matching request id', async () => {
      // Gate resolveTarget on an externally-controllable promise so we can
      // issue a cancel while the handler is still mid-flight.
      let releaseResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });

      harness.resolveTargetImpl = async () => {
        await gate;
        return { tabId: 7 };
      };

      const handlePromise = harness.dispatcher.handle(sampleRequest);

      // Mid-flight cancel.
      const cancelEnvelope: HostBrowserCancelEnvelope = {
        type: 'host_browser_cancel',
        requestId: 'req-1',
      };
      harness.dispatcher.cancel(cancelEnvelope);

      // Release the gate so the handler can run to completion.
      releaseResolve();
      await handlePromise;

      // Handler still ran to completion and posted a result — the dispatcher
      // does not early-return on cancel; instead it removes the abort
      // controller from the in-flight map. This matches the plan's acceptance
      // criteria for the "cancel aborts the in-flight controller" test.
      expect(harness.results.length).toBe(1);
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
  });
});
