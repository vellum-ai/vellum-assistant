/**
 * Standalone CDP JSON-RPC proxy that wraps `chrome.debugger`.
 *
 * This module is deliberately decoupled from worker.ts and from any WebSocket
 * relay — its only responsibility is to provide a typed attach/detach/send/
 * onEvent surface over the chrome.debugger API. It will be consumed by the
 * host-browser dispatcher in a follow-up PR (Phase 2 / PR 9). Keeping it
 * standalone lets us write unit tests against an injectable ChromeDebuggerApi
 * mock without pulling in the service worker's lifecycle concerns.
 *
 * Flat-session handling
 * ---------------------
 * The chrome.debugger API does not expose a `sessionId` argument on either
 * `sendCommand` or `onEvent` — sessions created via `Target.attachToTarget`
 * with `flatten: true` are addressed by stuffing the `sessionId` into the
 * command/event `params` object. This proxy mirrors that contract:
 *
 *   - `send()`: when `frame.sessionId` is provided, it is folded into the
 *     params object as `params.sessionId` before being passed to
 *     `api.sendCommand`. Callers should populate `frame.sessionId` rather
 *     than mutating params themselves.
 *
 *   - `onEvent()`: when an event arrives whose `params` contains a
 *     `sessionId` field, that value is hoisted onto the emitted
 *     `CdpEventFrame.sessionId` so consumers can route events without
 *     having to peek into params.
 *
 * Errors from the underlying chrome.debugger callbacks are read through
 * `api.runtime.lastError` (rather than the global `chrome.runtime.lastError`)
 * so that tests passing a mocked `ChromeDebuggerApi` can simulate failures
 * by toggling `runtime.lastError` on the mock.
 *
 * XXX(host-browser-ph2/pr-6): A unit test file
 *   `clients/chrome-extension/background/__tests__/cdp-proxy.test.ts`
 * is not included in this PR because `clients/chrome-extension/` does not
 * yet have a `package.json`, `tsconfig.json`, or any configured test runner
 * (neither vitest nor bun:test is wired up — the extension is built via
 * `bun build` from `build.sh`, which does not type-check or run tests).
 * Per the PR 6 plan instructions, the test file is deferred until a test
 * runner is introduced for the Chrome extension package. The public surface
 * (CdpRequestFrame / CdpResultFrame / CdpEventFrame / CdpTarget / CdpProxy /
 * ChromeDebuggerApi / createCdpProxy) is designed for injectable mocking so
 * adding tests in a follow-up PR is trivial once a runner exists. Now that
 * `runtime.lastError` is part of the injectable `ChromeDebuggerApi`, mocked
 * tests can fully exercise both success and error paths without depending
 * on a real `chrome` global.
 */

/** Raw CDP frame as received from the runtime over the relay. */
export interface CdpRequestFrame {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  /**
   * Optional CDP session id for nested flat sessions. The chrome.debugger
   * `sendCommand` API does not accept a sessionId argument; this proxy folds
   * the value into `params.sessionId` before dispatch (see the module
   * docstring for the flat-session contract).
   */
  sessionId?: string;
}

/** Raw CDP result frame that the extension sends back. */
export interface CdpResultFrame {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** CDP event frame forwarded from chrome.debugger.onEvent. */
export interface CdpEventFrame {
  method: string;
  params?: unknown;
  sessionId?: string;
}

/**
 * Target identifier passed to chrome.debugger.attach. Mirrors the shape of
 * `chrome.debugger.Debuggee` from `@types/chrome` so that when those types
 * are added to the Chrome extension package in a later PR the cast between
 * the two is a no-op.
 */
export interface CdpDebuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
}

export interface CdpTarget {
  tabId?: number;
  targetId?: string;
}

export interface CdpProxy {
  attach(target: CdpTarget, requiredVersion: string): Promise<void>;
  detach(target: CdpTarget): Promise<void>;
  send(target: CdpTarget, frame: CdpRequestFrame): Promise<CdpResultFrame>;
  onEvent(handler: (event: CdpEventFrame) => void): () => void; // returns unsubscribe
  dispose(): void;
}

/**
 * Inject the chrome.debugger API (plus the slice of `chrome.runtime` we read
 * `lastError` from) so tests can pass a mock. The shape is intentionally
 * source-compatible with the real `chrome.debugger` namespace plus a
 * `runtime.lastError` field — at runtime we satisfy this by composing
 * `chrome.debugger` and `chrome.runtime` (see the default in `createCdpProxy`).
 *
 * Reading `lastError` through the injected `api.runtime.lastError` (rather
 * than the global `chrome.runtime.lastError`) is what makes the proxy
 * properly testable: a mocked `ChromeDebuggerApi` can simulate failure paths
 * by toggling `runtime.lastError` on the mock between callback invocations.
 */
export interface ChromeDebuggerApi {
  attach(target: CdpDebuggee, requiredVersion: string, callback?: () => void): void;
  detach(target: CdpDebuggee, callback?: () => void): void;
  sendCommand(
    target: CdpDebuggee,
    method: string,
    params?: Record<string, unknown>,
    callback?: (result?: unknown) => void,
  ): void;
  onEvent: {
    addListener(
      callback: (
        source: CdpDebuggee,
        method: string,
        params?: unknown,
      ) => void,
    ): void;
    removeListener(
      callback: (
        source: CdpDebuggee,
        method: string,
        params?: unknown,
      ) => void,
    ): void;
  };
  onDetach: {
    addListener(callback: (source: CdpDebuggee, reason: string) => void): void;
    removeListener(callback: (source: CdpDebuggee, reason: string) => void): void;
  };
  /**
   * Mirror of `chrome.runtime.lastError`. The chrome.debugger callbacks
   * report errors by setting `chrome.runtime.lastError` synchronously inside
   * the callback. We thread the `runtime` reference through the injectable
   * api so that mocked tests do not need to set anything on a global `chrome`.
   */
  runtime: {
    lastError?: { message?: string };
  };
}

/**
 * Minimal ambient view of the parts of the `chrome` global that this module
 * touches. Declared locally so the module does not depend on `@types/chrome`
 * and can compile standalone under a tsconfig that only includes this file.
 * When `@types/chrome` lands in the extension package these declarations can
 * be removed — the shapes are source-compatible with the real types.
 */
declare const chrome: {
  debugger: Omit<ChromeDebuggerApi, "runtime">;
  runtime: {
    lastError?: { message?: string };
  };
};

/**
 * Compose a default `ChromeDebuggerApi` from the real `chrome` global. We
 * splice `chrome.runtime` onto `chrome.debugger` so that the merged object
 * satisfies the `ChromeDebuggerApi` interface (which now includes a
 * `runtime.lastError` field). The runtime reference is read live on every
 * access — `chrome.runtime.lastError` is set by the browser synchronously
 * during callback invocation, so we expose it via a getter rather than
 * snapshotting at module load.
 */
function defaultChromeDebuggerApi(): ChromeDebuggerApi {
  const api = chrome.debugger as ChromeDebuggerApi;
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "runtime") return chrome.runtime;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function createCdpProxy(api: ChromeDebuggerApi = defaultChromeDebuggerApi()): CdpProxy {
  const eventHandlers = new Set<(event: CdpEventFrame) => void>();

  const onEventListener = (
    _source: CdpDebuggee,
    method: string,
    params?: unknown,
  ) => {
    // chrome.debugger.onEvent does not surface sessionId as a separate
    // argument; for flat sessions Chrome stuffs the value into
    // `params.sessionId`. Hoist it onto the emitted CdpEventFrame so that
    // downstream consumers can route events without poking into params.
    const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    const event: CdpEventFrame = { method, params, sessionId };
    for (const h of eventHandlers) {
      try {
        h(event);
      } catch (err) {
        console.error("[cdp-proxy] event handler threw", err);
      }
    }
  };
  api.onEvent.addListener(onEventListener);

  function targetToDebuggee(target: CdpTarget): CdpDebuggee {
    if (target.targetId) return { targetId: target.targetId };
    if (target.tabId !== undefined) return { tabId: target.tabId };
    throw new Error("CdpTarget must have either tabId or targetId");
  }

  return {
    attach(target, requiredVersion) {
      return new Promise<void>((resolve, reject) => {
        api.attach(targetToDebuggee(target), requiredVersion, () => {
          const err = api.runtime.lastError;
          if (err) reject(new Error(err.message ?? "chrome.debugger.attach failed"));
          else resolve();
        });
      });
    },
    detach(target) {
      return new Promise<void>((resolve, reject) => {
        api.detach(targetToDebuggee(target), () => {
          const err = api.runtime.lastError;
          if (err) reject(new Error(err.message ?? "chrome.debugger.detach failed"));
          else resolve();
        });
      });
    },
    /**
     * Dispatch a CDP command. The chrome.debugger `sendCommand` API does not
     * accept a sessionId argument: for flat sessions (created via
     * `Target.attachToTarget` with `flatten: true`) the sessionId is passed
     * by stuffing it into the command params object. When `frame.sessionId`
     * is provided we fold it into a shallow copy of `frame.params` before
     * dispatch so callers do not have to manage that themselves. See the
     * module docstring for the full flat-session contract.
     */
    send(target, frame) {
      return new Promise<CdpResultFrame>((resolve) => {
        const paramsWithSession = frame.sessionId
          ? { ...(frame.params ?? {}), sessionId: frame.sessionId }
          : frame.params;
        api.sendCommand(targetToDebuggee(target), frame.method, paramsWithSession, (result) => {
          const err = api.runtime.lastError;
          if (err) {
            resolve({
              id: frame.id,
              error: { code: -32000, message: err.message ?? "chrome.debugger.sendCommand failed" },
            });
          } else {
            resolve({ id: frame.id, result });
          }
        });
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    dispose() {
      eventHandlers.clear();
      api.onEvent.removeListener(onEventListener);
    },
  };
}
