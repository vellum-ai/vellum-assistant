// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./bun-test-shim.d.ts" />

/**
 * Minimal ambient declarations for the subset of the Chrome Extension API
 * surface used by the Vellum browser-relay extension's typed modules.
 *
 * This is intentionally narrow — it covers what's needed by the
 * typechecked files under `background/` and `popup/`, not the full
 * Chrome API surface. The full `@types/chrome` package is an option for
 * the future if we type-check more of the package or need additional
 * API surface that this file doesn't cover.
 *
 * Note: `debugger` is a reserved word in TypeScript so we cannot declare
 * a `namespace chrome.debugger`. Instead, `chrome` is declared as a
 * top-level `const` whose type is an interface — that shape can include
 * a `debugger` property because object literal property names may use
 * reserved words.
 */

interface ChromeStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

interface ChromeStorageChange {
  newValue?: unknown;
  oldValue?: unknown;
}

type ChromeStorageAreaName = 'local' | 'sync' | 'managed' | 'session';

interface ChromeStorageChangedEvent {
  addListener(
    listener: (
      changes: Record<string, ChromeStorageChange>,
      areaName: ChromeStorageAreaName,
    ) => void,
  ): void;
  removeListener(
    listener: (
      changes: Record<string, ChromeStorageChange>,
      areaName: ChromeStorageAreaName,
    ) => void,
  ): void;
}

interface ChromeStorageNamespace {
  local: ChromeStorageArea;
  sync: ChromeStorageArea;
  session: ChromeStorageArea;
  onChanged: ChromeStorageChangedEvent;
}

interface ChromeIdentityWebAuthFlowDetails {
  url: string;
  interactive?: boolean;
}

interface ChromeIdentityNamespace {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: ChromeIdentityWebAuthFlowDetails): Promise<string | undefined>;
}

interface ChromeRuntimeLastError {
  message?: string;
}

interface ChromeRuntimePortMessageEvent {
  addListener(listener: (message: unknown) => void): void;
  removeListener(listener: (message: unknown) => void): void;
}

interface ChromeRuntimePortDisconnectEvent {
  addListener(listener: (port: ChromeRuntimePort) => void): void;
  removeListener(listener: (port: ChromeRuntimePort) => void): void;
}

interface ChromeRuntimePort {
  name: string;
  onMessage: ChromeRuntimePortMessageEvent;
  onDisconnect: ChromeRuntimePortDisconnectEvent;
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface ChromeRuntimeMessageSender {
  tab?: ChromeTab;
  frameId?: number;
  id?: string;
  url?: string;
  tlsChannelId?: string;
  origin?: string;
}

type ChromeRuntimeMessageListener = (
  message: Record<string, unknown> & { type?: string },
  sender: ChromeRuntimeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

interface ChromeRuntimeOnMessageEvent {
  addListener(listener: ChromeRuntimeMessageListener): void;
  removeListener(listener: ChromeRuntimeMessageListener): void;
}

interface ChromeRuntimeManifest {
  version: string;
  [key: string]: unknown;
}

interface ChromeRuntimeNamespace {
  readonly lastError: ChromeRuntimeLastError | undefined;
  connectNative(application: string): ChromeRuntimePort;
  onMessage: ChromeRuntimeOnMessageEvent;
  // Generic over the response type so callers can narrow the callback
  // argument without casting. Matches the de-facto shape used by the
  // official @types/chrome package.
  sendMessage<TResponse = unknown>(
    message: unknown,
    responseCallback?: (response: TResponse) => void,
  ): void;
  getManifest(): ChromeRuntimeManifest;
}

interface ChromeTab {
  id?: number;
  windowId?: number;
  url?: string;
  active?: boolean;
  title?: string;
  index?: number;
}

interface ChromeTabsQueryInfo {
  active?: boolean;
  lastFocusedWindow?: boolean;
  url?: string | string[];
  windowId?: number;
  currentWindow?: boolean;
  [key: string]: unknown;
}

interface ChromeTabsCreateProperties {
  url?: string;
  active?: boolean;
  windowId?: number;
  index?: number;
}

interface ChromeTabsUpdateProperties {
  url?: string;
  active?: boolean;
  [key: string]: unknown;
}

interface ChromeTabsCaptureVisibleTabOptions {
  format?: 'jpeg' | 'png';
  quality?: number;
}

interface ChromeTabsNamespace {
  query(queryInfo: ChromeTabsQueryInfo): Promise<ChromeTab[]>;
  get(tabId: number): Promise<ChromeTab>;
  create(createProperties: ChromeTabsCreateProperties): Promise<ChromeTab>;
  update(tabId: number, updateProperties: ChromeTabsUpdateProperties): Promise<ChromeTab | undefined>;
  captureVisibleTab(
    windowId: number,
    options?: ChromeTabsCaptureVisibleTabOptions,
  ): Promise<string>;
}

interface ChromeWindowsNamespace {
  readonly WINDOW_ID_CURRENT: number;
  readonly WINDOW_ID_NONE: number;
}

interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly?: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  session?: boolean;
  expirationDate?: number;
  storeId?: string;
}

interface ChromeCookiesGetAllDetails {
  domain?: string;
  name?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
  storeId?: string;
  url?: string;
}

interface ChromeCookiesSetDetails {
  url: string;
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
  storeId?: string;
}

interface ChromeCookiesNamespace {
  getAll(details: ChromeCookiesGetAllDetails): Promise<ChromeCookie[]>;
  set(details: ChromeCookiesSetDetails): Promise<ChromeCookie | null>;
}

interface ChromeDebuggerDebuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
}

/**
 * Chrome 125+ flat-session target. Extends `Debuggee` with an optional
 * `sessionId` that addresses a child flat session created via
 * `Target.attachToTarget` with `flatten: true`. The `chrome.debugger`
 * sendCommand API and the `onEvent` `source` argument both accept this
 * shape so child sessions can be routed via the target argument rather
 * than smuggled into command params.
 */
interface ChromeDebuggerSession extends ChromeDebuggerDebuggee {
  sessionId?: string;
}

interface ChromeDebuggerOnEventEvent {
  addListener(
    callback: (
      source: ChromeDebuggerSession,
      method: string,
      params?: unknown,
    ) => void,
  ): void;
  removeListener(
    callback: (
      source: ChromeDebuggerSession,
      method: string,
      params?: unknown,
    ) => void,
  ): void;
}

interface ChromeDebuggerOnDetachEvent {
  addListener(
    callback: (source: ChromeDebuggerDebuggee, reason: string) => void,
  ): void;
  removeListener(
    callback: (source: ChromeDebuggerDebuggee, reason: string) => void,
  ): void;
}

interface ChromeDebuggerNamespace {
  // Promise-style (modern MV3 usage — used by worker.ts).
  attach(target: ChromeDebuggerDebuggee, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerDebuggee): Promise<void>;
  sendCommand(
    target: ChromeDebuggerSession,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
  // Callback-style overloads (still supported in MV3). cdp-proxy.ts uses the
  // callback form so it can thread errors through `chrome.runtime.lastError`
  // on a per-call basis, which is what makes the injected `ChromeDebuggerApi`
  // testable against a mock.
  attach(
    target: ChromeDebuggerDebuggee,
    requiredVersion: string,
    callback: () => void,
  ): void;
  detach(target: ChromeDebuggerDebuggee, callback: () => void): void;
  sendCommand(
    target: ChromeDebuggerSession,
    method: string,
    commandParams: Record<string, unknown> | undefined,
    callback: (result?: unknown) => void,
  ): void;
  onEvent: ChromeDebuggerOnEventEvent;
  onDetach: ChromeDebuggerOnDetachEvent;
}

interface ChromeGlobal {
  storage: ChromeStorageNamespace;
  identity: ChromeIdentityNamespace;
  runtime: ChromeRuntimeNamespace;
  tabs: ChromeTabsNamespace;
  windows: ChromeWindowsNamespace;
  cookies: ChromeCookiesNamespace;
  debugger: ChromeDebuggerNamespace;
}

declare const chrome: ChromeGlobal;

/**
 * Minimal ambient declaration for `process.env` so bundler-injected
 * constants like `process.env.VELLUM_ENVIRONMENT` can be referenced
 * without pulling in the full `@types/node` package.
 *
 * At bundle time `bun build --define` replaces these references with
 * string literals. In test contexts (bun:test) the real Node/Bun
 * `process` global satisfies this shape.
 */
declare const process: {
  env: Record<string, string | undefined>;
};
