/**
 * Standalone CDP JSON-RPC proxy that wraps `chrome.debugger`.
 *
 * Provides a typed attach/detach/send/onEvent surface over the chrome.debugger
 * API. The module is decoupled from the service worker lifecycle and from any
 * relay transport so it can be consumed by a host-browser dispatcher and
 * exercised in isolation. The `ChromeDebuggerApi` interface is injectable so
 * tests can drive both success and error paths against a mock; tests will be
 * added once a test runner is configured for this package.
 *
 * Flat-session handling
 * ---------------------
 * Chrome 125+ supports flat sessions created via `Target.attachToTarget` with
 * `flatten: true`. For flat sessions the child `sessionId` is addressed via
 * the `target` (DebuggerSession) argument to `chrome.debugger.sendCommand` —
 * NOT by smuggling the value into the command params object. This proxy
 * mirrors that contract:
 *
 *   - `send()`: when `frame.sessionId` is provided, the value is attached to
 *     the `DebuggerSession` target passed to `api.sendCommand`. Command params
 *     are forwarded as-is.
 *
 *   - `onEvent()`: the `source: DebuggerSession` argument supplied by Chrome
 *     identifies the originating session. The proxy reads `source.sessionId`
 *     and hoists it onto the emitted `CdpEventFrame.sessionId` so consumers
 *     can route events without having to inspect the source object.
 *
 * Errors from the underlying chrome.debugger callbacks are read through
 * `api.runtime.lastError` (rather than the global `chrome.runtime.lastError`)
 * so that tests passing a mocked `ChromeDebuggerApi` can simulate failures
 * by toggling `runtime.lastError` on the mock.
 */

/** Raw CDP frame as received from the runtime over the relay. */
export interface CdpRequestFrame {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  /**
   * Optional CDP session id for nested flat sessions. Routed via the
   * `DebuggerSession` target argument of `chrome.debugger.sendCommand` (see
   * the module docstring for the flat-session contract).
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

/**
 * `DebuggerSession` is the Chrome 125+ shape that `chrome.debugger.sendCommand`
 * (and the `onEvent` `source` argument) accept: a `Debuggee` plus an optional
 * `sessionId` that addresses a child flat session created via
 * `Target.attachToTarget` with `flatten: true`.
 */
export interface DebuggerSession extends CdpDebuggee {
  sessionId?: string;
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
  onDetach(handler: (target: CdpDebuggee, reason: string) => void): () => void; // returns unsubscribe
  dispose(): void;
}

/**
 * Inject the chrome.debugger API (plus the slice of `chrome.runtime` we read
 * `lastError` from) so tests can pass a mock. The shape is intentionally
 * source-compatible with the real `chrome.debugger` namespace plus a
 * `runtime.lastError` field — at runtime we satisfy this by composing
 * `chrome.debugger` and `chrome.runtime` (see the default in `createCdpProxy`).
 *
 * `attach` / `detach` / `sendCommand` / `onEvent` all accept a
 * `DebuggerSession` so that flat-session child commands and events can be
 * routed via the target's `sessionId` field, matching Chrome 125+ semantics.
 *
 * Reading `lastError` through the injected `api.runtime.lastError` (rather
 * than the global `chrome.runtime.lastError`) is what makes the proxy
 * properly testable: a mocked `ChromeDebuggerApi` can simulate failure paths
 * by toggling `runtime.lastError` on the mock between callback invocations.
 */
export interface ChromeDebuggerApi {
  attach(target: DebuggerSession, requiredVersion: string, callback?: () => void): void;
  detach(target: DebuggerSession, callback?: () => void): void;
  sendCommand(
    target: DebuggerSession,
    method: string,
    params?: Record<string, unknown>,
    callback?: (result?: unknown) => void,
  ): void;
  onEvent: {
    addListener(
      callback: (
        source: DebuggerSession,
        method: string,
        params?: unknown,
      ) => void,
    ): void;
    removeListener(
      callback: (
        source: DebuggerSession,
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
  const detachHandlers = new Set<(target: CdpDebuggee, reason: string) => void>();

  const onEventListener = (
    source: DebuggerSession,
    method: string,
    params?: unknown,
  ) => {
    // For flat sessions Chrome 125+ surfaces the originating session id on
    // the `source` DebuggerSession (NOT inside `params`). Hoist it onto the
    // emitted CdpEventFrame so downstream consumers can route events without
    // having to inspect the source object.
    const event: CdpEventFrame = { method, params, sessionId: source.sessionId };
    for (const h of eventHandlers) {
      try {
        h(event);
      } catch (err) {
        console.error("[cdp-proxy] event handler threw", err);
      }
    }
  };
  api.onEvent.addListener(onEventListener);

  const onDetachListener = (source: CdpDebuggee, reason: string) => {
    for (const h of detachHandlers) {
      try {
        h(source, reason);
      } catch (err) {
        console.error("[cdp-proxy] detach handler threw", err);
      }
    }
  };
  api.onDetach.addListener(onDetachListener);

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
     * Dispatch a CDP command. For flat sessions (created via
     * `Target.attachToTarget` with `flatten: true`) Chrome 125+ routes the
     * child `sessionId` via the `target` (DebuggerSession) argument — not
     * via the command params object. When `frame.sessionId` is provided we
     * attach it to the DebuggerSession passed to `api.sendCommand`; params
     * are forwarded as-is.
     */
    send(target, frame) {
      return new Promise<CdpResultFrame>((resolve) => {
        const debuggerSession: DebuggerSession = frame.sessionId
          ? { ...targetToDebuggee(target), sessionId: frame.sessionId }
          : targetToDebuggee(target);
        api.sendCommand(debuggerSession, frame.method, frame.params, (result) => {
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
    onDetach(handler) {
      detachHandlers.add(handler);
      return () => {
        detachHandlers.delete(handler);
      };
    },
    dispose() {
      eventHandlers.clear();
      detachHandlers.clear();
      api.onEvent.removeListener(onEventListener);
      api.onDetach.removeListener(onDetachListener);
    },
  };
}
