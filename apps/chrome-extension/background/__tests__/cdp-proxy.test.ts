/**
 * Tests for the standalone CDP JSON-RPC proxy.
 *
 * Drives `createCdpProxy` against an injected mock `ChromeDebuggerApi` so we
 * can exercise both happy and error paths without touching any real
 * `chrome.debugger` surface. The mock records every call and exposes a
 * mutable `runtime.lastError` field — tests toggle that field between
 * callback invocations to simulate the way Chrome surfaces async failures.
 */

import { describe, test, expect } from 'bun:test';

import {
  createCdpProxy,
  type ChromeDebuggerApi,
  type CdpDebuggee,
  type CdpEventFrame,
  type CdpRequestFrame,
  type CdpTarget,
  type DebuggerSession,
} from '../cdp-proxy.js';

// ── Mock fixture ────────────────────────────────────────────────────

interface MockChromeDebuggerApi extends ChromeDebuggerApi {
  attachCalls: Array<{ target: DebuggerSession; requiredVersion: string }>;
  detachCalls: Array<{ target: DebuggerSession }>;
  sendCommandCalls: Array<{
    target: DebuggerSession;
    method: string;
    params?: Record<string, unknown>;
  }>;
  /**
   * Configurable result that the next `sendCommand` callback will be invoked
   * with. Defaults to `undefined`.
   */
  nextSendCommandResult?: unknown;
  /** Listeners registered through `onEvent.addListener`. */
  eventListeners: Set<
    (source: DebuggerSession, method: string, params?: unknown) => void
  >;
  /** Listeners removed through `onEvent.removeListener`. */
  removedEventListeners: Array<
    (source: DebuggerSession, method: string, params?: unknown) => void
  >;
  /** Listeners registered through `onDetach.addListener`. */
  detachListeners: Set<(source: CdpDebuggee, reason: string) => void>;
  /** Synthetically dispatch an event to all currently-registered listeners. */
  fireEvent(source: DebuggerSession, method: string, params?: unknown): void;
}

function createMockApi(): MockChromeDebuggerApi {
  const attachCalls: MockChromeDebuggerApi['attachCalls'] = [];
  const detachCalls: MockChromeDebuggerApi['detachCalls'] = [];
  const sendCommandCalls: MockChromeDebuggerApi['sendCommandCalls'] = [];
  const eventListeners: MockChromeDebuggerApi['eventListeners'] = new Set();
  const removedEventListeners: MockChromeDebuggerApi['removedEventListeners'] = [];
  const detachListeners: MockChromeDebuggerApi['detachListeners'] = new Set();

  const api: MockChromeDebuggerApi = {
    attachCalls,
    detachCalls,
    sendCommandCalls,
    eventListeners,
    removedEventListeners,
    detachListeners,
    nextSendCommandResult: undefined,
    runtime: { lastError: undefined },
    attach(target, requiredVersion, callback) {
      attachCalls.push({ target, requiredVersion });
      callback?.();
    },
    detach(target, callback) {
      detachCalls.push({ target });
      callback?.();
    },
    sendCommand(target, method, params, callback) {
      sendCommandCalls.push({ target, method, params });
      callback?.(api.nextSendCommandResult);
    },
    onEvent: {
      addListener(callback) {
        eventListeners.add(callback);
      },
      removeListener(callback) {
        eventListeners.delete(callback);
        removedEventListeners.push(callback);
      },
    },
    onDetach: {
      addListener(callback) {
        detachListeners.add(callback);
      },
      removeListener(callback) {
        detachListeners.delete(callback);
      },
    },
    fireEvent(source, method, params) {
      for (const listener of eventListeners) {
        listener(source, method, params);
      }
    },
  };
  return api;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createCdpProxy', () => {
  describe('attach', () => {
    test('resolves on success', async () => {
      const api = createMockApi();
      const proxy = createCdpProxy(api);

      await proxy.attach({ tabId: 1 }, '1.3');

      expect(api.attachCalls.length).toBe(1);
      expect(api.attachCalls[0].target).toEqual({ tabId: 1 });
      expect(api.attachCalls[0].requiredVersion).toBe('1.3');
    });

    test('rejects on runtime.lastError', async () => {
      const api = createMockApi();
      // Override the default attach so we can set lastError synchronously
      // before invoking the callback — matches how Chrome's bindings flag
      // failures from inside the callback frame.
      api.attach = (_target, _requiredVersion, callback) => {
        api.runtime.lastError = { message: 'no such tab' };
        callback?.();
        api.runtime.lastError = undefined;
      };
      const proxy = createCdpProxy(api);

      let rejectionMessage: string | null = null;
      try {
        await proxy.attach({ tabId: 99 }, '1.3');
      } catch (err) {
        rejectionMessage = err instanceof Error ? err.message : String(err);
      }
      expect(rejectionMessage).toBe('no such tab');
    });
  });

  describe('send', () => {
    test('resolves with result frame on success', async () => {
      const api = createMockApi();
      api.nextSendCommandResult = { data: 'ok' };
      const proxy = createCdpProxy(api);

      const frame: CdpRequestFrame = {
        id: 7,
        method: 'Browser.getVersion',
        params: { foo: 'bar' },
      };
      const result = await proxy.send({ tabId: 1 }, frame);

      expect(result).toEqual({ id: 7, result: { data: 'ok' } });
      expect(api.sendCommandCalls.length).toBe(1);
      expect(api.sendCommandCalls[0].method).toBe('Browser.getVersion');
      expect(api.sendCommandCalls[0].params).toEqual({ foo: 'bar' });
    });

    test('resolves with error frame on runtime.lastError', async () => {
      const api = createMockApi();
      api.sendCommand = (_target, _method, _params, callback) => {
        api.runtime.lastError = { message: 'cannot find context' };
        callback?.(undefined);
        api.runtime.lastError = undefined;
      };
      const proxy = createCdpProxy(api);

      const frame: CdpRequestFrame = { id: 11, method: 'Page.reload' };
      const result = await proxy.send({ tabId: 1 }, frame);

      expect(result).toEqual({
        id: 11,
        error: { code: -32000, message: 'cannot find context' },
      });
    });

    // Regression test for Codex P2: when targetToDebuggee throws synchronously
    // inside the Promise executor (because the target has neither tabId nor
    // targetId) the proxy must convert it into a -32602 error frame instead
    // of letting the throw escape as a promise rejection. send()'s contract is
    // to ALWAYS resolve with a CdpResultFrame.
    test('resolves with error frame when targetToDebuggee throws synchronously', async () => {
      const api = createMockApi();
      const proxy = createCdpProxy(api);

      const frame: CdpRequestFrame = { id: 13, method: 'Page.reload' };
      // Cast to CdpTarget so TypeScript accepts the deliberately empty shape.
      const badTarget: CdpTarget = {};
      const result = await proxy.send(badTarget, frame);

      expect(result).toEqual({
        id: 13,
        error: {
          code: -32602,
          message: 'CdpTarget must have either tabId or targetId',
        },
      });
      // sendCommand must NOT have been invoked — we never made it past the
      // pre-flight target resolution.
      expect(api.sendCommandCalls.length).toBe(0);
    });
  });

  describe('onEvent', () => {
    test('delivers events to all registered handlers', () => {
      const api = createMockApi();
      const proxy = createCdpProxy(api);

      const received1: CdpEventFrame[] = [];
      const received2: CdpEventFrame[] = [];
      proxy.onEvent((event) => received1.push(event));
      proxy.onEvent((event) => received2.push(event));

      api.fireEvent({ tabId: 1, sessionId: 'sess-A' }, 'Page.loadEventFired', {
        timestamp: 123,
      });

      const expected: CdpEventFrame = {
        method: 'Page.loadEventFired',
        params: { timestamp: 123 },
        sessionId: 'sess-A',
      };
      expect(received1).toEqual([expected]);
      expect(received2).toEqual([expected]);
    });

    test('returns an unsubscribe that stops future deliveries', () => {
      const api = createMockApi();
      const proxy = createCdpProxy(api);

      const received: CdpEventFrame[] = [];
      const unsubscribe = proxy.onEvent((event) => received.push(event));

      api.fireEvent({ tabId: 1 }, 'Page.loadEventFired', { phase: 'first' });
      expect(received.length).toBe(1);

      unsubscribe();

      api.fireEvent({ tabId: 1 }, 'Page.loadEventFired', { phase: 'second' });
      // The unsubscribed handler must not have been called again.
      expect(received.length).toBe(1);
    });
  });

  describe('dispose', () => {
    test('removes the internal onEvent listener', () => {
      const api = createMockApi();
      const proxy = createCdpProxy(api);

      // Capture the listener that the proxy registered at construction time.
      expect(api.eventListeners.size).toBe(1);
      const registered = Array.from(api.eventListeners)[0];

      proxy.dispose();

      // The proxy must call removeListener with the SAME callback reference
      // that was registered — otherwise Chrome's listener bookkeeping leaks.
      expect(api.removedEventListeners).toContain(registered);
      expect(api.eventListeners.size).toBe(0);
    });
  });
});
