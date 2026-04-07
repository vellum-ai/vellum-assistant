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
 * adding tests in a follow-up PR is trivial once a runner exists.
 */

/** Raw CDP frame as received from the runtime over the relay. */
export interface CdpRequestFrame {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  /** Optional CDP session id for nested flat sessions. */
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

/** Inject the chrome.debugger API so tests can pass a mock. */
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
}

/**
 * Minimal ambient view of the parts of the `chrome` global that this module
 * touches. Declared locally so the module does not depend on `@types/chrome`
 * and can compile standalone under a tsconfig that only includes this file.
 * When `@types/chrome` lands in the extension package these declarations can
 * be removed — the shapes are source-compatible with the real types.
 */
declare const chrome: {
  debugger: ChromeDebuggerApi;
  runtime: {
    lastError?: { message: string };
  };
};

export function createCdpProxy(api: ChromeDebuggerApi = chrome.debugger): CdpProxy {
  const eventHandlers = new Set<(event: CdpEventFrame) => void>();

  const onEventListener = (
    _source: CdpDebuggee,
    method: string,
    params?: unknown,
  ) => {
    const event: CdpEventFrame = { method, params };
    // chrome.debugger.onEvent does not surface sessionId; flat sessions land in params.sessionId.
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
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      });
    },
    detach(target) {
      return new Promise<void>((resolve, reject) => {
        api.detach(targetToDebuggee(target), () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      });
    },
    send(target, frame) {
      return new Promise<CdpResultFrame>((resolve) => {
        api.sendCommand(targetToDebuggee(target), frame.method, frame.params, (result) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ id: frame.id, error: { code: -32000, message: err.message } });
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
